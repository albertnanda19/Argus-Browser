import { afterEach, describe, expect, it, vi } from "vitest";
import {
  prepareStagehandPage,
  probeLocatorWorld,
  unwrapExtractionResult,
  type LocatorWorldPage,
} from "./stagehand-runtime";

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
