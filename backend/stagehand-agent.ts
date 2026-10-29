import type { ProviderRegistry } from "./provider-registry";
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
  | "agent_page_not_ready";

export type ProviderCauseKind =
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

const MAX_CAUSE_DEPTH = 3;
const MAX_STRUCTURE_DEPTH = 10;
const MAX_PROVIDER_JSON_LENGTH = 100_000;
const MAX_RETRY_DELAY_SECONDS = 99_999_999;
const NETWORK_ERROR_CODES = ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN"];
const QUOTA_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,100}$/;
const STATUS_KEYS = new Set(["status", "statuscode", "httpstatus"]);
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
  "name",
  "message",
  "responseBody",
  "data",
  "response",
] as const;
const KNOWN_PROVIDER_KEY_SET = new Set(
  KNOWN_PROVIDER_KEYS.map((key) => normalizeProviderKey(key)),
);

type ProviderSignals = {
  httpStatus: number | null;
  retryDelaySeconds: number | null;
  quotaId: string | null;
  hasQuota: boolean;
  hasSchema: boolean;
  hasNetworkCode: boolean;
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

  if (RETRY_DELAY_KEYS.has(normalizedKey) && signals.retryDelaySeconds === null) {
    const seconds = parseRetryDelay(text);
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

function inspectProviderStructure(
  value: unknown,
  key: string | null,
  depth: number,
  seen: Set<object>,
  signals: ProviderSignals,
): void {
  if (depth > MAX_STRUCTURE_DEPTH) {
    return;
  }

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    inspectProviderScalar(value, key, signals);
    if (typeof value === "string") {
      const parsed = parseProviderJson(value);
      if (parsed !== undefined) {
        inspectProviderStructure(parsed, key, depth + 1, seen, signals);
      }
    }
    return;
  }

  if (value === null || typeof value !== "object" || seen.has(value)) {
    return;
  }
  seen.add(value);

  for (const knownKey of KNOWN_PROVIDER_KEYS) {
    inspectProviderStructure(
      readProviderProperty(value, knownKey),
      knownKey,
      depth + 1,
      seen,
      signals,
    );
  }

  let entries: [string, unknown][];
  try {
    entries = Object.entries(value);
  } catch {
    return;
  }

  for (const [entryKey, entryValue] of entries) {
    const normalizedKey = normalizeProviderKey(entryKey);
    if (
      UNSCANNED_PROVIDER_KEYS.has(normalizedKey) ||
      KNOWN_PROVIDER_KEY_SET.has(normalizedKey)
    ) {
      continue;
    }
    inspectProviderStructure(entryValue, entryKey, depth + 1, seen, signals);
  }
}

function collectProviderSignals(error: unknown): ProviderSignals {
  const signals = emptyProviderSignals();
  let current: unknown = error;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    inspectProviderStructure(current, null, 0, new Set<object>(), signals);
    if (current === null || typeof current !== "object") {
      break;
    }
    current = readProviderProperty(current, "cause");
  }

  return signals;
}

function resolveProviderKind(signals: ProviderSignals): ProviderCauseKind {
  if (signals.hasNetworkCode) {
    return "network";
  }
  if (signals.httpStatus === 401 || signals.httpStatus === 403) {
    return "auth_or_key";
  }
  if (signals.httpStatus === 429) {
    return signals.hasQuota ? "quota_exhausted" : "rate_limited";
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
};

export class AgentError extends Error {
  readonly code: AgentErrorCode;
  readonly operation: AgentOperation | null;
  readonly reloaded: boolean;
  readonly providerCause: ProviderCause | null;

  constructor(
    code: AgentErrorCode,
    operation: AgentOperation | null = null,
    reloaded = false,
    providerCause: ProviderCause | null = null,
  ) {
    super(AGENT_ERROR_MESSAGES[code]);
    this.name = "AgentError";
    this.code = code;
    this.operation = operation;
    this.reloaded = reloaded;
    this.providerCause = providerCause;
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
  private closePromise: Promise<void> | null = null;

  constructor(runtime: StagehandRuntime) {
    this.runtime = runtime;
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

    return new AgentError(failureCode, operation, false, classifyProviderCause(error));
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

  const model = adapter.createModelConfig({
    model: active.model,
    apiKey: active.apiKey,
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
    return new StagehandAgentImpl(runtime);
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
