import { randomBytes } from "node:crypto";
import type { ConnectOverCDPTransport } from "playwright-core";
import {
  createFingerprintProfile,
  installFingerprintHardening,
  type CdpTransport,
  type FingerprintHardening,
  type FingerprintHardeningDependencies,
  type FingerprintHardeningOptions,
} from "./browser-stealth";
import {
  launchCdpPipe,
  type CdpPipe,
  type CdpPipeLaunchOptions,
  type CdpWireMessage,
} from "./cdp-pipe";
import {
  createCdpRouter,
  type CdpClientSink,
  type CdpRouter,
  type CdpRouterClient,
} from "./cdp-router";
import {
  startCdpGateway,
  type CdpGateway,
  type CdpGatewayOptions,
} from "./cdp-gateway";

const CONNECT_TIMEOUT_MS = 30_000;

export const CLOSE_BUDGET_MS = 8_000;
export const CLOSE_STEP_TIMEOUTS_MS = {
  context: 1_000,
  hardening: 400,
  hardeningClient: 200,
  playwrightClient: 200,
  browser: 400,
  router: 2_700,
  gateway: 600,
  pipe: 300,
} as const;
export const CDP_CLOSE_TIMEOUTS_MS = {
  browserClose: 1_500,
  terminate: 500,
  kill: 500,
} as const;

export function closeBudgetTotalMs(): number {
  return Object.values(CLOSE_STEP_TIMEOUTS_MS).reduce(
    (total, timeoutMs) => total + timeoutMs,
    0,
  );
}

export function cdpCloseBudgetTotalMs(): number {
  return Object.values(CDP_CLOSE_TIMEOUTS_MS).reduce(
    (total, timeoutMs) => total + timeoutMs,
    0,
  );
}

export type BrowserLocator = {
  click(options: { readonly timeout: number }): Promise<void>;
  fill(text: string, options: { readonly timeout: number }): Promise<void>;
  innerText(options: { readonly timeout: number }): Promise<string>;
};

export type BrowserPage = {
  goto(
    url: string,
    options: {
      readonly timeout: number;
      readonly waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit";
    },
  ): Promise<unknown>;
  url(): string;
  locator(selector: string): BrowserLocator;
  evaluate?(pageFunction: () => unknown): Promise<unknown>;
  waitForLoadState?(
    state: "networkidle",
    options?: { readonly timeout?: number },
  ): Promise<void>;
};

export type BrowserCookie = {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly expires: number;
};

export type BrowserCookieParam = {
  readonly name: string;
  readonly value: string;
  readonly url: string;
  readonly expires: number;
  readonly httpOnly?: boolean;
  readonly secure?: boolean;
  readonly sameSite?: "Strict" | "Lax" | "None";
};

export type BrowserSessionContext = {
  close(): Promise<void>;
  on(event: "close", listener: () => void): unknown;
  pages(): BrowserPage[];
  newPage(): Promise<BrowserPage>;
  cookies?(url: string): Promise<BrowserCookie[]>;
  addCookies?(cookies: readonly BrowserCookieParam[]): Promise<void>;
};

export type CdpCredentials = {
  readonly gatewayUrl: string;
  readonly bearerToken: string;
  readonly extensionCdpUrl: string;
};

export type LaunchBrowserOptions = {
  readonly executablePath: string;
  readonly userDataDir: string;
  readonly profileId?: string;
};

export type BrowserLaunchResult = {
  readonly context: BrowserSessionContext;
  readonly cdpUrl: string;
  readonly credentials: CdpCredentials;
  readonly pid: number;
};

export type LaunchBrowser = (options: LaunchBrowserOptions) => Promise<BrowserLaunchResult>;

export type PlaywrightBrowser = {
  contexts(): readonly BrowserSessionContext[];
  close(): Promise<void>;
};

export type LaunchBrowserDependencies = {
  readonly spawnChrome?: (options: CdpPipeLaunchOptions) => Promise<CdpPipe>;
  readonly connectBrowser?: (
    transport: ConnectOverCDPTransport,
  ) => Promise<PlaywrightBrowser>;
  readonly installFingerprintHardening?: (
    options: FingerprintHardeningOptions,
    dependencies?: FingerprintHardeningDependencies,
  ) => Promise<FingerprintHardening>;
  readonly startGateway?: (options: CdpGatewayOptions) => Promise<CdpGateway>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new Error(`Timed out after ${timeoutMs} ms.`));
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

async function closeWithTimeout(
  promise: Promise<unknown> | undefined,
  timeoutMs: number,
): Promise<void> {
  if (promise === undefined) {
    return;
  }
  try {
    await withTimeout(promise, timeoutMs);
  } catch {
    return;
  }
}

export function createCdpLaunchArguments(): readonly string[] {
  return [
    "--enable-unsafe-extension-debugging",
    "--disable-blink-features=AutomationControlled",
  ];
}

function toWireCommand(message: unknown): CdpWireMessage {
  if (
    !isRecord(message) ||
    typeof message.id !== "number" ||
    typeof message.method !== "string"
  ) {
    throw new Error("CDP command is invalid.");
  }
  const params = message.params;
  const sessionId = message.sessionId;
  if (sessionId !== undefined && typeof sessionId !== "string") {
    throw new Error("CDP command is invalid.");
  }
  return {
    id: message.id,
    method: message.method,
    ...(params === undefined ? {} : { params }),
    ...(sessionId === undefined ? {} : { sessionId }),
  };
}

async function connectPlaywright(
  router: CdpRouter,
  connectBrowser: (transport: ConnectOverCDPTransport) => Promise<PlaywrightBrowser>,
): Promise<{ readonly browser: PlaywrightBrowser; readonly client: CdpRouterClient }> {
  let client: CdpRouterClient | null = null;
  const transport: ConnectOverCDPTransport = {
    send(message) {
      if (client === null) {
        throw new Error("Playwright CDP client is not ready.");
      }
      client.send(toWireCommand(message));
    },
    close() {
      if (client !== null) {
        void client.close();
      }
    },
  };
  const sink: CdpClientSink = {
    send(message) {
      transport.onmessage?.(message);
      return true;
    },
    close() {
      transport.onclose?.("closed");
    },
  };

  client = await router.addClient(sink);
  try {
    const browser = await connectBrowser(transport);
    return { browser, client };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

async function connectHardening(
  router: CdpRouter,
  profile: ReturnType<typeof createFingerprintProfile>,
  install: (
    options: FingerprintHardeningOptions,
    dependencies?: FingerprintHardeningDependencies,
  ) => Promise<FingerprintHardening>,
): Promise<{ readonly hardening: FingerprintHardening; readonly client: CdpRouterClient }> {
  const messageListeners = new Set<(message: unknown) => void>();
  const closeListeners = new Set<() => void>();
  let client: CdpRouterClient | null = null;
  const transport: CdpTransport = {
    send(message) {
      if (client === null) {
        throw new Error("Fingerprint CDP client is not ready.");
      }
      client.send(toWireCommand(message));
    },
    close() {
      if (client !== null) {
        void client.close();
      }
    },
    onMessage(listener) {
      messageListeners.add(listener);
    },
    onClose(listener) {
      closeListeners.add(listener);
    },
  };
  const sink: CdpClientSink = {
    send(message) {
      for (const listener of messageListeners) {
        listener(message);
      }
      return true;
    },
    close() {
      for (const listener of closeListeners) {
        listener();
      }
    },
  };

  client = await router.addClient(sink);
  try {
    const hardening = await install(
      { profile },
      {
        fetchVersion: async () => ({
          webSocketDebuggerUrl: "in-process://cdp-router",
        }),
        connect: async () => transport,
      },
    );
    return { hardening, client };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

function createManagedContext(
  context: BrowserSessionContext,
  cleanup: () => Promise<void>,
  initiallyClosed: boolean,
): { readonly context: BrowserSessionContext; readonly notifyClose: () => void } {
  const listeners = new Set<() => void>();
  const cookies = context.cookies?.bind(context);
  const addCookies = context.addCookies?.bind(context);
  let isClosed = initiallyClosed;
  let closePromise: Promise<void> | null = null;

  const notifyClose = (): void => {
    if (isClosed) {
      return;
    }
    isClosed = true;
    for (const listener of listeners) {
      listener();
    }
  };

  context.on("close", () => {
    void cleanup().finally(notifyClose);
  });

  const managedContext: BrowserSessionContext = {
    close() {
      closePromise ??= (async () => {
        try {
          await withTimeout(context.close(), CLOSE_STEP_TIMEOUTS_MS.context);
        } catch (error) {
          console.warn(
            `Browser context close failed: ${error instanceof Error ? error.name : "unknown"}`,
          );
        } finally {
          await closeWithTimeout(cleanup(), closeBudgetTotalMs() + 250);
          notifyClose();
        }
      })();
      return closePromise;
    },
    on(_event, listener) {
      if (isClosed) {
        listener();
        return;
      }
      listeners.add(listener);
    },
    pages() {
      return context.pages();
    },
    newPage() {
      return context.newPage();
    },
    ...(cookies === undefined ? {} : { cookies }),
    ...(addCookies === undefined ? {} : { addCookies }),
  };

  return { context: managedContext, notifyClose };
}

export async function launchBrowserWithDependencies(
  options: LaunchBrowserOptions,
  dependencies: LaunchBrowserDependencies = {},
): Promise<BrowserLaunchResult> {
  const spawnChrome = dependencies.spawnChrome ?? launchCdpPipe;
  const install = dependencies.installFingerprintHardening ?? installFingerprintHardening;
  const startGateway = dependencies.startGateway ?? startCdpGateway;
  const pipe = await spawnChrome({
    executablePath: options.executablePath,
    userDataDir: options.userDataDir,
    args: createCdpLaunchArguments(),
    browserCloseTimeoutMs: CDP_CLOSE_TIMEOUTS_MS.browserClose,
    terminateTimeoutMs: CDP_CLOSE_TIMEOUTS_MS.terminate,
    killTimeoutMs: CDP_CLOSE_TIMEOUTS_MS.kill,
  });
  const router = createCdpRouter(pipe);
  const bearerToken = randomBytes(32).toString("base64url");
  const profile = createFingerprintProfile(options.profileId ?? options.userDataDir);

  let playwrightClient: CdpRouterClient | null = null;
  let hardeningClient: CdpRouterClient | null = null;
  let browser: PlaywrightBrowser | null = null;
  let hardening: FingerprintHardening | null = null;
  let gateway: CdpGateway | null = null;
  let context: BrowserSessionContext | null = null;
  let cleanupPromise: Promise<void> | null = null;
  let isPipeClosed = false;

  const cleanup = (): Promise<void> => {
    cleanupPromise ??= (async () => {
      await closeWithTimeout(hardening?.close(), CLOSE_STEP_TIMEOUTS_MS.hardening);
      hardening = null;
      await closeWithTimeout(hardeningClient?.close(), CLOSE_STEP_TIMEOUTS_MS.hardeningClient);
      hardeningClient = null;
      await closeWithTimeout(playwrightClient?.close(), CLOSE_STEP_TIMEOUTS_MS.playwrightClient);
      playwrightClient = null;
      await closeWithTimeout(browser?.close(), CLOSE_STEP_TIMEOUTS_MS.browser);
      browser = null;
      await closeWithTimeout(gateway?.close(), CLOSE_STEP_TIMEOUTS_MS.gateway);
      gateway = null;
      await closeWithTimeout(router.close(), CLOSE_STEP_TIMEOUTS_MS.router);
      await closeWithTimeout(pipe.close(), CLOSE_STEP_TIMEOUTS_MS.pipe);
    })();
    return cleanupPromise;
  };

  pipe.onClose(() => {
    isPipeClosed = true;
    void cleanup();
  });

  try {
    const connected = await connectPlaywright(
      router,
      dependencies.connectBrowser ??
        (async (transport) => {
          const { chromium } = await import("playwright-core");
          return await chromium.connectOverCDP(transport, {
            timeout: CONNECT_TIMEOUT_MS,
          });
        }),
    );
    browser = connected.browser;
    playwrightClient = connected.client;

    const defaultContext = browser.contexts()[0];
    if (defaultContext === undefined) {
      throw new Error("Playwright did not expose a browser context.");
    }
    if (defaultContext.pages().length === 0) {
      await defaultContext.newPage();
    }
    context = defaultContext;

    const hardened = await connectHardening(router, profile, install);
    hardening = hardened.hardening;
    hardeningClient = hardened.client;

    gateway = await startGateway({ router, apiToken: bearerToken });
  } catch (error) {
    await cleanup();
    throw error;
  }

  if (context === null || gateway === null) {
    await cleanup();
    throw new Error("Browser launch did not complete.");
  }

  const managedContext = createManagedContext(context, cleanup, isPipeClosed);
  if (!isPipeClosed) {
    pipe.onClose(() => {
      void cleanup().finally(managedContext.notifyClose);
    });
  }

  return {
    context: managedContext.context,
    cdpUrl: gateway.httpUrl,
    credentials: {
      gatewayUrl: gateway.httpUrl,
      bearerToken,
      extensionCdpUrl: gateway.webSocketDebuggerUrl,
    },
    pid: pipe.pid,
  };
}

export const launchBrowser: LaunchBrowser = (options) =>
  launchBrowserWithDependencies(options);
