import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CDP_CLOSE_TIMEOUTS_MS,
  CLOSE_BUDGET_MS,
  CLOSE_STEP_TIMEOUTS_MS,
  cdpCloseBudgetTotalMs,
  closeBudgetTotalMs,
  createCdpLaunchArguments,
  launchBrowserWithDependencies,
  type BrowserPage,
  type BrowserSessionContext,
  type PlaywrightBrowser,
} from "./browser-launcher";
import type { CdpPipe, CdpPipeLaunchOptions, CdpWireMessage } from "./cdp-pipe";
import type { CdpGateway, CdpGatewayOptions } from "./cdp-gateway";
import type { FingerprintHardening, FingerprintHardeningOptions } from "./browser-stealth";
import type { ConnectOverCDPTransport } from "playwright-core";
import { capturePageThumbnail } from "./thumbnail";

type FakePipe = {
  readonly pipe: CdpPipe;
  readonly sent: CdpWireMessage[];
  readonly closeCalls: () => number;
  emitClose(): void;
};

function createFakePipe(): FakePipe {
  const messageListeners = new Set<(message: CdpWireMessage) => void>();
  const closeListeners = new Set<(error?: Error) => void>();
  const sent: CdpWireMessage[] = [];
  let closeCalls = 0;
  let isClosed = false;
  let closePromise: Promise<void> | null = null;

  const notifyClose = (error?: Error): void => {
    if (isClosed) {
      return;
    }
    isClosed = true;
    for (const listener of closeListeners) {
      listener(error);
    }
  };

  const pipe: CdpPipe = {
    pid: 4242,
    send(message) {
      sent.push(message);
      if (message.method === "Target.attachToBrowserTarget" && typeof message.id === "number") {
        const id = message.id;
        queueMicrotask(() => {
          if (isClosed) {
            return;
          }
          for (const listener of messageListeners) {
            listener({ id, result: { sessionId: `browser-${id}` } });
          }
        });
      }
    },
    onMessage(listener) {
      messageListeners.add(listener);
    },
    onClose(listener) {
      closeListeners.add(listener);
    },
    close() {
      closePromise ??= (async () => {
        closeCalls += 1;
        notifyClose();
      })();
      return closePromise;
    },
  };

  return {
    pipe,
    sent,
    closeCalls: () => closeCalls,
    emitClose() {
      notifyClose(new Error("CDP pipe closed."));
    },
  };
}

function createFakePage(): BrowserPage {
  return {
    goto: async () => undefined,
    url: () => "about:blank",
    locator: () => ({
      click: async () => undefined,
      fill: async () => undefined,
      innerText: async () => "",
    }),
  };
}

type FakeContext = BrowserSessionContext & {
  readonly closeCalls: () => number;
  readonly newPageCalls: () => number;
};

function createFakeContext(): FakeContext {
  const listeners: Array<() => void> = [];
  const pages: BrowserPage[] = [createFakePage()];
  let closeCalls = 0;
  let newPageCalls = 0;

  const context: FakeContext = {
    closeCalls: () => closeCalls,
    newPageCalls: () => newPageCalls,
    async close() {
      closeCalls += 1;
      for (const listener of listeners) {
        listener();
      }
    },
    on(_event, listener) {
      listeners.push(listener);
    },
    pages: () => pages,
    async newPage() {
      newPageCalls += 1;
      const page = createFakePage();
      pages.push(page);
      return page;
    },
    async cookies() {
      return [];
    },
    async addCookies() {
      return undefined;
    },
  };

  return context;
}

type FakeBrowser = PlaywrightBrowser & {
  readonly context: FakeContext;
  readonly closeCalls: () => number;
};

function createFakeBrowser(context: FakeContext = createFakeContext()): FakeBrowser {
  let closeCalls = 0;
  return {
    context,
    closeCalls: () => closeCalls,
    contexts: () => [context],
    async close() {
      closeCalls += 1;
    },
  };
}

function createFakeGateway(port = 54321): CdpGateway {
  return {
    port,
    httpUrl: `http://127.0.0.1:${port}`,
    webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/test?token=capability`,
    capabilityToken: "capability",
    async close() {
      return undefined;
    },
  };
}

type Harness = {
  readonly spawnOptions: CdpPipeLaunchOptions[];
  readonly gatewayOptions: CdpGatewayOptions[];
  readonly installOptions: FingerprintHardeningOptions[];
  readonly connectCalls: ConnectOverCDPTransport[];
  readonly pipe: FakePipe;
  readonly browser: FakeBrowser;
  readonly hardening: FingerprintHardening & { readonly close: ReturnType<typeof vi.fn> };
  readonly gateway: CdpGateway;
  readonly events: string[];
  readonly launch: () => ReturnType<typeof launchBrowserWithDependencies>;
};

function createHarness(
  overrides: {
    readonly connectBrowser?: (transport: ConnectOverCDPTransport) => Promise<PlaywrightBrowser>;
    readonly startGateway?: (options: CdpGatewayOptions) => Promise<CdpGateway>;
    readonly spawnChrome?: (options: CdpPipeLaunchOptions) => Promise<CdpPipe>;
    readonly installFingerprintHardening?: (
      options: FingerprintHardeningOptions,
      dependencies?: unknown,
    ) => Promise<FingerprintHardening>;
    readonly newCDPSession?: (page: BrowserPage) => Promise<unknown>;
  } = {},
): Harness {
  const spawnOptions: CdpPipeLaunchOptions[] = [];
  const gatewayOptions: CdpGatewayOptions[] = [];
  const installOptions: FingerprintHardeningOptions[] = [];
  const connectCalls: ConnectOverCDPTransport[] = [];
  const events: string[] = [];
  const pipe = createFakePipe();
  pipe.pipe.onClose(() => events.push("pipe-close"));
  const context = createFakeContext();
  if (overrides.newCDPSession !== undefined) {
    context.newCDPSession = overrides.newCDPSession;
  }
  const browser = createFakeBrowser(context);
  const hardening = {
    close: vi.fn(async () => {
      events.push("hardening-close");
    }),
  };
  const gateway: CdpGateway = {
    ...createFakeGateway(),
    async close() {
      events.push("gateway-close");
    },
  };

  return {
    spawnOptions,
    gatewayOptions,
    installOptions,
    connectCalls,
    pipe,
    browser,
    hardening,
    gateway,
    events,
    launch: () =>
      launchBrowserWithDependencies(
        { executablePath: "/chrome", userDataDir: "/profile", profileId: "p_aaaaaaaaaaaaaaaa" },
        {
          spawnChrome: async (options) => {
            spawnOptions.push(options);
            if (overrides.spawnChrome !== undefined) {
              return await overrides.spawnChrome(options);
            }
            return pipe.pipe;
          },
          connectBrowser: async (transport) => {
            connectCalls.push(transport);
            if (overrides.connectBrowser !== undefined) {
              return await overrides.connectBrowser(transport);
            }
            return browser;
          },
          startGateway: async (options) => {
            gatewayOptions.push(options);
            if (overrides.startGateway !== undefined) {
              return await overrides.startGateway(options);
            }
            return gateway;
          },
          installFingerprintHardening: async (options, dependencies) => {
            installOptions.push(options);
            if (overrides.installFingerprintHardening !== undefined) {
              return await overrides.installFingerprintHardening(options, dependencies);
            }
            return hardening;
          },
        },
      ),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createCdpLaunchArguments", () => {
  it("never opens a TCP debugging port", () => {
    const args = createCdpLaunchArguments();

    expect(args).toContain("--enable-unsafe-extension-debugging");
    expect(args).toContain("--disable-blink-features=AutomationControlled");
    expect(args.some((arg) => arg.startsWith("--remote-debugging-port"))).toBe(false);
    expect(args).not.toContain("--remote-allow-origins=*");
    expect(args).not.toContain("--enable-automation");
  });
});

describe("launchBrowserWithDependencies", () => {
  it("spawns Chrome with the pipe transport and no TCP debugging flags", async () => {
    const harness = createHarness();

    await harness.launch();

    expect(harness.spawnOptions).toEqual([
      {
        executablePath: "/chrome",
        userDataDir: "/profile",
        args: createCdpLaunchArguments(),
        browserCloseTimeoutMs: expect.any(Number),
        terminateTimeoutMs: expect.any(Number),
        killTimeoutMs: expect.any(Number),
      },
    ]);
    const args = harness.spawnOptions[0]?.args ?? [];
    expect(args.some((arg) => arg.startsWith("--remote-debugging-port"))).toBe(false);
    expect(args).not.toContain("--remote-allow-origins=*");
  });

  it("connects Playwright through the router and exposes a usable context", async () => {
    const harness = createHarness();

    const result = await harness.launch();

    expect(harness.connectCalls).toHaveLength(1);
    expect(result.context.pages()).toHaveLength(1);
    await expect(result.context.newPage()).resolves.toBeDefined();
    expect(harness.browser.context.newPageCalls()).toBe(1);
    expect(result.pid).toBe(4242);
    expect(harness.gatewayOptions).toHaveLength(1);
    expect(harness.gatewayOptions[0]?.router).toBeDefined();
  });

  it("forwards newCDPSession to the original context", async () => {
    const session = { send: vi.fn(), detach: vi.fn() };
    let receivedThis: unknown;
    const newCDPSession = vi.fn(function (this: unknown) {
      receivedThis = this;
      return Promise.resolve(session);
    });
    const harness = createHarness({ newCDPSession });
    const result = await harness.launch();
    const page = result.context.pages()[0];
    if (page === undefined) {
      throw new Error("Fake page is missing.");
    }
    const forwarded = result.context.newCDPSession;
    if (forwarded === undefined) {
      throw new Error("newCDPSession was not forwarded.");
    }

    await expect(forwarded.call(result.context, page)).resolves.toBe(session);
    expect(newCDPSession).toHaveBeenCalledWith(page);
    expect(receivedThis).toBe(harness.browser.context);
  });

  it("does not add newCDPSession when the original context lacks it", async () => {
    const harness = createHarness();
    const result = await harness.launch();
    const page = result.context.pages()[0];
    if (page === undefined) {
      throw new Error("Fake page is missing.");
    }

    expect(result.context).not.toHaveProperty("newCDPSession");
    await expect(capturePageThumbnail({ context: result.context, page })).rejects.toThrow(
      "CDP session is unavailable.",
    );
  });

  it("rejects newCDPSession after the managed context closes", async () => {
    const newCDPSession = vi.fn(() => new Promise<unknown>(() => undefined));
    const harness = createHarness({ newCDPSession });
    const result = await harness.launch();
    const page = result.context.pages()[0];
    if (page === undefined) {
      throw new Error("Fake page is missing.");
    }
    await result.context.close();
    const forwarded = result.context.newCDPSession;
    if (forwarded === undefined) {
      throw new Error("newCDPSession was not forwarded.");
    }

    await expect(forwarded(page)).rejects.toThrow("Browser context is closed.");
    expect(newCDPSession).not.toHaveBeenCalled();
  });

  it("starts the gateway with a unique bearer token that never enters cdpUrl", async () => {
    const first = createHarness();
    const second = createHarness();

    const firstResult = await first.launch();
    const secondResult = await second.launch();

    const firstToken = first.gatewayOptions[0]?.apiToken ?? "";
    const secondToken = second.gatewayOptions[0]?.apiToken ?? "";

    expect(firstToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(secondToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(firstToken).not.toBe(secondToken);
    expect(firstResult.credentials.bearerToken).toBe(firstToken);
    expect(firstResult.cdpUrl).toBe(firstResult.credentials.gatewayUrl);
    expect(firstResult.cdpUrl).not.toContain(firstToken);
    expect(firstResult.credentials.extensionCdpUrl).toBe(
      first.gateway.webSocketDebuggerUrl,
    );
  });

  it("installs fingerprint hardening through an in-process router transport", async () => {
    const harness = createHarness();

    await harness.launch();

    expect(harness.installOptions).toHaveLength(1);
    expect(harness.installOptions[0]).toEqual({
      profile: expect.objectContaining({ key: "p_aaaaaaaaaaaaaaaa" }),
    });
    expect(harness.installOptions[0]).not.toHaveProperty("cdpUrl");
  });

  it("closes the context, router, gateway, and pipe in order", async () => {
    const harness = createHarness();
    const result = await harness.launch();

    harness.browser.context.on("close", () => harness.events.push("context-close"));
    await result.context.close();

    expect(harness.browser.context.closeCalls()).toBe(1);
    expect(harness.hardening.close).toHaveBeenCalledTimes(1);
    expect(harness.browser.closeCalls()).toBe(1);
    expect(harness.pipe.closeCalls()).toBeGreaterThanOrEqual(1);
    expect(harness.events.indexOf("context-close")).toBeGreaterThanOrEqual(0);
    expect(harness.events.indexOf("pipe-close")).toBeGreaterThanOrEqual(0);
    expect(harness.events.indexOf("pipe-close")).toBeGreaterThan(
      harness.events.indexOf("gateway-close"),
    );
    expect(harness.events.indexOf("gateway-close")).toBeGreaterThan(
      harness.events.indexOf("context-close"),
    );
  });

  it("cleans up Chrome and the router when Playwright cannot connect", async () => {
    const harness = createHarness({
      connectBrowser: async () => {
        throw new Error("Playwright connection failed.");
      },
    });

    await expect(harness.launch()).rejects.toThrow("Playwright connection failed");

    expect(harness.gatewayOptions).toHaveLength(0);
    expect(harness.pipe.closeCalls()).toBeGreaterThanOrEqual(1);
    expect(harness.hardening.close).not.toHaveBeenCalled();
  });

  it("cleans up Chrome, router, and context when the gateway fails to start", async () => {
    const harness = createHarness({
      startGateway: async () => {
        throw new Error("Gateway failed.");
      },
    });

    await expect(harness.launch()).rejects.toThrow("Gateway failed");

    expect(harness.hardening.close).toHaveBeenCalledTimes(1);
    expect(harness.browser.closeCalls()).toBe(1);
    expect(harness.pipe.closeCalls()).toBeGreaterThanOrEqual(1);
  });

  it("closes the returned context exactly once when the pipe closes", async () => {
    const harness = createHarness();
    const result = await harness.launch();
    let closeEvents = 0;
    result.context.on("close", () => {
      closeEvents += 1;
    });

    harness.pipe.emitClose();
    harness.pipe.emitClose();

    await vi.waitFor(() => {
      expect(closeEvents).toBe(1);
    });
    expect(harness.events).toContain("gateway-close");
  });

  it("keeps the whole close sequence inside the eight second budget", () => {
    expect(closeBudgetTotalMs() + CLOSE_STEP_TIMEOUTS_MS.context).toBeLessThanOrEqual(
      CLOSE_BUDGET_MS,
    );
    expect(cdpCloseBudgetTotalMs()).toBeLessThanOrEqual(
      CLOSE_STEP_TIMEOUTS_MS.router + CLOSE_STEP_TIMEOUTS_MS.pipe,
    );
    expect(CDP_CLOSE_TIMEOUTS_MS).toEqual({
      browserClose: 1_500,
      terminate: 500,
      kill: 500,
    });
    expect(CLOSE_BUDGET_MS).toBe(8_000);
  });

  it("resolves close inside the budget when the context and pipe never respond", async () => {
    vi.useFakeTimers();
    try {
      const fake = createFakePipe();
      let pipeCloseCalls = 0;
      const hangingPipe: CdpPipe = {
        ...fake.pipe,
        close() {
          pipeCloseCalls += 1;
          return new Promise<void>(() => undefined);
        },
      };
      const harness = createHarness({
        spawnChrome: async () => hangingPipe,
      });
      const result = await harness.launch();
      let closeEvents = 0;
      result.context.on("close", () => {
        closeEvents += 1;
      });

      const closing = result.context.close();
      await vi.advanceTimersByTimeAsync(CLOSE_BUDGET_MS);
      await expect(closing).resolves.toBeUndefined();

      expect(pipeCloseCalls).toBeGreaterThanOrEqual(1);
      expect(closeEvents).toBe(1);
      await expect(result.context.close()).resolves.toBeUndefined();
      expect(closeEvents).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
