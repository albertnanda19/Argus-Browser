import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientModelGenerate } from "./stagehand-runtime";
import {
  createStagehandRuntime,
  prepareStagehandPage,
  probeLocatorWorld,
  unwrapExtractionResult,
  type LocatorWorldPage,
} from "./stagehand-runtime";

const stagehandMocks = vi.hoisted(() => ({
  connect: vi.fn(async (_options: unknown) => ({ connected: true })),
  create: vi.fn(async (_options: unknown) => ({})),
}));

vi.mock("@browserbasehq/stagehand", () => ({
  localBrowser: { connect: stagehandMocks.connect },
  Stagehand: { create: stagehandMocks.create },
}));

const fakeCredentials = {
  gatewayUrl: "http://127.0.0.1:59876",
  bearerToken: "unit-test-runtime-bearer",
  extensionCdpUrl:
    "ws://127.0.0.1:59876/devtools/browser/test?token=unit-test-runtime-capability",
};

const PROBE_TIMEOUT_MS = 3_000;
const RELOAD_TIMEOUT_MS = 30_000;

function createPage(options: {
  readonly probeResults: readonly boolean[];
  readonly reloadError?: Error;
}) {
  const results = [...options.probeResults];
  const countCalls: number[] = [];
  const selectors: string[] = [];
  const reloadCalls: Array<{ readonly waitUntil: string; readonly timeout: number }> = [];

  const page: LocatorWorldPage = {
    locator(selector) {
      selectors.push(selector);
      return {
        async count(countOptions) {
          countCalls.push(countOptions.timeout);
          const result = results.shift();
          if (result === undefined) {
            throw new Error("No probe result left.");
          }
          if (!result) {
            throw new Error("Locator world is not ready.");
          }
          return 1;
        },
      };
    },
    async reload(reloadOptions) {
      reloadCalls.push(reloadOptions);
      if (options.reloadError !== undefined) {
        throw options.reloadError;
      }
      return null;
    },
  };

  return { page, countCalls, selectors, reloadCalls };
}

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  stagehandMocks.connect.mockClear();
  stagehandMocks.create.mockClear();
});

describe("createStagehandRuntime", () => {
  it("forwards a native model config to Stagehand.create", async () => {
    await createStagehandRuntime({
      credentials: fakeCredentials,
      model: {
        kind: "native",
        modelName: "google/gemini-2.5-flash",
        apiKey: "unit-test-runtime-key",
      },
    });

    expect(stagehandMocks.connect).toHaveBeenCalledWith({
      cdpUrl: fakeCredentials.gatewayUrl,
      headers: { Authorization: `Bearer ${fakeCredentials.bearerToken}` },
      extensionCdpUrl: fakeCredentials.extensionCdpUrl,
    });
    const connectOptions = stagehandMocks.connect.mock.calls[0]?.[0] as
      | { readonly cdpUrl?: string }
      | undefined;
    expect(connectOptions?.cdpUrl).not.toContain(fakeCredentials.bearerToken);
    expect(stagehandMocks.create).toHaveBeenCalledWith({
      browser: { connected: true },
      model: {
        modelName: "google/gemini-2.5-flash",
        apiKey: "unit-test-runtime-key",
      },
      logging: { level: "off" },
    });
  });

  it("forwards a client callback to Stagehand.create without an API key", async () => {
    const generate = (() => {
      throw new Error("Unused client callback.");
    }) as unknown as ClientModelGenerate;

    await createStagehandRuntime({
      credentials: fakeCredentials,
      model: { kind: "client", generate },
    });

    const call = stagehandMocks.create.mock.calls[0]?.[0] as
      | { readonly model?: Record<string, unknown> }
      | undefined;

    expect(call?.model).toEqual({ generate });
    expect(call?.model).not.toHaveProperty("apiKey");
  });
});

describe("probeLocatorWorld", () => {
  it("bounds a hanging probe at the supplied timeout", async () => {
    const page: LocatorWorldPage = {
      locator: () => ({
        count: () => new Promise<number>(() => undefined),
      }),
      reload: async () => null,
    };
    vi.useFakeTimers();

    const pending = probeLocatorWorld(page, PROBE_TIMEOUT_MS);
    let isSettled = false;
    void pending.then(() => {
      isSettled = true;
    });

    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS - 1);
    expect(isSettled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe(false);
  });
});

describe("unwrapExtractionResult", () => {
  it("unwraps the default extraction envelope", () => {
    expect(unwrapExtractionResult({ extraction: "teks hasil" })).toBe("teks hasil");
  });

  it("returns a string unchanged", () => {
    expect(unwrapExtractionResult("teks hasil")).toBe("teks hasil");
  });

  it("returns other objects unchanged", () => {
    const value = { data: "teks hasil" };
    expect(unwrapExtractionResult(value)).toBe(value);
    expect(unwrapExtractionResult({ extraction: 42 })).toEqual({ extraction: 42 });
    expect(unwrapExtractionResult({ extraction: "x", extra: true })).toEqual({
      extraction: "x",
      extra: true,
    });
  });

  it("returns null unchanged", () => {
    expect(unwrapExtractionResult(null)).toBeNull();
  });
});

describe("prepareStagehandPage", () => {
  it("does not reload when the locator world is ready", async () => {
    const fake = createPage({ probeResults: [true] });

    await expect(
      prepareStagehandPage(fake.page, {
        probeTimeoutMs: PROBE_TIMEOUT_MS,
        reloadTimeoutMs: RELOAD_TIMEOUT_MS,
      }),
    ).resolves.toEqual({ ready: true, reloaded: false });

    expect(fake.selectors).toEqual(["body"]);
    expect(fake.countCalls).toEqual([PROBE_TIMEOUT_MS]);
    expect(fake.reloadCalls).toHaveLength(0);
  });

  it("reloads once and rechecks after a failed probe", async () => {
    const fake = createPage({ probeResults: [false, true] });

    await expect(
      prepareStagehandPage(fake.page, {
        probeTimeoutMs: PROBE_TIMEOUT_MS,
        reloadTimeoutMs: RELOAD_TIMEOUT_MS,
      }),
    ).resolves.toEqual({ ready: true, reloaded: true });

    expect(fake.countCalls).toEqual([PROBE_TIMEOUT_MS, PROBE_TIMEOUT_MS]);
    expect(fake.reloadCalls).toEqual([
      { waitUntil: "domcontentloaded", timeout: RELOAD_TIMEOUT_MS },
    ]);
  });

  it("reports not ready after a failed reload and never probes twice", async () => {
    const fake = createPage({
      probeResults: [false],
      reloadError: new Error("reload failed"),
    });

    await expect(
      prepareStagehandPage(fake.page, {
        probeTimeoutMs: PROBE_TIMEOUT_MS,
        reloadTimeoutMs: RELOAD_TIMEOUT_MS,
      }),
    ).resolves.toEqual({ ready: false, reloaded: true });

    expect(fake.countCalls).toEqual([PROBE_TIMEOUT_MS]);
    expect(fake.reloadCalls).toHaveLength(1);
  });

  it("reports not ready after both probes fail with a single reload", async () => {
    const fake = createPage({ probeResults: [false, false] });

    await expect(
      prepareStagehandPage(fake.page, {
        probeTimeoutMs: PROBE_TIMEOUT_MS,
        reloadTimeoutMs: RELOAD_TIMEOUT_MS,
      }),
    ).resolves.toEqual({ ready: false, reloaded: true });

    expect(fake.countCalls).toHaveLength(2);
    expect(fake.reloadCalls).toHaveLength(1);
  });

  it("does not surface a reload error or page content", async () => {
    const fake = createPage({
      probeResults: [false],
      reloadError: new Error("reload failed with secret=rahasia-halaman"),
    });

    const result = await prepareStagehandPage(fake.page, {
      probeTimeoutMs: PROBE_TIMEOUT_MS,
      reloadTimeoutMs: RELOAD_TIMEOUT_MS,
    });

    expect(result).toEqual({ ready: false, reloaded: true });
    expect(JSON.stringify(result)).not.toContain("rahasia-halaman");
  });
});
