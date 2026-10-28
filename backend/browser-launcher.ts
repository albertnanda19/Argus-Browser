import { createServer } from "node:net";
import type { BrowserContext } from "playwright-core";
import {
  createFingerprintProfile,
  installFingerprintHardening,
  type FingerprintHardening,
  type FingerprintHardeningOptions,
} from "./browser-stealth";

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

export type BrowserSessionContext = {
  close(): Promise<void>;
  on(event: "close", listener: () => void): unknown;
  pages(): BrowserPage[];
  newPage(): Promise<BrowserPage>;
};

export type LaunchBrowserOptions = {
  readonly executablePath: string;
  readonly userDataDir: string;
  readonly profileId?: string;
};

export type BrowserLaunchResult = {
  readonly context: BrowserSessionContext;
  readonly cdpUrl: string;
};

export type LaunchBrowser = (options: LaunchBrowserOptions) => Promise<BrowserLaunchResult>;

export type CdpLaunchArguments = {
  readonly args: string[];
  readonly ignoreDefaultArgs: string[];
};

export type LaunchBrowserDependencies = {
  readonly allocateCdpPort?: () => Promise<number>;
  readonly waitForCdpReady?: (cdpUrl: string) => Promise<void>;
  readonly installFingerprintHardening?: (
    options: FingerprintHardeningOptions,
  ) => Promise<FingerprintHardening>;
};

const CDP_READY_TIMEOUT_MS = 5_000;
const CDP_PROBE_TIMEOUT_MS = 1_000;
const CDP_POLL_INTERVAL_MS = 100;
const CDP_CLOSE_TIMEOUT_MS = 5_000;

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

export function createCdpUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export function createCdpLaunchArguments(port: number): CdpLaunchArguments {
  return {
    args: [
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      "--remote-allow-origins=*",
      "--enable-unsafe-extension-debugging",
      "--disable-blink-features=AutomationControlled",
    ],
    ignoreDefaultArgs: ["--disable-extensions", "--enable-automation"],
  };
}

export async function allocateCdpPort(): Promise<number> {
  return await new Promise<number>((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        rejectPort(new Error("CDP port allocation returned no address."));
        return;
      }

      server.close((error) => {
        if (error !== undefined) {
          rejectPort(error);
          return;
        }
        resolvePort(address.port);
      });
    });
  });
}

async function probeCdp(cdpUrl: string, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetch(`${cdpUrl}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function waitForCdpReady(
  cdpUrl: string,
  probe: (url: string, timeoutMs: number) => Promise<boolean> = probeCdp,
): Promise<void> {
  const deadline = Date.now() + CDP_READY_TIMEOUT_MS;

  for (;;) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(`CDP endpoint is not ready after ${CDP_READY_TIMEOUT_MS} ms.`);
    }

    if (await probe(cdpUrl, Math.min(CDP_PROBE_TIMEOUT_MS, remainingMs))) {
      return;
    }

    const waitMs = deadline - Date.now();
    if (waitMs <= 0) {
      throw new Error(`CDP endpoint is not ready after ${CDP_READY_TIMEOUT_MS} ms.`);
    }

    await new Promise<void>((resolveDelay) => {
      setTimeout(resolveDelay, Math.min(CDP_POLL_INTERVAL_MS, waitMs));
    });
  }
}

export async function launchBrowserWithDependencies(
  options: LaunchBrowserOptions,
  dependencies: LaunchBrowserDependencies = {},
): Promise<BrowserLaunchResult> {
  const { chromium } = await import("playwright-core");
  const port = await (dependencies.allocateCdpPort ?? allocateCdpPort)();
  const cdpUrl = createCdpUrl(port);
  const launchArguments = createCdpLaunchArguments(port);
  const context: BrowserContext = await chromium.launchPersistentContext(options.userDataDir, {
    executablePath: options.executablePath,
    headless: false,
    timeout: 30_000,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    args: launchArguments.args,
    ignoreDefaultArgs: launchArguments.ignoreDefaultArgs,
  });

  try {
    await (dependencies.waitForCdpReady ?? waitForCdpReady)(cdpUrl);
    const hardening = await (dependencies.installFingerprintHardening ??
      installFingerprintHardening)({
      cdpUrl,
      profile: createFingerprintProfile(options.profileId ?? options.userDataDir),
    });
    context.on("close", () => {
      void hardening.close();
    });
  } catch (error) {
    await withTimeout(context.close(), CDP_CLOSE_TIMEOUT_MS).catch(() => undefined);
    throw error;
  }

  return { context, cdpUrl };
}

export const launchBrowser: LaunchBrowser = (options) =>
  launchBrowserWithDependencies(options);
