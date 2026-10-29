import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  AgentError,
  createStagehandAgent,
  type ProviderCause,
  type ProviderCauseKind,
} from "./stagehand-agent";
import type { ProviderConfig } from "../shared/provider";
import type { ProviderAdapter, ProviderRegistry } from "./provider-registry";
import { providerKeyId } from "./provider-key-pool";
import type { ProviderService } from "./provider-service";
import type { StoredProviderConfig } from "./provider-store";
import { createOpenRouterGenerate } from "./openrouter-provider";
import type {
  AgentAction,
  ClientModelGenerate,
  StagehandExtractSchema,
  StagehandRuntime,
  StagehandRuntimeFactory,
  StagehandRuntimeOptions,
} from "./stagehand-runtime";

const FAKE_CREDENTIALS = {
  gatewayUrl: "http://127.0.0.1:59876",
  bearerToken: "fake-agent-bearer",
  extensionCdpUrl:
    "ws://127.0.0.1:59876/devtools/browser/test?token=fake-agent-capability",
};
const FAKE_API_KEY = "fake-agent-key";
const UPDATED_AT = "2026-10-25T10:00:00.000Z";

function activeConfig(overrides: Partial<StoredProviderConfig> = {}): StoredProviderConfig {
  return {
    provider: "gemini",
    model: "gemini-2.5-flash",
    apiKeys: [FAKE_API_KEY],
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

function createProviderService(
  getActive: () => StoredProviderConfig | null,
  overrides: {
    readonly acquireKey?: ProviderService["acquireKey"];
    readonly markKeyFailure?: ProviderService["markKeyFailure"];
  } = {},
): ProviderService {
  return {
    getConfig(): ProviderConfig {
      const active = getActive();
      return active === null
        ? {
            provider: null,
            model: null,
            configured: false,
            updatedAt: null,
            available: [],
            keys: [],
          }
        : {
            provider: active.provider,
            model: active.model,
            configured: true,
            updatedAt: active.updatedAt,
            available: [active.provider],
            keys: active.apiKeys.map((apiKey) => ({
              id: providerKeyId(apiKey),
              status: "ready",
              cooldownUntil: null,
              lastUsedAt: null,
            })),
          };
    },
    getActive,
    acquireKey(provider) {
      if (overrides.acquireKey !== undefined) {
        return overrides.acquireKey(provider);
      }
      const active = getActive();
      const apiKey = active?.apiKeys[0];
      if (apiKey === undefined) {
        return { status: "rejected" };
      }
      return { status: "selected", keyId: providerKeyId(apiKey), apiKey };
    },
    markKeyFailure(provider, keyId, kind, retryDelaySeconds) {
      overrides.markKeyFailure?.(provider, keyId, kind, retryDelaySeconds);
    },
    async setConfig() {
      throw new Error("Unused provider service write.");
    },
  };
}

const geminiAdapter: ProviderAdapter = {
  id: "gemini",
  createModelConfig: ({ model, apiKey }) => ({
    kind: "native",
    modelName: `google/${model}`,
    apiKey,
  }),
  async validateCredentials() {
    return { ok: true };
  },
};

const openRouterAdapter: ProviderAdapter = {
  id: "openrouter",
  createModelConfig: ({ model, apiKey }) => ({
    kind: "client",
    generate: createOpenRouterGenerate({ model, apiKey }),
  }),
  async validateCredentials() {
    return { ok: true };
  },
};

function createRegistry(adapter: ProviderAdapter | null): ProviderRegistry {
  return {
    get() {
      return adapter;
    },
  };
}

function createRuntime(overrides: Partial<StagehandRuntime> = {}): StagehandRuntime {
  return {
    async snapshot() {
      return "tree";
    },
    async observe() {
      return [];
    },
    async act() {
      return { success: true, actionCount: 1 };
    },
    async extract() {
      return { extraction: "text" };
    },
    async extractStructured() {
      return { stepOk: true };
    },
    async preparePage() {
      return { ready: true, reloaded: false };
    },
    async close() {
      return undefined;
    },
    ...overrides,
  };
}

const quotaResponseBody = JSON.stringify({
  error: {
    code: 429,
    message: "You exceeded your current quota.",
    status: "RESOURCE_EXHAUSTED",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        violations: [
          {
            quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
          },
        ],
      },
      {
        "@type": "type.googleapis.com/google.rpc.RetryInfo",
        retryDelay: "20410s",
      },
    ],
  },
});

function providerFailure(input: {
  readonly message?: string;
  readonly name?: string;
  readonly statusCode?: number;
  readonly responseBody?: string;
  readonly responseHeaders?: Record<string, string>;
  readonly code?: string;
  readonly cause?: unknown;
}): Error {
  const error = new Error(input.message ?? "provider failure");
  error.name = input.name ?? "AI_APICallError";
  return Object.assign(error, {
    ...(input.statusCode === undefined ? {} : { statusCode: input.statusCode }),
    ...(input.responseBody === undefined ? {} : { responseBody: input.responseBody }),
    ...(input.responseHeaders === undefined
      ? {}
      : { responseHeaders: input.responseHeaders }),
    ...(input.code === undefined ? {} : { code: input.code }),
    ...(input.cause === undefined ? {} : { cause: input.cause }),
  });
}

function wrappedFailure(
  fields: Record<string, unknown>,
  message = "Failed after 3 attempts.",
): Error {
  const error = new Error(message);
  error.name = "StagehandError";
  for (const [key, value] of Object.entries(fields)) {
    Object.defineProperty(error, key, {
      value,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  return error;
}

type AgentFixture = {
  readonly createAgent: () => ReturnType<typeof createStagehandAgent>;
  readonly runtimeOptions: StagehandRuntimeOptions[];
};

function createFixture(
  options: {
    readonly getActive?: () => StoredProviderConfig | null;
    readonly adapter?: ProviderAdapter | null;
    readonly runtime?: StagehandRuntime;
  } = {},
): AgentFixture {
  const runtimeOptions: StagehandRuntimeOptions[] = [];
  const runtime = options.runtime ?? createRuntime();
  const runtimeFactory: StagehandRuntimeFactory = async (input) => {
    runtimeOptions.push(input);
    return runtime;
  };

  return {
    runtimeOptions,
    createAgent: () =>
      createStagehandAgent({
        credentials: FAKE_CREDENTIALS,
        providers: createProviderService(options.getActive ?? (() => activeConfig())),
        registry: createRegistry(options.adapter === undefined ? geminiAdapter : options.adapter),
        createRuntime: runtimeFactory,
      }),
  };
}

function createOpenRouterFailureFixture(response: Response): AgentFixture {
  const generate = createOpenRouterGenerate({
    model: "nvidia/nemotron-3.5-super-vl:free",
    apiKey: FAKE_API_KEY,
    fetch: async () => response,
  });

  return createFixture({
    getActive: () =>
      activeConfig({
        provider: "openrouter",
        model: "nvidia/nemotron-3.5-super-vl:free",
      }),
    adapter: openRouterAdapter,
    runtime: createRuntime({
      async observe() {
        await generate(openRouterGenerateRequest());
        return [];
      },
    }),
  });
}

function openRouterGenerateRequest(): Parameters<ClientModelGenerate>[0] {
  return {
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Continue" }],
      },
    ],
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createStagehandAgent", () => {
  it("rejects when no provider is configured without loading Stagehand", async () => {
    const createRuntime = vi.fn<StagehandRuntimeFactory>();
    const fixture = createFixture({ getActive: () => null });

    await expect(
      createStagehandAgent({
        credentials: FAKE_CREDENTIALS,
        providers: createProviderService(() => null),
        registry: createRegistry(geminiAdapter),
        createRuntime,
      }),
    ).rejects.toMatchObject({
      name: "AgentError",
      code: "agent_provider_not_configured",
      message: "Agent provider is not configured.",
    });

    expect(createRuntime).not.toHaveBeenCalled();
    expect(fixture.runtimeOptions).toEqual([]);
  });

  it("rejects an unknown provider without loading Stagehand", async () => {
    const createRuntime = vi.fn<StagehandRuntimeFactory>();
    const fixture = createFixture({ adapter: null });

    await expect(
      createStagehandAgent({
        credentials: FAKE_CREDENTIALS,
        providers: createProviderService(() => activeConfig()),
        registry: createRegistry(null),
        createRuntime,
      }),
    ).rejects.toMatchObject({
      name: "AgentError",
      code: "agent_provider_unsupported",
      message: "Agent provider is not supported.",
    });

    expect(createRuntime).not.toHaveBeenCalled();
    expect(fixture.runtimeOptions).toEqual([]);
  });

  it("passes the mapped model name and active key to the runtime", async () => {
    const fixture = createFixture();

    const agent = await fixture.createAgent();

    expect(fixture.runtimeOptions).toEqual([
      {
        credentials: FAKE_CREDENTIALS,
        model: {
          kind: "native",
          modelName: "google/gemini-2.5-flash",
          apiKey: FAKE_API_KEY,
        },
      },
    ]);

    await agent.close();
  });

  it("passes an OpenRouter client callback without exposing the key", async () => {
    const fixture = createFixture({
      getActive: () =>
        activeConfig({
          provider: "openrouter",
          model: "nvidia/nemotron-3.5-super-vl:free",
        }),
      adapter: openRouterAdapter,
    });

    const agent = await fixture.createAgent();
    const options = fixture.runtimeOptions[0];

    expect(options?.credentials).toEqual(FAKE_CREDENTIALS);
    expect(options?.model.kind).toBe("client");
    if (options?.model.kind !== "client") {
      throw new Error("Expected a client model config.");
    }
    expect(typeof options.model.generate).toBe("function");
    expect(Object.keys(options.model).sort()).toEqual(["generate", "kind"]);
    expect(JSON.stringify(options.model)).not.toContain(FAKE_API_KEY);

    await agent.close();
  });

  it("reads the active provider configuration on every factory call", async () => {
    let current = activeConfig({
      model: "gemini-2.5-flash",
      apiKeys: ["first-key"],
    });
    const fixture = createFixture({
      getActive: () => current,
    });

    const first = await fixture.createAgent();
    current = activeConfig({ model: "gemini-2.5-pro", apiKeys: ["second-key"] });
    const second = await fixture.createAgent();

    expect(fixture.runtimeOptions).toEqual([
      {
        credentials: FAKE_CREDENTIALS,
        model: {
          kind: "native",
          modelName: "google/gemini-2.5-flash",
          apiKey: "first-key",
        },
      },
      {
        credentials: FAKE_CREDENTIALS,
        model: {
          kind: "native",
          modelName: "google/gemini-2.5-pro",
          apiKey: "second-key",
        },
      },
    ]);

    await first.close();
    await second.close();
  });

  it("fails with a cooldown error when every key is cooling down", async () => {
    const createRuntime = vi.fn<StagehandRuntimeFactory>();

    const failure = await createStagehandAgent({
      credentials: FAKE_CREDENTIALS,
      providers: createProviderService(() => activeConfig(), {
        acquireKey: () => ({ status: "cooldown", retryAfterSeconds: 125 }),
      }),
      registry: createRegistry(geminiAdapter),
      createRuntime,
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      name: "AgentError",
      code: "agent_provider_keys_cooldown",
      message: "All provider keys are cooling down.",
      retryAfterSeconds: 125,
    });
    expect(String(failure)).not.toContain(FAKE_API_KEY);
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it("fails with a rejected error when every key failed auth", async () => {
    const createRuntime = vi.fn<StagehandRuntimeFactory>();

    const failure = await createStagehandAgent({
      credentials: FAKE_CREDENTIALS,
      providers: createProviderService(() => activeConfig(), {
        acquireKey: () => ({ status: "rejected" }),
      }),
      registry: createRegistry(geminiAdapter),
      createRuntime,
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      name: "AgentError",
      code: "agent_provider_keys_rejected",
      message: "All provider keys were rejected.",
    });
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it("marks the selected key when a provider call is rate limited", async () => {
    const keyId = providerKeyId(FAKE_API_KEY);
    const marks: {
      readonly provider: string;
      readonly keyId: string;
      readonly kind: string;
      readonly retryDelaySeconds: number | null;
    }[] = [];
    const runtime = createRuntime({
      async observe() {
        throw providerFailure({
          statusCode: 429,
          responseBody: quotaResponseBody,
        });
      },
    });
    const agent = await createStagehandAgent({
      credentials: FAKE_CREDENTIALS,
      providers: createProviderService(() => activeConfig(), {
        acquireKey: () => ({ status: "selected", keyId, apiKey: FAKE_API_KEY }),
        markKeyFailure(provider, failedKeyId, kind, retryDelaySeconds) {
          marks.push({
            provider,
            keyId: failedKeyId,
            kind,
            retryDelaySeconds,
          });
        },
      }),
      registry: createRegistry(geminiAdapter),
      createRuntime: async () => runtime,
    });

    const failure = await agent.observe("Find the submit button").catch(
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({
      name: "AgentError",
      code: "agent_observe_failed",
      providerCause: { kind: "quota_exhausted", retryDelaySeconds: 20_410 },
    });
    expect(marks).toEqual([
      {
        provider: "gemini",
        keyId,
        kind: "quota_exhausted",
        retryDelaySeconds: 20_410,
      },
    ]);
    expect(JSON.stringify(marks)).not.toContain(FAKE_API_KEY);

    await agent.close();
  });

  it("times out initialization after sixty seconds", async () => {
    vi.useFakeTimers();
    const createRuntime: StagehandRuntimeFactory = () =>
      new Promise<StagehandRuntime>(() => undefined);
    const creating = createStagehandAgent({
      credentials: FAKE_CREDENTIALS,
      providers: createProviderService(() => activeConfig()),
      registry: createRegistry(geminiAdapter),
      createRuntime,
    });
    const assertion = expect(creating).rejects.toMatchObject({
      name: "AgentError",
      code: "agent_init_timeout",
      message: "Agent initialization timed out.",
    });
    let isSettled = false;
    void creating.then(
      () => {
        isSettled = true;
      },
      () => {
        isSettled = true;
      },
    );

    await vi.advanceTimersByTimeAsync(59_999);
    expect(isSettled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(isSettled).toBe(true);
  });

  it("closes a runtime that resolves after the initialization timeout", async () => {
    vi.useFakeTimers();
    const closeCalls: number[] = [];
    let resolveRuntime: (value: StagehandRuntime) => void = () => undefined;
    const runtimePromise = new Promise<StagehandRuntime>((resolvePromise) => {
      resolveRuntime = resolvePromise;
    });
    const runtimeFactory: StagehandRuntimeFactory = () => runtimePromise;
    const creating = createStagehandAgent({
      credentials: FAKE_CREDENTIALS,
      providers: createProviderService(() => activeConfig()),
      registry: createRegistry(geminiAdapter),
      createRuntime: runtimeFactory,
    });
    const assertion = expect(creating).rejects.toMatchObject({
      code: "agent_init_timeout",
    });

    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;

    resolveRuntime(
      createRuntime({
        async close() {
          closeCalls.push(1);
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(closeCalls).toEqual([1]);
  });

  it("maps initialization failures without leaking the key or CDP token", async () => {
    const createRuntime: StagehandRuntimeFactory = async () => {
      throw new Error(
        `attach failed for ${FAKE_API_KEY} ${FAKE_CREDENTIALS.bearerToken} ${FAKE_CREDENTIALS.extensionCdpUrl}`,
      );
    };

    await expect(
      createStagehandAgent({
        credentials: FAKE_CREDENTIALS,
        providers: createProviderService(() => activeConfig()),
        registry: createRegistry(geminiAdapter),
        createRuntime,
      }),
    ).rejects.toMatchObject({
      name: "AgentError",
      code: "agent_attach_failed",
      message: "Agent failed to attach to the browser.",
    });

    const error = await createStagehandAgent({
      credentials: FAKE_CREDENTIALS,
      providers: createProviderService(() => activeConfig()),
      registry: createRegistry(geminiAdapter),
      createRuntime,
    }).catch((failure: unknown) => failure);

    expect(String(error)).not.toContain(FAKE_API_KEY);
    expect(String(error)).not.toContain(FAKE_CREDENTIALS.bearerToken);
    expect(String(error)).not.toContain("fake-agent-capability");
  });
});

describe("snapshot", () => {
  it("returns the accessibility tree with a twenty second default timeout", async () => {
    const timeouts: number[] = [];
    const fixture = createFixture({
      runtime: createRuntime({
        async snapshot(timeoutMs) {
          timeouts.push(timeoutMs);
          return "main heading";
        },
      }),
    });
    const agent = await fixture.createAgent();

    await expect(agent.snapshot()).resolves.toEqual({ formattedTree: "main heading" });
    await expect(agent.snapshot({ timeoutMs: 5_000 })).resolves.toEqual({
      formattedTree: "main heading",
    });
    expect(timeouts).toEqual([20_000, 5_000]);

    await agent.close();
  });

  it("rejects an empty tree", async () => {
    const fixture = createFixture({
      runtime: createRuntime({
        async snapshot() {
          return "   ";
        },
      }),
    });
    const agent = await fixture.createAgent();

    await expect(agent.snapshot()).rejects.toMatchObject({
      name: "AgentError",
      code: "agent_snapshot_failed",
      providerCause: null,
    });

    await agent.close();
  });

  it("stops waiting after the default twenty seconds", async () => {
    const fixture = createFixture({
      runtime: createRuntime({
        snapshot: () => new Promise<string>(() => undefined),
      }),
    });
    const agent = await fixture.createAgent();
    vi.useFakeTimers();

    const pending = agent.snapshot();
    const assertion = expect(pending).rejects.toMatchObject({
      name: "AgentError",
      code: "agent_timeout",
      operation: "snapshot",
    });
    let isSettled = false;
    void pending.then(
      () => {
        isSettled = true;
      },
      () => {
        isSettled = true;
      },
    );

    await vi.advanceTimersByTimeAsync(19_999);
    expect(isSettled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await assertion;
  });

  it("applies a caller supplied snapshot timeout", async () => {
    const fixture = createFixture({
      runtime: createRuntime({
        snapshot: () => new Promise<string>(() => undefined),
      }),
    });
    const agent = await fixture.createAgent();
    vi.useFakeTimers();

    const pending = agent.snapshot({ timeoutMs: 5_000 });
    const assertion = expect(pending).rejects.toMatchObject({
      code: "agent_timeout",
      operation: "snapshot",
    });

    await vi.advanceTimersByTimeAsync(4_999);
    let isSettled = false;
    void pending.then(
      () => {
        isSettled = true;
      },
      () => {
        isSettled = true;
      },
    );
    expect(isSettled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await assertion;
  });
});

describe("observe", () => {
  it("returns reusable actions with a sixty second timeout", async () => {
    const actions: AgentAction[] = [
      { selector: "#continue", description: "Continue", method: "click", arguments: [] },
    ];
    const timeouts: number[] = [];
    const fixture = createFixture({
      runtime: createRuntime({
        async observe(_instruction, timeoutMs) {
          timeouts.push(timeoutMs);
          return actions;
        },
      }),
    });
    const agent = await fixture.createAgent();

    await expect(agent.observe("Continue")).resolves.toEqual(actions);
    expect(timeouts).toEqual([60_000]);

    await agent.close();
  });

  it("stops waiting after sixty seconds", async () => {
    const fixture = createFixture({
      runtime: createRuntime({
        observe: () => new Promise<readonly AgentAction[]>(() => undefined),
      }),
    });
    const agent = await fixture.createAgent();
    vi.useFakeTimers();

    const pending = agent.observe("Continue");
    const assertion = expect(pending).rejects.toMatchObject({
      code: "agent_timeout",
      operation: "observe",
    });

    await vi.advanceTimersByTimeAsync(59_999);
    let isSettled = false;
    void pending.then(
      () => {
        isSettled = true;
      },
      () => {
        isSettled = true;
      },
    );
    expect(isSettled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await assertion;
  });
});

describe("act", () => {
  it("replays an observed action with the element action timeout", async () => {
    const action: AgentAction = {
      selector: "#continue",
      description: "Continue",
      method: "click",
      arguments: [],
    };
    let received: string | AgentAction | null = null;
    const timeouts: number[] = [];
    const fixture = createFixture({
      runtime: createRuntime({
        async act(input, timeoutMs) {
          received = input;
          timeouts.push(timeoutMs);
          return { success: true, actionCount: 2 };
        },
      }),
    });
    const agent = await fixture.createAgent();

    await expect(agent.act(action)).resolves.toEqual({ success: true, actionCount: 2 });
    expect(received).toEqual(action);
    expect(timeouts).toEqual([10_000]);

    await agent.close();
  });

  it("runs an instruction with the model timeout", async () => {
    const timeouts: number[] = [];
    const fixture = createFixture({
      runtime: createRuntime({
        async act(_input, timeoutMs) {
          timeouts.push(timeoutMs);
          return { success: true, actionCount: 1 };
        },
      }),
    });
    const agent = await fixture.createAgent();

    await agent.act("Continue to the next page");

    expect(timeouts).toEqual([60_000]);

    await agent.close();
  });

  it("stops waiting after sixty seconds for an instruction", async () => {
    const fixture = createFixture({
      runtime: createRuntime({
        act: () => new Promise(() => undefined),
      }),
    });
    const agent = await fixture.createAgent();
    vi.useFakeTimers();

    const pending = agent.act("Continue");
    const assertion = expect(pending).rejects.toMatchObject({
      code: "agent_timeout",
      operation: "act",
    });

    await vi.advanceTimersByTimeAsync(59_999);
    let isSettled = false;
    void pending.then(
      () => {
        isSettled = true;
      },
      () => {
        isSettled = true;
      },
    );
    expect(isSettled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await assertion;
  });

  it("stops waiting after ten seconds for a replay", async () => {
    const fixture = createFixture({
      runtime: createRuntime({
        act: () => new Promise(() => undefined),
      }),
    });
    const agent = await fixture.createAgent();
    vi.useFakeTimers();

    const pending = agent.act({ selector: "#continue", description: "Continue" });
    const assertion = expect(pending).rejects.toMatchObject({
      code: "agent_timeout",
      operation: "act",
    });

    await vi.advanceTimersByTimeAsync(9_999);
    let isSettled = false;
    void pending.then(
      () => {
        isSettled = true;
      },
      () => {
        isSettled = true;
      },
    );
    expect(isSettled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await assertion;
  });
});

describe("extractText", () => {
  it("returns the raw model data with a sixty second timeout", async () => {
    const calls: Array<{ readonly timeoutMs: number; readonly screenshot: boolean }> = [];
    const fixture = createFixture({
      runtime: createRuntime({
        async extract(_instruction, options) {
          calls.push(options);
          return { extraction: "raw text" };
        },
      }),
    });
    const agent = await fixture.createAgent();

    await expect(agent.extractText("Read the heading")).resolves.toEqual({
      extraction: "raw text",
    });
    expect(calls).toEqual([{ timeoutMs: 60_000, screenshot: false }]);

    await agent.close();
  });

  it("requests a screenshot only when explicitly asked", async () => {
    const calls: Array<{ readonly timeoutMs: number; readonly screenshot: boolean }> = [];
    const fixture = createFixture({
      runtime: createRuntime({
        async extract(_instruction, options) {
          calls.push(options);
          return { extraction: "raw text" };
        },
      }),
    });
    const agent = await fixture.createAgent();

    await agent.extractText("Read the heading", { screenshot: true });
    await agent.extractText("Read the heading", { screenshot: false });

    expect(calls).toEqual([
      { timeoutMs: 60_000, screenshot: true },
      { timeoutMs: 60_000, screenshot: false },
    ]);

    await agent.close();
  });

  it("stops waiting after sixty seconds", async () => {
    const fixture = createFixture({
      runtime: createRuntime({
        extract: () => new Promise(() => undefined),
      }),
    });
    const agent = await fixture.createAgent();
    vi.useFakeTimers();

    const pending = agent.extractText("Read the heading");
    const assertion = expect(pending).rejects.toMatchObject({
      code: "agent_timeout",
      operation: "extract",
    });

    await vi.advanceTimersByTimeAsync(59_999);
    let isSettled = false;
    void pending.then(
      () => {
        isSettled = true;
      },
      () => {
        isSettled = true;
      },
    );
    expect(isSettled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await assertion;
  });
});

describe("extractStructured", () => {
  const structuredSchema = z.strictObject({
    stepOk: z.boolean(),
    goalComplete: z.boolean(),
    reason: z.string().min(1).max(4_000),
  });

  it("forwards the exact schema and returns structured data with a sixty second timeout", async () => {
    const calls: Array<{
      readonly instruction: string;
      readonly schema: StagehandExtractSchema;
      readonly options: { readonly timeoutMs: number };
    }> = [];
    const fixture = createFixture({
      runtime: createRuntime({
        async extractStructured(instruction, schema, options) {
          calls.push({ instruction, schema, options });
          return {
            stepOk: true,
            goalComplete: false,
            reason: "Tombol menampilkan kode.",
          };
        },
      }),
    });
    const agent = await fixture.createAgent();

    await expect(
      agent.extractStructured("Verify the step", structuredSchema),
    ).resolves.toEqual({
      stepOk: true,
      goalComplete: false,
      reason: "Tombol menampilkan kode.",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.instruction).toBe("Verify the step");
    expect(calls[0]?.schema).toBe(structuredSchema);
    expect(calls[0]?.options).toEqual({ timeoutMs: 60_000 });

    await agent.close();
  });

  it("stops waiting after sixty seconds", async () => {
    const fixture = createFixture({
      runtime: createRuntime({
        extractStructured: () => new Promise(() => undefined),
      }),
    });
    const agent = await fixture.createAgent();
    vi.useFakeTimers();

    const pending = agent.extractStructured("Verify the step", structuredSchema);
    const assertion = expect(pending).rejects.toMatchObject({
      code: "agent_timeout",
      operation: "extract",
    });

    await vi.advanceTimersByTimeAsync(59_999);
    let isSettled = false;
    void pending.then(
      () => {
        isSettled = true;
      },
      () => {
        isSettled = true;
      },
    );
    expect(isSettled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await assertion;
  });
});

describe("preparePage", () => {
  it("does not reload a page whose locator world is ready", async () => {
    const calls: Array<{ readonly probeTimeoutMs: number; readonly reloadTimeoutMs: number }> = [];
    const fixture = createFixture({
      runtime: createRuntime({
        async preparePage(options) {
          calls.push(options);
          return { ready: true, reloaded: false };
        },
      }),
    });
    const agent = await fixture.createAgent();

    await expect(agent.preparePage()).resolves.toEqual({ reloaded: false });
    expect(calls).toEqual([{ probeTimeoutMs: 3_000, reloadTimeoutMs: 30_000 }]);

    await agent.close();
  });

  it("reports the single reload that warmed the page", async () => {
    const fixture = createFixture({
      runtime: createRuntime({
        async preparePage() {
          return { ready: true, reloaded: true };
        },
      }),
    });
    const agent = await fixture.createAgent();

    await expect(agent.preparePage()).resolves.toEqual({ reloaded: true });

    await agent.close();
  });

  it("fails with agent_page_not_ready after two failed probes", async () => {
    const fixture = createFixture({
      runtime: createRuntime({
        async preparePage() {
          return { ready: false, reloaded: true };
        },
      }),
    });
    const agent = await fixture.createAgent();

    await expect(agent.preparePage()).rejects.toMatchObject({
      name: "AgentError",
      code: "agent_page_not_ready",
      operation: "prepare",
      reloaded: true,
      providerCause: null,
      message: "Agent page is not ready.",
    });

    await agent.close();
  });

  it("does not leak the key or page content when preparation fails", async () => {
    const fixture = createFixture({
      runtime: createRuntime({
        async preparePage() {
          throw new Error(
            `prepare failed with ${FAKE_API_KEY} and <html>isi halaman rahasia</html>`,
          );
        },
      }),
    });
    const agent = await fixture.createAgent();

    const error = await agent.preparePage().catch((failure: unknown) => failure);

    expect(error).toMatchObject({ code: "agent_page_not_ready" });
    expect(String(error)).not.toContain(FAKE_API_KEY);
    expect(String(error)).not.toContain("isi halaman rahasia");

    await agent.close();
  });

  it("stops waiting after forty seconds", async () => {
    const fixture = createFixture({
      runtime: createRuntime({
        preparePage: () => new Promise(() => undefined),
      }),
    });
    const agent = await fixture.createAgent();
    vi.useFakeTimers();

    const pending = agent.preparePage();
    const assertion = expect(pending).rejects.toMatchObject({
      code: "agent_page_not_ready",
      operation: "prepare",
    });

    await vi.advanceTimersByTimeAsync(39_999);
    let isSettled = false;
    void pending.then(
      () => {
        isSettled = true;
      },
      () => {
        isSettled = true;
      },
    );
    expect(isSettled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await assertion;
  });
});

describe("operation failures", () => {
  it("maps observe, act, and extract failures without leaking the key", async () => {
    const fixture = createFixture({
      runtime: createRuntime({
        async observe() {
          throw new Error(`observe failed with ${FAKE_API_KEY}`);
        },
        async act() {
          throw new Error(`act failed with ${FAKE_API_KEY}`);
        },
        async extract() {
          throw new Error(`extract failed with ${FAKE_API_KEY}`);
        },
        async extractStructured() {
          throw new Error(`structured extract failed with ${FAKE_API_KEY}`);
        },
      }),
    });
    const agent = await fixture.createAgent();

    const observeError = await agent.observe("Continue").catch((error: unknown) => error);
    const actError = await agent.act("Continue").catch((error: unknown) => error);
    const extractError = await agent
      .extractText("Read the heading")
      .catch((error: unknown) => error);
    const structuredError = await agent
      .extractStructured(
        "Verify the heading",
        z.strictObject({ stepOk: z.boolean() }),
      )
      .catch((error: unknown) => error);

    expect(observeError).toMatchObject({ code: "agent_observe_failed" });
    expect(actError).toMatchObject({ code: "agent_act_failed" });
    expect(extractError).toMatchObject({ code: "agent_extract_failed" });
    expect(structuredError).toMatchObject({ code: "agent_extract_failed" });
    expect(String(observeError)).not.toContain(FAKE_API_KEY);
    expect(String(actError)).not.toContain(FAKE_API_KEY);
    expect(String(extractError)).not.toContain(FAKE_API_KEY);
    expect(String(structuredError)).not.toContain(FAKE_API_KEY);

    await agent.close();
  });
});

describe("provider cause", () => {
  it("maps a quota 429 with retry delay and quota id without leaking the body", async () => {
    const bodyMarker = "raw-provider-body";
    const fixture = createFixture({
      runtime: createRuntime({
        async observe() {
          throw providerFailure({
            message: `${bodyMarker} ${FAKE_API_KEY}`,
            statusCode: 429,
            responseBody: quotaResponseBody,
          });
        },
      }),
    });
    const agent = await fixture.createAgent();

    const error = await agent.observe("Continue").catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(AgentError);
    expect(error).toMatchObject({
      code: "agent_observe_failed",
      message: "Agent observe failed.",
      providerCause: {
        kind: "quota_exhausted",
        httpStatus: 429,
        retryDelaySeconds: 20_410,
        quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
      },
    });
    expect(String(error)).not.toContain(bodyMarker);
    expect(String(error)).not.toContain(FAKE_API_KEY);
    expect(String(error)).not.toContain("RESOURCE_EXHAUSTED");

    await agent.close();
  });

  it("reads a quota 429 from a non-enumerable lastError wrapper", async () => {
    const fixture = createFixture({
      runtime: createRuntime({
        async observe() {
          throw wrappedFailure({
            lastError: providerFailure({
              statusCode: 429,
              responseBody: quotaResponseBody,
            }),
          });
        },
      }),
    });
    const agent = await fixture.createAgent();

    const error = await agent.observe("Continue").catch((failure: unknown) => failure);

    expect(error).toMatchObject({
      code: "agent_observe_failed",
      providerCause: {
        kind: "quota_exhausted",
        httpStatus: 429,
        retryDelaySeconds: 20_410,
        quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
      },
    });
    expect(String(error)).not.toContain("RESOURCE_EXHAUSTED");

    await agent.close();
  });

  it("reads a quota 429 from a non-enumerable errors array", async () => {
    const fixture = createFixture({
      runtime: createRuntime({
        async observe() {
          throw wrappedFailure({
            errors: [
              providerFailure({
                message: "You exceeded your current quota.",
                statusCode: 429,
              }),
            ],
          });
        },
      }),
    });
    const agent = await fixture.createAgent();

    const error = await agent.observe("Continue").catch((failure: unknown) => failure);

    expect(error).toMatchObject({
      code: "agent_observe_failed",
      providerCause: {
        kind: "quota_exhausted",
        httpStatus: 429,
      },
    });

    await agent.close();
  });

  it("follows a four level cause chain to a quota 429", async () => {
    const fixture = createFixture({
      runtime: createRuntime({
        async observe() {
          throw providerFailure({
            cause: providerFailure({
              cause: providerFailure({
                cause: providerFailure({
                  cause: providerFailure({
                    statusCode: 429,
                    responseBody: quotaResponseBody,
                  }),
                }),
              }),
            }),
          });
        },
      }),
    });
    const agent = await fixture.createAgent();

    const error = await agent.observe("Continue").catch((failure: unknown) => failure);

    expect(error).toMatchObject({
      code: "agent_observe_failed",
      providerCause: {
        kind: "quota_exhausted",
        httpStatus: 429,
      },
    });

    await agent.close();
  });

  it("classifies quota text without a status as quota exhausted", async () => {
    const fixture = createFixture({
      runtime: createRuntime({
        async observe() {
          throw providerFailure({
            message: "RESOURCE_EXHAUSTED: you exceeded your current quota.",
          });
        },
      }),
    });
    const agent = await fixture.createAgent();

    const error = await agent.observe("Continue").catch((failure: unknown) => failure);

    expect(error).toMatchObject({
      code: "agent_observe_failed",
      providerCause: {
        kind: "quota_exhausted",
        httpStatus: null,
      },
    });

    await agent.close();
  });

  it.each<[string, number]>([
    ["Please retry in 4441s", 4441],
    ["retryDelay: 30s", 30],
    ["retry after 30s", 30],
  ])("reads the retry delay from the provider text %s", async (message, seconds) => {
    const fixture = createFixture({
      runtime: createRuntime({
        async observe() {
          throw providerFailure({ message });
        },
      }),
    });
    const agent = await fixture.createAgent();

    const error = await agent.observe("Continue").catch((failure: unknown) => failure);

    expect(error).toMatchObject({
      code: "agent_observe_failed",
      providerCause: {
        retryDelaySeconds: seconds,
      },
    });
    expect(String(error)).not.toContain(message);

    await agent.close();
  });

  it("marks the selected key from a wrapped quota message with its retry delay", async () => {
    const keyId = providerKeyId(FAKE_API_KEY);
    const marks: {
      readonly provider: string;
      readonly keyId: string;
      readonly kind: string;
      readonly retryDelaySeconds: number | null;
    }[] = [];
    const runtime = createRuntime({
      async observe() {
        throw wrappedFailure(
          {},
          "Failed after 3 attempts. Last error: AI_APICallError quota exceeded. Please retry in 4441s.",
        );
      },
    });
    const agent = await createStagehandAgent({
      credentials: FAKE_CREDENTIALS,
      providers: createProviderService(() => activeConfig(), {
        acquireKey: () => ({ status: "selected", keyId, apiKey: FAKE_API_KEY }),
        markKeyFailure(provider, failedKeyId, kind, retryDelaySeconds) {
          marks.push({
            provider,
            keyId: failedKeyId,
            kind,
            retryDelaySeconds,
          });
        },
      }),
      registry: createRegistry(geminiAdapter),
      createRuntime: async () => runtime,
    });

    const failure = await agent.observe("Continue").catch(
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({
      code: "agent_observe_failed",
      providerCause: {
        kind: "quota_exhausted",
        httpStatus: null,
        retryDelaySeconds: 4441,
      },
    });
    expect(marks).toEqual([
      {
        provider: "gemini",
        keyId,
        kind: "quota_exhausted",
        retryDelaySeconds: 4441,
      },
    ]);
    expect(JSON.stringify(failure)).not.toContain("Failed after 3 attempts");

    await agent.close();
  });

  it("leaves a page failure unknown and does not mark the key", async () => {
    const marks: string[] = [];
    const runtime = createRuntime({
      async observe() {
        throw new Error("Page is not ready.");
      },
    });
    const agent = await createStagehandAgent({
      credentials: FAKE_CREDENTIALS,
      providers: createProviderService(() => activeConfig(), {
        markKeyFailure(_provider, keyId) {
          marks.push(keyId);
        },
      }),
      registry: createRegistry(geminiAdapter),
      createRuntime: async () => runtime,
    });

    const failure = await agent.observe("Continue").catch(
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({
      code: "agent_observe_failed",
      providerCause: {
        kind: "unknown",
        httpStatus: null,
      },
    });
    expect(marks).toEqual([]);

    await agent.close();
  });

  it("bounds a huge cyclic provider object without failing", async () => {
    const huge: Record<string, unknown> = {
      statusCode: 429,
      message: "quota exceeded",
    };
    huge.self = huge;
    for (let index = 0; index < 20_000; index += 1) {
      huge[`field${index}`] = index;
    }
    const fixture = createFixture({
      runtime: createRuntime({
        async observe() {
          throw providerFailure({ cause: huge });
        },
      }),
    });
    const agent = await fixture.createAgent();

    const error = await agent.observe("Continue").catch((failure: unknown) => failure);

    expect(error).toMatchObject({
      code: "agent_observe_failed",
      providerCause: {
        kind: "quota_exhausted",
        httpStatus: 429,
      },
    });

    await agent.close();
  });

  it("ignores a quota status beyond the six level depth limit", async () => {
    let nested: unknown = providerFailure({
      statusCode: 429,
      message: "RESOURCE_EXHAUSTED",
    });
    for (let level = 0; level < 7; level += 1) {
      nested = providerFailure({ cause: nested });
    }
    const fixture = createFixture({
      runtime: createRuntime({
        async observe() {
          throw nested;
        },
      }),
    });
    const agent = await fixture.createAgent();

    const error = await agent.observe("Continue").catch((failure: unknown) => failure);

    expect(error).toMatchObject({
      code: "agent_observe_failed",
      providerCause: {
        kind: "unknown",
        httpStatus: null,
      },
    });

    await agent.close();
  });

  it("maps a 402 to credits exhausted without a retry delay or raw body", async () => {
    const bodyMarker = "raw-credit-body";
    const fixture = createFixture({
      runtime: createRuntime({
        async observe() {
          throw providerFailure({
            message: `${bodyMarker} ${FAKE_API_KEY}`,
            statusCode: 402,
            responseBody: JSON.stringify({
              error: { message: "requires more credits" },
            }),
          });
        },
      }),
    });
    const agent = await fixture.createAgent();

    const error = await agent.observe("Continue").catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(AgentError);
    expect(error).toMatchObject({
      code: "agent_observe_failed",
      providerCause: {
        kind: "credits_exhausted",
        httpStatus: 402,
        retryDelaySeconds: null,
        quotaId: null,
      },
    });
    expect(String(error)).not.toContain(bodyMarker);
    expect(String(error)).not.toContain(FAKE_API_KEY);
    expect(String(error)).not.toContain("requires more credits");

    await agent.close();
  });

  it("reads a 402 retry delay from the Retry-After header", async () => {
    const fixture = createFixture({
      runtime: createRuntime({
        async observe() {
          throw providerFailure({
            statusCode: 402,
            responseHeaders: { "Retry-After": "60" },
          });
        },
      }),
    });
    const agent = await fixture.createAgent();

    const error = await agent.observe("Continue").catch((failure: unknown) => failure);

    expect(error).toMatchObject({
      providerCause: {
        kind: "credits_exhausted",
        httpStatus: 402,
        retryDelaySeconds: 60,
      },
    });

    await agent.close();
  });

  it("maps an OpenRouter 402 with sanitized budget metadata to credits exhausted", async () => {
    const bodyMarker = "raw-credit-body";
    const fixture = createOpenRouterFailureFixture(
      new Response(
        JSON.stringify({
          error: {
            message: `${bodyMarker} ${FAKE_API_KEY}`,
            metadata: { limit_source: "openrouter_credits" },
          },
        }),
        { status: 402, headers: { "Content-Type": "application/json" } },
      ),
    );
    const agent = await fixture.createAgent();

    const error = await agent.observe("Continue").catch((failure: unknown) => failure);

    expect(error).toMatchObject({
      code: "agent_observe_failed",
      message: "Agent observe failed.",
      providerCause: {
        kind: "credits_exhausted",
        httpStatus: 402,
        retryDelaySeconds: null,
        quotaId: null,
      },
    });
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(bodyMarker);
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(FAKE_API_KEY);

    await agent.close();
  });

  it("maps an OpenRouter 403 with a key limit source to credits exhausted", async () => {
    const fixture = createOpenRouterFailureFixture(
      new Response(
        JSON.stringify({
          error: {
            message: "Key limit exceeded.",
            metadata: { limit_source: "openrouter_key_limit" },
          },
        }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      ),
    );
    const agent = await fixture.createAgent();

    const error = await agent.observe("Continue").catch((failure: unknown) => failure);

    expect(error).toMatchObject({
      providerCause: {
        kind: "credits_exhausted",
        httpStatus: 403,
      },
    });

    await agent.close();
  });

  it("keeps an OpenRouter 403 without a limit source as auth or key", async () => {
    const fixture = createOpenRouterFailureFixture(
      new Response(
        JSON.stringify({ error: { message: "Forbidden." } }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      ),
    );
    const agent = await fixture.createAgent();

    const error = await agent.observe("Continue").catch((failure: unknown) => failure);

    expect(error).toMatchObject({
      providerCause: { kind: "auth_or_key", httpStatus: 403 },
    });

    await agent.close();
  });

  it("reads an OpenRouter 429 Retry-After into the rate limit cause", async () => {
    const fixture = createOpenRouterFailureFixture(
      new Response(
        JSON.stringify({ error: { message: "Too many requests." } }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": "20",
          },
        },
      ),
    );
    const agent = await fixture.createAgent();

    const error = await agent.observe("Continue").catch((failure: unknown) => failure);

    expect(error).toMatchObject({
      providerCause: {
        kind: "rate_limited",
        httpStatus: 429,
        retryDelaySeconds: 20,
      },
    });

    await agent.close();
  });

  it("maps an OpenRouter 500 to an upstream unavailable cause", async () => {
    const fixture = createOpenRouterFailureFixture(
      new Response(null, { status: 500 }),
    );
    const agent = await fixture.createAgent();

    const error = await agent.observe("Continue").catch((failure: unknown) => failure);

    expect(error).toMatchObject({
      providerCause: {
        kind: "upstream_unavailable",
        httpStatus: 500,
      },
    });

    await agent.close();
  });

  it("maps an OpenRouter budget 403 to credits exhausted", async () => {
    const fixture = createFixture({
      runtime: createRuntime({
        async observe() {
          throw providerFailure({
            statusCode: 403,
            responseBody: JSON.stringify({
              error: {
                code: 403,
                message: "Key limit exceeded.",
                metadata: { limit_source: "openrouter_key_limit" },
              },
            }),
          });
        },
      }),
    });
    const agent = await fixture.createAgent();

    const error = await agent.observe("Continue").catch((failure: unknown) => failure);

    expect(error).toMatchObject({
      providerCause: {
        kind: "credits_exhausted",
        httpStatus: 403,
      },
    });

    await agent.close();
  });

  it("keeps a 403 without an OpenRouter limit source as an auth or key cause", async () => {
    const fixture = createFixture({
      runtime: createRuntime({
        async observe() {
          throw providerFailure({
            statusCode: 403,
            responseBody: JSON.stringify({
              error: { code: 403, message: "Forbidden." },
            }),
          });
        },
      }),
    });
    const agent = await fixture.createAgent();

    const error = await agent.observe("Continue").catch((failure: unknown) => failure);

    expect(error).toMatchObject({
      providerCause: { kind: "auth_or_key", httpStatus: 403 },
    });

    await agent.close();
  });

  it("reads a credits status within the three level cause chain", async () => {
    const fixture = createFixture({
      runtime: createRuntime({
        async observe() {
          throw providerFailure({
            cause: { cause: { statusCode: 402 } },
          });
        },
      }),
    });
    const agent = await fixture.createAgent();

    const error = await agent.observe("Continue").catch((failure: unknown) => failure);

    expect(error).toMatchObject({
      providerCause: { kind: "credits_exhausted", httpStatus: 402 },
    });

    await agent.close();
  });

  it("reads a credits status at the six level depth boundary", async () => {
    const fixture = createFixture({
      runtime: createRuntime({
        async observe() {
          throw providerFailure({
            cause: providerFailure({
              cause: providerFailure({
                cause: providerFailure({
                  cause: providerFailure({
                    cause: providerFailure({
                      cause: providerFailure({ statusCode: 402 }),
                    }),
                  }),
                }),
              }),
            }),
          });
        },
      }),
    });
    const agent = await fixture.createAgent();

    const error = await agent.observe("Continue").catch((failure: unknown) => failure);

    expect(error).toMatchObject({
      providerCause: { kind: "credits_exhausted", httpStatus: 402 },
    });

    await agent.close();
  });

  it.each<[string, Error, ProviderCauseKind]>([
    [
      "a 429 without a quota signal",
      providerFailure({ statusCode: 429, message: "Too many requests." }),
      "rate_limited",
    ],
    ["a 401", providerFailure({ statusCode: 401 }), "auth_or_key"],
    ["a 403", providerFailure({ statusCode: 403 }), "auth_or_key"],
    ["a 503", providerFailure({ statusCode: 503 }), "upstream_unavailable"],
    [
      "a 400 with a response schema signal",
      providerFailure({ statusCode: 400, message: "Invalid responseSchema payload." }),
      "schema_rejected",
    ],
    ["a network refusal", providerFailure({ code: "ECONNREFUSED" }), "network"],
    ["an unrecognized failure", providerFailure({}), "unknown"],
  ])("classifies %s", async (_label, raw, kind) => {
    const fixture = createFixture({
      runtime: createRuntime({
        async observe() {
          throw raw;
        },
      }),
    });
    const agent = await fixture.createAgent();

    const error = await agent.observe("Continue").catch((failure: unknown) => failure);

    expect(error).toMatchObject({
      code: "agent_observe_failed",
      providerCause: { kind },
    });

    await agent.close();
  });

  it("reads quota signals from a nested cause", async () => {
    const fixture = createFixture({
      runtime: createRuntime({
        async observe() {
          throw providerFailure({
            statusCode: 429,
            cause: { responseBody: quotaResponseBody },
          });
        },
      }),
    });
    const agent = await fixture.createAgent();

    const error = await agent.observe("Continue").catch((failure: unknown) => failure);

    expect(error).toMatchObject({
      providerCause: {
        kind: "quota_exhausted",
        httpStatus: 429,
        retryDelaySeconds: 20_410,
        quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
      },
    });

    await agent.close();
  });

  it("classifies a timeout as a timeout cause", async () => {
    const fixture = createFixture({
      runtime: createRuntime({
        observe: () => new Promise<readonly AgentAction[]>(() => undefined),
      }),
    });
    const agent = await fixture.createAgent();
    vi.useFakeTimers();

    const pending = agent.observe("Continue").catch((failure: unknown) => failure);
    await vi.advanceTimersByTimeAsync(60_000);
    const error = await pending;

    expect(error).toMatchObject({
      code: "agent_timeout",
      providerCause: {
        kind: "timeout",
        httpStatus: null,
        retryDelaySeconds: null,
        quotaId: null,
      },
    });

    await agent.close();
  });

  it("keeps a provider cause thrown by the runtime", async () => {
    const cause: ProviderCause = {
      kind: "quota_exhausted",
      httpStatus: 429,
      retryDelaySeconds: 20,
      quotaId: null,
    };
    const original = new AgentError("agent_observe_failed", "observe", false, cause);
    const fixture = createFixture({
      runtime: createRuntime({
        async observe() {
          throw original;
        },
      }),
    });
    const agent = await fixture.createAgent();

    const error = await agent.observe("Continue").catch((failure: unknown) => failure);

    expect(error).toBe(original);
    expect(error).toMatchObject({ providerCause: cause });

    await agent.close();
  });
});

describe("close", () => {
  it("is idempotent and rejects later operations", async () => {
    const closeCalls: number[] = [];
    const fixture = createFixture({
      runtime: createRuntime({
        async close() {
          closeCalls.push(Date.now());
        },
      }),
    });
    const agent = await fixture.createAgent();

    await agent.close();
    await agent.close();

    expect(closeCalls).toHaveLength(1);
    await expect(agent.snapshot()).rejects.toMatchObject({
      name: "AgentError",
      code: "agent_closed",
      message: "Agent adapter is closed.",
    });
    await expect(agent.observe("Continue")).rejects.toMatchObject({ code: "agent_closed" });
    await expect(agent.act("Continue")).rejects.toMatchObject({ code: "agent_closed" });
    await expect(agent.extractText("Read")).rejects.toMatchObject({ code: "agent_closed" });
  });

  it("never throws when the runtime close fails", async () => {
    const fixture = createFixture({
      runtime: createRuntime({
        async close() {
          throw new Error(`close failed with ${FAKE_API_KEY}`);
        },
      }),
    });
    const agent = await fixture.createAgent();

    await expect(agent.close()).resolves.toBeUndefined();
    await expect(agent.snapshot()).rejects.toMatchObject({ code: "agent_closed" });
  });

  it("stops waiting after five seconds", async () => {
    const fixture = createFixture({
      runtime: createRuntime({
        close: () => new Promise<void>(() => undefined),
      }),
    });
    const agent = await fixture.createAgent();
    vi.useFakeTimers();

    const closing = agent.close();
    let isSettled = false;
    void closing.then(() => {
      isSettled = true;
    });

    await vi.advanceTimersByTimeAsync(4_999);
    expect(isSettled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(isSettled).toBe(true);
  });
});
