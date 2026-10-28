import type { BrowserPage, BrowserSessionContext } from "./browser-launcher";

const DEFAULT_TIMEOUT_MS = 2_000;
const MAX_WIDTH = 640;
const JPEG_QUALITY = 60;

type CdpSession = {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  detach(): Promise<void>;
};

type CdpCapableContext = {
  newCDPSession(page: BrowserPage): Promise<unknown>;
};

type ViewportSize = {
  readonly width: number;
  readonly height: number;
};

export type ThumbnailInput = {
  readonly context: BrowserSessionContext;
  readonly page: BrowserPage;
  readonly timeoutMs?: number;
};

function hasFunction(target: object, key: string): boolean {
  return typeof Reflect.get(target, key) === "function";
}

function isCdpCapableContext(
  context: BrowserSessionContext,
): context is BrowserSessionContext & CdpCapableContext {
  return hasFunction(context, "newCDPSession");
}

function isCdpSession(value: unknown): value is CdpSession {
  return (
    typeof value === "object" &&
    value !== null &&
    hasFunction(value, "send") &&
    hasFunction(value, "detach")
  );
}

function readViewport(value: unknown): ViewportSize | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const metrics = Reflect.get(value, "cssLayoutViewport");
  if (typeof metrics !== "object" || metrics === null) {
    return null;
  }

  const width = Reflect.get(metrics, "clientWidth");
  const height = Reflect.get(metrics, "clientHeight");

  if (
    typeof width !== "number" ||
    !Number.isFinite(width) ||
    width <= 0 ||
    typeof height !== "number" ||
    !Number.isFinite(height) ||
    height <= 0
  ) {
    return null;
  }

  return { width, height };
}

function readScreenshot(value: unknown): string | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const data = Reflect.get(value, "data");
  return typeof data === "string" && data.length > 0 ? data : null;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new Error(`Thumbnail capture timed out after ${timeoutMs} ms.`));
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

async function capture(
  context: BrowserSessionContext,
  page: BrowserPage,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!isCdpCapableContext(context)) {
    throw new Error("CDP session is unavailable.");
  }

  const session = await context.newCDPSession(page);
  if (!isCdpSession(session)) {
    throw new Error("CDP session is invalid.");
  }

  try {
    const viewport = readViewport(await session.send("Page.getLayoutMetrics"));
    if (viewport === null) {
      throw new Error("Viewport metrics are unavailable.");
    }

    const scale = Math.min(1, MAX_WIDTH / viewport.width);
    const screenshot = await session.send("Page.captureScreenshot", {
      format: "jpeg",
      quality: JPEG_QUALITY,
      fromSurface: true,
      captureBeyondViewport: false,
      clip: {
        x: 0,
        y: 0,
        width: viewport.width,
        height: viewport.height,
        scale,
      },
    });
    const data = readScreenshot(screenshot);
    if (data === null) {
      throw new Error("Screenshot data is unavailable.");
    }

    return new Uint8Array(Buffer.from(data, "base64"));
  } finally {
    await session.detach().catch(() => undefined);
  }
}

export async function capturePageThumbnail(
  input: ThumbnailInput,
): Promise<Uint8Array<ArrayBuffer>> {
  return withTimeout(
    capture(input.context, input.page),
    input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
}
