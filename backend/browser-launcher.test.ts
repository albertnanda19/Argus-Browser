import { afterEach, describe, expect, it, vi } from "vitest";
import {
  allocateCdpPort,
  createCdpLaunchArguments,
  createCdpUrl,
  launchBrowser,
  launchBrowserWithDependencies,
  waitForCdpReady,
  type BrowserSessionContext,
} from "./browser-launcher";

const { launchPersistentContext } = vi.hoisted(() => ({
  launchPersistentContext: vi.fn(),
}));

vi.mock("playwright-core", () => ({
  chromium: { launchPersistentContext },
}));

function createFakeContext() {
  let closeCalls = 0;
  const context: BrowserSessionContext = {
    async close() {
      closeCalls += 1;
    },
    on() {},
    pages: () => [],
    async newPage() {
      throw new Error("Unused page creation.");
    },
  };
  return {
    context,
    get closeCalls() {
      return closeCalls;
    },
  };
}

afterEach(() => {
  launchPersistentContext.mockReset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CDP launch configuration", () => {
  it("assembles loopback arguments for a random CDP port", () => {
    const launchArguments = createCdpLaunchArguments(54321);

    expect(launchArguments.args).toContain("--remote-debugging-port=54321");
    expect(launchArguments.args).toContain("--remote-debugging-address=127.0.0.1");
    expect(launchArguments.args).toContain("--remote-allow-origins=*");
    expect(launchArguments.args).toContain("--enable-unsafe-extension-debugging");
    expect(launchArguments.ignoreDefaultArgs).toContain("--disable-extensions");
    expect(createCdpUrl(54321)).toBe("http://127.0.0.1:54321");
  });

  it("allocates a loopback port that is not the default 9222", async () => {
    const port = await allocateCdpPort();

    expect(port).toBeGreaterThan(0);
    expect(port).not.toBe(9222);
    expect(createCdpUrl(port)).toBe(`http://127.0.0.1:${port}`);
  });
});

describe("waitForCdpReady", () => {
  it("waits until the CDP endpoint answers", async () => {
    const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await waitForCdpReady("http://127.0.0.1:54321", probe);

    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("fails when the CDP endpoint never answers", async () => {
    vi.useFakeTimers();
    const probe = vi.fn(async () => false);

    const waiting = waitForCdpReady("http://127.0.0.1:54321", probe);
    const assertion = expect(waiting).rejects.toThrow(/CDP endpoint is not ready/);
    await vi.runAllTimersAsync();
    await assertion;
  });
});

describe("launchBrowser", () => {
  it("launches Chrome with the CDP flags and returns the endpoint", async () => {
    const fake = createFakeContext();
    launchPersistentContext.mockResolvedValue(fake.context);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true })),
    );

    const result = await launchBrowser({
      executablePath: "/chrome",
      userDataDir: "/profile",
    });

    const port = Number(new URL(result.cdpUrl).port);

    expect(result.context).toBe(fake.context);
    expect(result.cdpUrl).toBe(createCdpUrl(port));
    expect(port).not.toBe(9222);
    expect(launchPersistentContext).toHaveBeenCalledTimes(1);

    expect(launchPersistentContext).toHaveBeenCalledWith(
      "/profile",
      expect.objectContaining({
        executablePath: "/chrome",
        headless: false,
        timeout: 30_000,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        args: expect.arrayContaining([
          `--remote-debugging-port=${port}`,
          "--remote-allow-origins=*",
          "--enable-unsafe-extension-debugging",
        ]),
        ignoreDefaultArgs: ["--disable-extensions"],
      }),
    );
  });

  it("closes the partial context when CDP readiness fails", async () => {
    const fake = createFakeContext();
    launchPersistentContext.mockResolvedValue(fake.context);

    await expect(
      launchBrowserWithDependencies(
        { executablePath: "/chrome", userDataDir: "/profile" },
        {
          allocateCdpPort: async () => 54321,
          waitForCdpReady: async () => {
            throw new Error("CDP endpoint is not ready after 5000 ms.");
          },
        },
      ),
    ).rejects.toThrow("CDP endpoint is not ready");

    expect(fake.closeCalls).toBe(1);
  });
});
