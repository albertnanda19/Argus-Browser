import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createStagehandAgent } from "./stagehand-agent";
import type { ProviderConfig } from "../shared/provider";
import type { ProviderAdapter, ProviderRegistry } from "./provider-registry";
import type { ProviderService } from "./provider-service";
import type { StoredProviderConfig } from "./provider-store";
import type {
  AgentAction,
  StagehandExtractSchema,
  StagehandRuntime,
  StagehandRuntimeFactory,
  StagehandRuntimeOptions,
} from "./stagehand-runtime";

const FAKE_CDP_URL = "http://127.0.0.1:59876";
const FAKE_API_KEY = "fake-agent-key";
const UPDATED_AT = "2026-10-25T10:00:00.000Z";

function activeConfig(overrides: Partial<StoredProviderConfig> = {}): StoredProviderConfig {
  return {
    provider: "gemini",
    model: "gemini-2.5-flash",
    apiKey: FAKE_API_KEY,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

function createProviderService(getActive: () => StoredProviderConfig | null): ProviderService {
  return {
    getConfig(): ProviderConfig {
      const active = getActive();
      return active === null
        ? { provider: null, model: null, configured: false, updatedAt: null }
        : {
            provider: active.provider,
            model: active.model,
            configured: true,
            updatedAt: active.updatedAt,
          };
    },
    getActive,
    async setConfig() {
      throw new Error("Unused provider service write.");
    },
  };
}

const geminiAdapter: ProviderAdapter = {
  id: "gemini",
  toStagehandModelName: (model) => `google/${model}`,
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
        cdpUrl: FAKE_CDP_URL,
        providers: createProviderService(options.getActive ?? (() => activeConfig())),
        registry: createRegistry(options.adapter === undefined ? geminiAdapter : options.adapter),
        createRuntime: runtimeFactory,
      }),
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
        cdpUrl: FAKE_CDP_URL,
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
        cdpUrl: FAKE_CDP_URL,
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
        cdpUrl: FAKE_CDP_URL,
        modelName: "google/gemini-2.5-flash",
        apiKey: FAKE_API_KEY,
      },
    ]);

    await agent.close();
  });

  it("reads the active provider configuration on every factory call", async () => {
    const configs = [
      activeConfig({ model: "gemini-2.5-flash", apiKey: "first-key" }),
      activeConfig({ model: "gemini-2.5-pro", apiKey: "second-key" }),
    ];
    const fixture = createFixture({
      getActive: () => configs.shift() ?? null,
    });

    const first = await fixture.createAgent();
    const second = await fixture.createAgent();

    expect(fixture.runtimeOptions).toEqual([
      { cdpUrl: FAKE_CDP_URL, modelName: "google/gemini-2.5-flash", apiKey: "first-key" },
      { cdpUrl: FAKE_CDP_URL, modelName: "google/gemini-2.5-pro", apiKey: "second-key" },
    ]);

    await first.close();
    await second.close();
  });

  it("times out initialization after sixty seconds", async () => {
    vi.useFakeTimers();
    const createRuntime: StagehandRuntimeFactory = () =>
      new Promise<StagehandRuntime>(() => undefined);
    const creating = createStagehandAgent({
      cdpUrl: FAKE_CDP_URL,
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
      cdpUrl: FAKE_CDP_URL,
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

  it("maps initialization failures without leaking the key", async () => {
    const createRuntime: StagehandRuntimeFactory = async () => {
      throw new Error(`attach failed for ${FAKE_API_KEY}`);
    };

    await expect(
      createStagehandAgent({
        cdpUrl: FAKE_CDP_URL,
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
      cdpUrl: FAKE_CDP_URL,
      providers: createProviderService(() => activeConfig()),
      registry: createRegistry(geminiAdapter),
      createRuntime,
    }).catch((failure: unknown) => failure);

    expect(String(error)).not.toContain(FAKE_API_KEY);
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
