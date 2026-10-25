import type { ProviderRegistry } from "./provider-registry";
import type { ProviderService } from "./provider-service";
import {
  createStagehandRuntime,
  type AgentActSummary,
  type AgentAction,
  type StagehandRuntime,
  type StagehandRuntimeFactory,
} from "./stagehand-runtime";

const INIT_TIMEOUT_MS = 60_000;
const SNAPSHOT_TIMEOUT_MS = 20_000;
const OPERATION_TIMEOUT_MS = 60_000;
const REPLAY_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 5_000;

export type AgentOperation = "init" | "snapshot" | "observe" | "act" | "extract";

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
  | "agent_extract_failed";

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
};

export class AgentError extends Error {
  readonly code: AgentErrorCode;
  readonly operation: AgentOperation | null;

  constructor(code: AgentErrorCode, operation: AgentOperation | null = null) {
    super(AGENT_ERROR_MESSAGES[code]);
    this.name = "AgentError";
    this.code = code;
    this.operation = operation;
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
  close(): Promise<void>;
};

export type CreateStagehandAgentOptions = {
  readonly cdpUrl: string;
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
      return new AgentError("agent_timeout", operation);
    }

    return new AgentError(failureCode, operation);
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

  const modelName = adapter.toStagehandModelName(active.model);
  const createRuntime = options.createRuntime ?? createStagehandRuntime;
  const runtimePromise = runOperation(() =>
    createRuntime({
      cdpUrl: options.cdpUrl,
      modelName,
      apiKey: active.apiKey,
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
