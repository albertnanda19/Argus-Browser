import { describe, expect, it, vi } from "vitest";
import type { BrowserPage, BrowserSessionContext } from "./browser-launcher";
import { capturePageThumbnail } from "./thumbnail";

const page: BrowserPage = {
  goto: async () => undefined,
  url: () => "https://example.test/",
  locator: () => ({
    click: async () => undefined,
    fill: async () => undefined,
    innerText: async () => "",
  }),
};

function createContext(
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
  detach = vi.fn(async () => undefined),
): BrowserSessionContext & {
  readonly detach: typeof detach;
  readonly newCDPSession: ReturnType<typeof vi.fn>;
} {
  return {
    close: async () => undefined,
    on: () => undefined,
    pages: () => [page],
    newPage: async () => page,
    newCDPSession: vi.fn(async () => ({ send, detach })),
    detach,
  };
}

describe("capturePageThumbnail", () => {
  it("captures a viewport JPEG scaled to at most 640 px", async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const context = createContext(async (method, params) => {
      calls.push({ method, params });
      if (method === "Page.getLayoutMetrics") {
        return { cssLayoutViewport: { clientWidth: 1280, clientHeight: 720 } };
      }
      return { data: Buffer.from([0xff, 0xd8, 0xff]).toString("base64") };
    });

    const result = await capturePageThumbnail({ context, page });

    expect(result).toEqual(new Uint8Array([0xff, 0xd8, 0xff]));
    expect(calls).toEqual([
      { method: "Page.getLayoutMetrics", params: undefined },
      {
        method: "Page.captureScreenshot",
        params: {
          format: "jpeg",
          quality: 60,
          fromSurface: true,
          captureBeyondViewport: false,
          clip: { x: 0, y: 0, width: 1280, height: 720, scale: 0.5 },
        },
      },
    ]);
    expect(context.detach).toHaveBeenCalledTimes(1);
  });

  it("keeps a narrow viewport at its original scale", async () => {
    const context = createContext(async (method) => {
      if (method === "Page.getLayoutMetrics") {
        return { cssLayoutViewport: { clientWidth: 400, clientHeight: 300 } };
      }
      return { data: Buffer.from([0xff]).toString("base64") };
    });

    await capturePageThumbnail({ context, page });

    expect(context.newCDPSession).toHaveBeenCalledWith(page);
  });

  it("detaches the CDP session when capture fails", async () => {
    const context = createContext(async () => {
      throw new Error("CDP failed.");
    });

    await expect(capturePageThumbnail({ context, page })).rejects.toThrow("CDP failed.");
    expect(context.detach).toHaveBeenCalledTimes(1);
  });

  it("rejects when the context has no CDP session", async () => {
    const context: BrowserSessionContext = {
      close: async () => undefined,
      on: () => undefined,
      pages: () => [page],
      newPage: async () => page,
    };

    await expect(capturePageThumbnail({ context, page })).rejects.toThrow(
      "CDP session is unavailable.",
    );
  });

  it("rejects after the capture timeout", async () => {
    vi.useFakeTimers();
    const context = createContext(async (method) => {
      if (method === "Page.getLayoutMetrics") {
        return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } };
      }
      return await new Promise<unknown>(() => undefined);
    });

    const capture = capturePageThumbnail({ context, page, timeoutMs: 2_000 });
    const assertion = expect(capture).rejects.toThrow("Thumbnail capture timed out");

    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    vi.useRealTimers();
  });
});
