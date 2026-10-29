import type { ProviderRegistry } from "./provider-registry";
import type { ProviderKeyFailureKind } from "./provider-key-pool";
import type { ProviderService } from "./provider-service";
import type { CdpCredentials } from "./browser-launcher";
import {
  createStagehandRuntime,
  type AgentActSummary,
  type AgentAction,
  type StagehandExtractSchema,
  type StagehandRuntime,
  type StagehandRuntimeFactory,
} from "./stagehand-runtime";

const INIT_TIMEOUT_MS = 60_000;
const SNAPSHOT_TIMEOUT_MS = 20_000;
const OPERATION_TIMEOUT_MS = 60_000;
const REPLAY_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 5_000;
const PAGE_PROBE_TIMEOUT_MS = 3_000;
const PAGE_RELOAD_TIMEOUT_MS = 30_000;
const PAGE_PREPARE_TIMEOUT_MS = 40_000;

export type AgentOperation =
  | "init"
  | "snapshot"
  | "observe"
  | "act"
  | "extract"
  | "prepare";

export type AgentErrorCode =
  | "agent_provider_not_configured"
  | "agent_provider_unsupported"
  | "agent_init_timeout"
  | "agent_attach_failed"
  | "agent_closed"
  | "agent_timeout"
  | "agent_snapshot_failed"
  | "agent_observe_failed"
  | "agent_act_failed"
  | "agent_extract_failed"
  | "agent_page_not_ready"
  | "agent_provider_keys_cooldown"
  | "agent_provider_keys_rejected";

export type ProviderCauseKind =
  | "credits_exhausted"
  | "quota_exhausted"
  | "rate_limited"
  | "auth_or_key"
  | "upstream_unavailable"
  | "schema_rejected"
  | "network"
  | "timeout"
  | "unknown";

export type ProviderCause = {
  readonly kind: ProviderCauseKind;
  readonly httpStatus: number | null;
  readonly retryDelaySeconds: number | null;
  readonly quotaId: string | null;
};

const MAX_CAUSE_DEPTH = 6;
const MAX_CAUSE_NODES = 50;
const MAX_PROVIDER_JSON_LENGTH = 100_000;
const MAX_RETRY_DELAY_SECONDS = 99_999_999;
const NETWORK_ERROR_CODES = ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN"];
const QUOTA_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,100}$/;
const RETRY_DELAY_TEXT_PATTERN =
  /\bretry(?:\s+(?:in|after)|delay)\s*[:=]?\s*(\d{1,9})\s*s\b/i;
const STATUS_KEYS = new Set(["status", "statuscode", "httpstatus"]);
const CAUSE_LINK_KEYS = [
  "cause",
  "lastError",
  "errors",
  "error",
  "originalError",
  "details",
  "response",
  "data",
  "responseBody",
] as const;
const RETRY_DELAY_KEYS = new Set([
  "retrydelay",
  "retryafter",
  "retrydelayseconds",
  "retryafterseconds",
]);
const UNSCANNED_PROVIDER_KEYS = new Set([
  "cause",
  "content",
  "messages",
  "prompt",
  "requestbody",
  "requestbodyvalues",
  "requestheaders",
  "stack",
  "text",
  "url",
]);
const KNOWN_PROVIDER_KEYS = [
  "status",
  "statusCode",
  "httpStatus",
  "code",
  "errno",
  "retryDelay",
  "retryAfter",
  "retryDelaySeconds",
  "retryAfterSeconds",
  "quotaId",
  "limitSource",
  "name",
  "message",
  "responseBody",
  "data",
  "response",
] as const;

type ProviderSignals = {
  httpStatus: number | null;
  retryDelaySeconds: number | null;
  quotaId: string | null;
  hasQuota: boolean;
  hasSchema: boolean;
  hasNetworkCode: boolean;
  hasOpenRouterLimit: boolean;
};

function normalizeProviderKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, "");
}

function readProviderProperty(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function emptyProviderSignals(): ProviderSignals {
  return {
    httpStatus: null,
    retryDelaySeconds: null,
    quotaId: null,
    hasQuota: false,
    hasSchema: false,
    hasNetworkCode: false,
    hasOpenRouterLimit: false,
  };
}

function parseRetryDelay(value: string): number | null {
  const suffixed = /^(\d{1,9})(?:\.\d+)?s$/.exec(value);
  const plain = /^(\d{1,9})$/.exec(value);
  const digits = suffixed?.[1] ?? plain?.[1];
  if (digits === undefined) {
    return null;
  }

  const seconds = Number.parseInt(digits, 10);
  return Number.isSafeInteger(seconds) ? seconds : null;
}

function parseRetryDelayText(value: string): number | null {
  const digits = RETRY_DELAY_TEXT_PATTERN.exec(value)?.[1];
  if (digits === undefined) {
    return null;
  }

  const seconds = Number.parseInt(digits, 10);
  return Number.isSafeInteger(seconds) ? seconds : null;
}

function inspectProviderScalar(
  value: string | number | boolean,
  key: string | null,
  signals: ProviderSignals,
): void {
  const normalizedKey = key === null ? "" : normalizeProviderKey(key);

  if (typeof value === "number") {
    if (
      STATUS_KEYS.has(normalizedKey) &&
      Number.isInteger(value) &&
      value >= 100 &&
      value <= 599 &&
      signals.httpStatus === null
    ) {
      signals.httpStatus = value;
      return;
    }

    if (
      RETRY_DELAY_KEYS.has(normalizedKey) &&
      value >= 0 &&
      value <= MAX_RETRY_DELAY_SECONDS &&
      signals.retryDelaySeconds === null
    ) {
      signals.retryDelaySeconds = Math.round(value);
    }
    return;
  }

  if (typeof value !== "string") {
    return;
  }

  const text = value.trim();

  if (normalizedKey === "quotaid") {
    signals.hasQuota = true;
    if (QUOTA_ID_PATTERN.test(text) && signals.quotaId === null) {
      signals.quotaId = text;
    }
  }

  if (
    normalizedKey === "limitsource" &&
    text.toLowerCase().startsWith("openrouter_")
  ) {
    signals.hasOpenRouterLimit = true;
  }

  if (RETRY_DELAY_KEYS.has(normalizedKey) && signals.retryDelaySeconds === null) {
    const seconds = parseRetryDelay(text);
    if (seconds !== null) {
      signals.retryDelaySeconds = seconds;
    }
  }

  if (signals.retryDelaySeconds === null) {
    const seconds = parseRetryDelayText(text);
    if (seconds !== null) {
      signals.retryDelaySeconds = seconds;
    }
  }

  const upperText = text.toUpperCase();
  if (upperText.includes("RESOURCE_EXHAUSTED") || upperText.includes("QUOTA")) {
    signals.hasQuota = true;
  }

  if (/response_?schema|\bschemas?\b/i.test(text)) {
    signals.hasSchema = true;
  }

  if (NETWORK_ERROR_CODES.some((code) => text.includes(code))) {
    signals.hasNetworkCode = true;
  }
}

function parseProviderJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length < 2 || trimmed.length > MAX_PROVIDER_JSON_LENGTH) {
    return undefined;
  }

  const isObject = trimmed.startsWith("{") && trimmed.endsWith("}");
  const isArray = trimmed.startsWith("[") && trimmed.endsWith("]");
  if (!isObject && !isArray) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

type ProviderNode = {
  readonly value: unknown;
  readonly key: string | null;
  readonly depth: number;
};

function enqueueProviderNode(
  queue: ProviderNode[],
  value: unknown,
  key: string | null,
  depth: number,
): void {
  if (
    value === null ||
    value === undefined ||
    value === "" ||
    depth > MAX_CAUSE_DEPTH ||
    queue.length >= MAX_CAUSE_NODES
  ) {
    return;
  }
  queue.push({ value, key, depth });
}

function collectProviderSignals(error: unknown): ProviderSignals {
  const signals = emptyProviderSignals();
  const seen = new Set<object>();
  const queue: ProviderNode[] = [{ value: error, key: null, depth: 0 }];
  let visited = 0;

  while (queue.length > 0 && visited < MAX_CAUSE_NODES) {
    const node = queue.shift();
    if (node === undefined) {
      break;
    }
    visited += 1;

    const { value, key, depth } = node;
    if (typeof value === "string") {
      inspectProviderScalar(value, key, signals);
      const parsed = parseProviderJson(value);
      if (parsed !== undefined) {
        enqueueProviderNode(queue, parsed, key, depth);
      }
      continue;
    }

    if (typeof value === "number" || typeof value === "boolean") {
      inspectProviderScalar(value, key, signals);
      continue;
    }

    if (value === null || typeof value !== "object" || seen.has(value)) {
      continue;
    }
    seen.add(value);

    if (Array.isArray(value)) {
      for (const entry of value) {
        enqueueProviderNode(queue, entry, key, depth);
      }
      continue;
    }

    const handledKeys = new Set<string>();
    for (const linkKey of CAUSE_LINK_KEYS) {
      handledKeys.add(linkKey);
      enqueueProviderNode(
        queue,
        readProviderProperty(value, linkKey),
        linkKey,
        depth + 1,
      );
    }

    for (const knownKey of KNOWN_PROVIDER_KEYS) {
      if (handledKeys.has(knownKey)) {
        continue;
      }
      handledKeys.add(knownKey);
      enqueueProviderNode(
        queue,
        readProviderProperty(value, knownKey),
        knownKey,
        depth,
      );
    }

    let examinedEntries = 0;
    try {
      for (const entryKey in value) {
        if (
          examinedEntries >= MAX_CAUSE_NODES ||
          queue.length >= MAX_CAUSE_NODES
        ) {
          break;
        }
        examinedEntries += 1;
        if (!Object.prototype.hasOwnProperty.call(value, entryKey)) {
          continue;
        }
        const normalizedKey = normalizeProviderKey(entryKey);
        if (
          handledKeys.has(entryKey) ||
          UNSCANNED_PROVIDER_KEYS.has(normalizedKey)
        ) {
          continue;
        }
        const entryValue = readProviderProperty(value, entryKey);
        const entryDepth =
          typeof entryValue === "object" && entryValue !== null
            ? depth + 1
            : depth;
        enqueueProviderNode(queue, entryValue, entryKey, entryDepth);
      }
    } catch {
      continue;
    }
  }

  return signals;
}

function resolveProviderKind(signals: ProviderSignals): ProviderCauseKind {
  if (signals.httpStatus === 402) {
    return "credits_exhausted";
  }
  if (signals.httpStatus === 403) {
    return signals.hasOpenRouterLimit ? "credits_exhausted" : "auth_or_key";
  }
  if (signals.httpStatus === 429) {
    return signals.hasQuota ? "quota_exhausted" : "rate_limited";
  }
  if (signals.httpStatus === 401) {
    return "auth_or_key";
  }
  if (
    signals.httpStatus !== null &&
    signals.httpStatus >= 500 &&
    signals.httpStatus <= 599
  ) {
    return "upstream_unavailable";
  }
  if (signals.httpStatus === 400 && signals.hasSchema) {
    return "schema_rejected";
  }
  if (signals.httpStatus === null && signals.hasQuota) {
    return "quota_exhausted";
  }
  if (signals.hasNetworkCode) {
    return "network";
  }
  return "unknown";
}

function classifyProviderCause(error: unknown): ProviderCause {
  const signals = collectProviderSignals(error);
  return {
    kind: resolveProviderKind(signals),
    httpStatus: signals.httpStatus,
    retryDelaySeconds: signals.retryDelaySeconds,
    quotaId: signals.quotaId,
  };
}

const AGENT_ERROR_MESSAGES: Record<AgentErrorCode, string> = {
  agent_provider_not_configured: "Agent provider is not configured.",
  agent_provider_unsupported: "Agent provider is not supported.",
  agent_init_timeout: "Agent initialization timed out.",
  agent_attach_failed: "Agent failed to attach to the browser.",
  agent_closed: "Agent adapter is closed.",
  agent_timeout: "Agent operation timed out.",
  agent_snapshot_failed: "Agent snapshot failed.",
  agent_observe_failed: "Agent observe failed.",
  agent_act_failed: "Agent act failed.",
  agent_extract_failed: "Agent extract failed.",
  agent_page_not_ready: "Agent page is not ready.",
  agent_provider_keys_cooldown: "All provider keys are cooling down.",
  agent_provider_keys_rejected: "All provider keys were rejected.",
};

export class AgentError extends Error {
  readonly code: AgentErrorCode;
  readonly operation: AgentOperation | null;
  readonly reloaded: boolean;
  readonly providerCause: ProviderCause | null;
  readonly retryAfterSeconds: number | null;

  constructor(
    code: AgentErrorCode,
    operation: AgentOperation | null = null,
    reloaded = false,
    providerCause: ProviderCause | null = null,
    retryAfterSeconds: number | null = null,
  ) {
    super(AGENT_ERROR_MESSAGES[code]);
    this.name = "AgentError";
    this.code = code;
    this.operation = operation;
    this.reloaded = reloaded;
    this.providerCause = providerCause;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export type StagehandAgent = {
  snapshot(options?: {
    readonly timeoutMs?: number;
  }): Promise<{ readonly formattedTree: string }>;
  observe(instruction: string): Promise<readonly AgentAction[]>;
  act(input: string | AgentAction): Promise<AgentActSummary>;
  extractText(
    instruction: string,
    options?: { readonly screenshot?: boolean },
  ): Promise<unknown>;
  extractStructured(
    instruction: string,
    schema: StagehandExtractSchema,
  ): Promise<unknown>;
  preparePage(): Promise<{ readonly reloaded: boolean }>;
  close(): Promise<void>;
};

export type CreateStagehandAgentOptions = {
  readonly credentials: CdpCredentials;
  readonly providers: ProviderService;
  readonly registry: ProviderRegistry;
  readonly createRuntime?: StagehandRuntimeFactory;
};

class TimeoutSignal extends Error {}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new TimeoutSignal());
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });
}

function runOperation<T>(operation: () => Promise<T>): Promise<T> {
  return Promise.resolve().then(operation);
}

class StagehandAgentImpl implements StagehandAgent {
  private readonly runtime: StagehandRuntime;
  private readonly onProviderFailure: (cause: ProviderCause) => void;
  private closePromise: Promise<void> | null = null;

  constructor(
    runtime: StagehandRuntime,
    onProviderFailure: (cause: ProviderCause) => void = () => undefined,
  ) {
    this.runtime = runtime;
    this.onProviderFailure = onProviderFailure;
  }

  async snapshot(options?: {
    readonly timeoutMs?: number;
  }): Promise<{ readonly formattedTree: string }> {
    this.ensureOpen();
    const timeoutMs = options?.timeoutMs ?? SNAPSHOT_TIMEOUT_MS;

    try {
      const tree = await withTimeout(
        runOperation(() => this.runtime.snapshot(timeoutMs)),
        timeoutMs,
      );
      if (tree.trim().length === 0) {
        throw new AgentError("agent_snapshot_failed", "snapshot");
      }
      return { formattedTree: tree };
    } catch (error) {
      throw this.mapFailure(error, "snapshot", "agent_snapshot_failed");
    }
  }

  async observe(instruction: string): Promise<readonly AgentAction[]> {
    this.ensureOpen();

    try {
      return await withTimeout(
        runOperation(() => this.runtime.observe(instruction, OPERATION_TIMEOUT_MS)),
        OPERATION_TIMEOUT_MS,
      );
    } catch (error) {
      throw this.mapFailure(error, "observe", "agent_observe_failed");
    }
  }

  async act(input: string | AgentAction): Promise<AgentActSummary> {
    this.ensureOpen();
    const timeoutMs = typeof input === "string" ? OPERATION_TIMEOUT_MS : REPLAY_TIMEOUT_MS;

    try {
      return await withTimeout(
        runOperation(() => this.runtime.act(input, timeoutMs)),
        timeoutMs,
      );
    } catch (error) {
      throw this.mapFailure(error, "act", "agent_act_failed");
    }
  }

  async extractText(
    instruction: string,
    options?: { readonly screenshot?: boolean },
  ): Promise<unknown> {
    this.ensureOpen();

    try {
      return await withTimeout(
        runOperation(() =>
          this.runtime.extract(instruction, {
            timeoutMs: OPERATION_TIMEOUT_MS,
            screenshot: options?.screenshot === true,
          }),
        ),
        OPERATION_TIMEOUT_MS,
      );
    } catch (error) {
      throw this.mapFailure(error, "extract", "agent_extract_failed");
    }
  }

  async extractStructured(
    instruction: string,
    schema: StagehandExtractSchema,
  ): Promise<unknown> {
    this.ensureOpen();

    try {
      return await withTimeout(
        runOperation(() =>
          this.runtime.extractStructured(instruction, schema, {
            timeoutMs: OPERATION_TIMEOUT_MS,
          }),
        ),
        OPERATION_TIMEOUT_MS,
      );
    } catch (error) {
      throw this.mapFailure(error, "extract", "agent_extract_failed");
    }
  }

  async preparePage(): Promise<{ readonly reloaded: boolean }> {
    this.ensureOpen();

    try {
      const preparation = await withTimeout(
        runOperation(() =>
          this.runtime.preparePage({
            probeTimeoutMs: PAGE_PROBE_TIMEOUT_MS,
            reloadTimeoutMs: PAGE_RELOAD_TIMEOUT_MS,
          }),
        ),
        PAGE_PREPARE_TIMEOUT_MS,
      );

      if (!preparation.ready) {
        throw new AgentError(
          "agent_page_not_ready",
          "prepare",
          preparation.reloaded,
        );
      }

      return { reloaded: preparation.reloaded };
    } catch (error) {
      if (error instanceof AgentError) {
        throw error;
      }

      throw new AgentError("agent_page_not_ready", "prepare");
    }
  }

  close(): Promise<void> {
    this.closePromise ??= this.runClose();
    return this.closePromise;
  }

  private async runClose(): Promise<void> {
    await withTimeout(
      runOperation(() => this.runtime.close()),
      CLOSE_TIMEOUT_MS,
    ).catch(() => undefined);
  }

  private ensureOpen(): void {
    if (this.closePromise !== null) {
      throw new AgentError("agent_closed");
    }
  }

  private mapFailure(
    error: unknown,
    operation: AgentOperation,
    failureCode: AgentErrorCode,
  ): AgentError {
    if (error instanceof AgentError) {
      return error;
    }

    if (error instanceof TimeoutSignal) {
      return new AgentError("agent_timeout", operation, false, {
        kind: "timeout",
        httpStatus: null,
        retryDelaySeconds: null,
        quotaId: null,
      });
    }

    const providerCause = classifyProviderCause(error);
    this.onProviderFailure(providerCause);
    return new AgentError(failureCode, operation, false, providerCause);
  }
}

function toKeyFailureKind(
  kind: ProviderCauseKind,
): ProviderKeyFailureKind | null {
  switch (kind) {
    case "quota_exhausted":
    case "rate_limited":
    case "credits_exhausted":
    case "auth_or_key":
      return kind;
    default:
      return null;
  }
}

export async function createStagehandAgent(
  options: CreateStagehandAgentOptions,
): Promise<StagehandAgent> {
  const active = options.providers.getActive();
  if (active === null) {
    throw new AgentError("agent_provider_not_configured");
  }

  const adapter = options.registry.get(active.provider);
  if (adapter === null) {
    throw new AgentError("agent_provider_unsupported");
  }

  const selection = options.providers.acquireKey(active.provider);
  if (selection.status === "cooldown") {
    throw new AgentError(
      "agent_provider_keys_cooldown",
      null,
      false,
      null,
      selection.retryAfterSeconds,
    );
  }
  if (selection.status === "rejected") {
    throw new AgentError("agent_provider_keys_rejected");
  }

  const model = adapter.createModelConfig({
    model: active.model,
    apiKey: selection.apiKey,
  });
  const createRuntime = options.createRuntime ?? createStagehandRuntime;
  const runtimePromise = runOperation(() =>
    createRuntime({
      credentials: options.credentials,
      model,
    }),
  );

  try {
    const runtime = await withTimeout(runtimePromise, INIT_TIMEOUT_MS);
    return new StagehandAgentImpl(runtime, (cause) => {
      const kind = toKeyFailureKind(cause.kind);
      if (kind !== null) {
        options.providers.markKeyFailure(
          active.provider,
          selection.keyId,
          kind,
          cause.retryDelaySeconds,
        );
      }
    });
  } catch (error) {
    void runtimePromise
      .then((lateRuntime) =>
        withTimeout(runOperation(() => lateRuntime.close()), CLOSE_TIMEOUT_MS),
      )
      .catch(() => undefined);
    if (error instanceof TimeoutSignal) {
      throw new AgentError("agent_init_timeout", "init");
    }
    throw new AgentError("agent_attach_failed", "init");
  }
}
