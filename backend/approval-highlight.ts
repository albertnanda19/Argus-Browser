import type { BrowserPage, BrowserSessionContext } from "./browser-launcher";

const DEFAULT_TIMEOUT_MS = 10_000;

export type ApprovalHighlightFailureReason =
  | "selector_missing"
  | "not_found"
  | "overlay_failed"
  | "timeout";

export type ApprovalHighlightSuccess = {
  readonly highlighted: true;
  clear(): Promise<void>;
};

export type ApprovalHighlightFailure = {
  readonly highlighted: false;
  readonly reason: ApprovalHighlightFailureReason;
};

export type ApprovalHighlightResult =
  | ApprovalHighlightSuccess
  | ApprovalHighlightFailure;

export type ApprovalHighlightOptions = {
  readonly context: BrowserSessionContext;
  readonly selector: string;
  readonly timeoutMs?: number;
};

type CdpSession = {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  detach(): Promise<void>;
};

type CdpCapableContext = {
  newCDPSession(page: BrowserPage): Promise<unknown>;
};

const HIGHLIGHT_CONFIG = {
  showInfo: true,
  showStyles: true,
  showRulers: true,
  contentColor: { r: 255, g: 214, b: 64, a: 0.35 },
  paddingColor: { r: 255, g: 165, b: 0, a: 0.25 },
  borderColor: { r: 255, g: 87, b: 34, a: 0.9 },
  marginColor: { r: 255, g: 87, b: 34, a: 0.15 },
} as const;

class HighlightTimeoutError extends Error {
  constructor() {
    super("Approval highlight operation timed out.");
    this.name = "HighlightTimeoutError";
  }
}

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

function readInteger(target: unknown, key: string): number | null {
  if (typeof target !== "object" || target === null) {
    return null;
  }
  const value = Reflect.get(target, key);
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function readRootNodeId(document: unknown): number | null {
  if (typeof document !== "object" || document === null) {
    return null;
  }
  const nodeId = readInteger(Reflect.get(document, "root"), "nodeId");
  return nodeId !== null && nodeId > 0 ? nodeId : null;
}

function readQueryNodeId(query: unknown): number | null {
  const nodeId = readInteger(query, "nodeId");
  return nodeId !== null && nodeId >= 0 ? nodeId : null;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new HighlightTimeoutError());
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

async function sendCommand(
  session: CdpSession,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
): Promise<unknown> {
  return await withTimeout(session.send(method, params), timeoutMs);
}

async function sendIgnoringFailure(
  session: CdpSession,
  method: string,
  timeoutMs: number,
): Promise<void> {
  try {
    await sendCommand(session, method, {}, timeoutMs);
  } catch {
    return;
  }
}

async function detachSafely(
  session: CdpSession,
  timeoutMs: number,
): Promise<void> {
  try {
    await withTimeout(session.detach(), timeoutMs);
  } catch {
    return;
  }
}

function createClear(
  session: CdpSession,
  timeoutMs: number,
): () => Promise<void> {
  let isCleared = false;

  return async (): Promise<void> => {
    if (isCleared) {
      return;
    }
    isCleared = true;

    try {
      await sendIgnoringFailure(session, "Overlay.hideHighlight", timeoutMs);
      await sendIgnoringFailure(session, "Overlay.disable", timeoutMs);
    } finally {
      await detachSafely(session, timeoutMs);
    }
  };
}

export async function highlightApprovalElement(
  options: ApprovalHighlightOptions,
): Promise<ApprovalHighlightResult> {
  if (options.selector.trim().length === 0) {
    return { highlighted: false, reason: "selector_missing" };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let session: CdpSession | null = null;
  let shouldKeepSession = false;

  try {
    const page = options.context.pages().at(-1);
    if (page === undefined || !isCdpCapableContext(options.context)) {
      return { highlighted: false, reason: "overlay_failed" };
    }

    const rawSession = await withTimeout(
      options.context.newCDPSession(page),
      timeoutMs,
    );
    if (!isCdpSession(rawSession)) {
      return { highlighted: false, reason: "overlay_failed" };
    }

    const activeSession = rawSession;
    session = activeSession;

    const document = await sendCommand(
      activeSession,
      "DOM.getDocument",
      { depth: 1 },
      timeoutMs,
    );
    const rootNodeId = readRootNodeId(document);
    if (rootNodeId === null) {
      return { highlighted: false, reason: "overlay_failed" };
    }

    const query = await sendCommand(
      activeSession,
      "DOM.querySelector",
      { nodeId: rootNodeId, selector: options.selector },
      timeoutMs,
    );
    const nodeId = readQueryNodeId(query);
    if (nodeId === null) {
      return { highlighted: false, reason: "overlay_failed" };
    }
    if (nodeId === 0) {
      return { highlighted: false, reason: "not_found" };
    }

    await sendCommand(activeSession, "Overlay.enable", {}, timeoutMs);
    await sendCommand(
      activeSession,
      "Overlay.highlightNode",
      { highlightConfig: HIGHLIGHT_CONFIG, nodeId },
      timeoutMs,
    );

    shouldKeepSession = true;
    return {
      highlighted: true,
      clear: createClear(activeSession, timeoutMs),
    };
  } catch (error) {
    return {
      highlighted: false,
      reason:
        error instanceof HighlightTimeoutError ? "timeout" : "overlay_failed",
    };
  } finally {
    if (session !== null && !shouldKeepSession) {
      await detachSafely(session, timeoutMs);
    }
  }
}
