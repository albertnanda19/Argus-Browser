import type { BrowserContext } from "playwright-core";

export type BrowserLocator = {
  click(options: { readonly timeout: number }): Promise<void>;
  fill(text: string, options: { readonly timeout: number }): Promise<void>;
  innerText(options: { readonly timeout: number }): Promise<string>;
};

export type BrowserPage = {
  goto(url: string, options: { readonly timeout: number }): Promise<unknown>;
  url(): string;
  locator(selector: string): BrowserLocator;
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
};

export type LaunchBrowser = (options: LaunchBrowserOptions) => Promise<BrowserSessionContext>;

export const launchBrowser: LaunchBrowser = async (options) => {
  const { chromium } = await import("playwright-core");
  const context: BrowserContext = await chromium.launchPersistentContext(options.userDataDir, {
    executablePath: options.executablePath,
    headless: false,
    timeout: 30_000,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
  return context;
};
