import type { ProfilePolicy } from "../shared/profile-policy";
import type { BrowserLocator, BrowserPage, BrowserSessionContext } from "./browser-launcher";
import {
  planMousePath,
  planScrollDeltas,
  planTypingDelays,
  type MousePoint,
  type RandomSource,
} from "./human-like";

const ELEMENT_TIMEOUT_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const CLICK_OFFSET_RATIO = 0.25;
const CLICK_OFFSET_SPAN = 0.5;
const SELECT_ALL_MODIFIER = process.platform === "darwin" ? 4 : 2;

export type InputErrorCode =
  | "input_target_not_found"
  | "input_timeout"
  | "input_failed"
  | "input_cancelled";

const INPUT_ERROR_MESSAGES: Record<InputErrorCode, string> = {
  input_target_not_found: "Elemen tidak ditemukan atau aksi melewati batas waktu.",
  input_timeout: "Operasi input melewati batas waktu.",
  input_failed: "Input gagal dijalankan.",
  input_cancelled: "Input dibatalkan.",
};

export class InputError extends Error {
  readonly code: InputErrorCode;

  constructor(code: InputErrorCode) {
    super(INPUT_ERROR_MESSAGES[code]);
    this.name = "InputError";
    this.code = code;
  }
}

export type InputAction = {
  readonly method?: string;
  readonly selector?: string;
  readonly arguments?: readonly string[];
};

export type InputUnsupportedReason =
  | "method_missing"
  | "method_unsupported"
  | "selector_missing"
  | "text_missing";

export type InputExecutionResult =
  | { readonly status: "done"; readonly actionCount: 1 }
  | { readonly status: "unsupported"; readonly reason: InputUnsupportedReason };

export type InputExecutorOptions = {
  readonly context: BrowserSessionContext;
  readonly policy: ProfilePolicy;
  readonly random?: RandomSource;
  readonly timeoutMs?: number;
};

export type InputExecutor = {
  execute(action: InputAction, signal: AbortSignal): Promise<InputExecutionResult>;
};

type Viewport = {
  readonly width: number;
  readonly height: number;
};

type ElementBox = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

type CdpSession = {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  detach(): Promise<void>;
};

type CdpCapableContext = {
  newCDPSession(page: BrowserPage): Promise<unknown>;
};

type InputLocator = {
  scrollIntoViewIfNeeded(options: { readonly timeout: number }): Promise<void>;
  boundingBox(options: { readonly timeout: number }): Promise<ElementBox | null>;
  focus(options: { readonly timeout: number }): Promise<void>;
};

type ControlKey = {
  readonly key: string;
  readonly code: string;
  readonly windowsVirtualKeyCode: number;
  readonly text?: string;
};

const CONTROL_KEYS: Record<string, ControlKey> = {
  "\n": {
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    text: "\r",
  },
  "\r": {
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    text: "\r",
  },
  "\t": {
    key: "Tab",
    code: "Tab",
    windowsVirtualKeyCode: 9,
    text: "\t",
  },
  "\b": {
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
  },
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

function isInputLocator(
  locator: BrowserLocator,
): locator is BrowserLocator & InputLocator {
  return (
    hasFunction(locator, "scrollIntoViewIfNeeded") &&
    hasFunction(locator, "boundingBox") &&
    hasFunction(locator, "focus")
  );
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

function readValue(target: unknown, key: string): unknown {
  if (typeof target !== "object" || target === null) {
    return undefined;
  }
  return Reflect.get(target, key);
}

function readPositiveNumber(target: unknown, key: string): number | null {
  const value = readValue(target, key);
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value;
}

function randomFraction(random: RandomSource): number {
  const value = random();
  if (!Number.isFinite(value)) {
    return 0.5;
  }
  return Math.min(1, Math.max(0, value));
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }
  return Math.min(Math.max(value, minimum), maximum);
}

function clampPoint(point: MousePoint, viewport: Viewport): MousePoint {
  return {
    x: clamp(point.x, 0, viewport.width - 1),
    y: clamp(point.y, 0, viewport.height - 1),
  };
}

function pickInitialCursor(viewport: Viewport, random: RandomSource): MousePoint {
  return {
    x: randomFraction(random) * (viewport.width - 1),
    y: randomFraction(random) * (viewport.height - 1),
  };
}

function pickClickPoint(
  box: ElementBox,
  viewport: Viewport,
  random: RandomSource,
): MousePoint {
  const horizontalSpan = box.width * CLICK_OFFSET_RATIO;
  const verticalSpan = box.height * CLICK_OFFSET_RATIO;
  const offsetX = (randomFraction(random) * 2 - 1) * horizontalSpan;
  const offsetY = (randomFraction(random) * 2 - 1) * verticalSpan;
  const minimumX = box.x;
  const minimumY = box.y;
  const maximumX = Math.max(box.x, box.x + box.width - 1);
  const maximumY = Math.max(box.y, box.y + box.height - 1);
  const point: MousePoint = {
    x: clamp(box.x + box.width / 2 + offsetX, minimumX, maximumX),
    y: clamp(box.y + box.height / 2 + offsetY, minimumY, maximumY),
  };

  return clampPoint(point, viewport);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new InputError("input_cancelled");
  }
}

function toInputError(error: unknown): InputError {
  if (error instanceof InputError) {
    return error;
  }
  if (isTimeoutError(error)) {
    return new InputError("input_target_not_found");
  }
  return new InputError("input_failed");
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);

  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise<void>((resolvePromise, rejectPromise) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      rejectPromise(new InputError("input_cancelled"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolvePromise();
    }, ms);

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
  timeoutCode: InputErrorCode,
): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    if (signal.aborted) {
      rejectPromise(new InputError("input_cancelled"));
      return;
    }

    const onAbort = (): void => {
      clearTimeout(timer);
      rejectPromise(new InputError("input_cancelled"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      rejectPromise(new InputError(timeoutCode));
    }, timeoutMs);

    signal.addEventListener("abort", onAbort, { once: true });

    promise.then(
      (value) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolvePromise(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        rejectPromise(error);
      },
    );
  });
}

function normalizeSelector(selector: string | undefined): string | undefined {
  const trimmed = selector?.trim() ?? "";
  return trimmed.length === 0 ? undefined : trimmed;
}

function readTextArgument(action: InputAction): string | undefined {
  return action.arguments?.[0];
}

function unsupported(reason: InputUnsupportedReason): InputExecutionResult {
  return { status: "unsupported", reason };
}

function done(): InputExecutionResult {
  return { status: "done", actionCount: 1 };
}

class InputExecutorImpl implements InputExecutor {
  private readonly context: BrowserSessionContext;
  private readonly policy: ProfilePolicy;
  private readonly random: RandomSource;
  private readonly timeoutMs: number;
  private cursor: MousePoint | null = null;

  constructor(options: InputExecutorOptions) {
    this.context = options.context;
    this.policy = options.policy;
    this.random = options.random ?? Math.random;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async execute(
    action: InputAction,
    signal: AbortSignal,
  ): Promise<InputExecutionResult> {
    try {
      throwIfAborted(signal);
      return await this.run(action, signal);
    } catch (error) {
      throw toInputError(error);
    }
  }

  private async run(
    action: InputAction,
    signal: AbortSignal,
  ): Promise<InputExecutionResult> {
    const method = action.method?.trim() ?? "";
    if (method.length === 0) {
      return unsupported("method_missing");
    }

    switch (method) {
      case "click": {
        const selector = normalizeSelector(action.selector);
        if (selector === undefined) {
          return unsupported("selector_missing");
        }
        return await this.withSession(signal, (page, session) =>
          this.click(page, selector, session, signal),
        );
      }
      case "type":
      case "fill": {
        const selector = normalizeSelector(action.selector);
        if (selector === undefined) {
          return unsupported("selector_missing");
        }
        const text = readTextArgument(action);
        if (text === undefined) {
          return unsupported("text_missing");
        }
        return await this.withSession(signal, (page, session) =>
          this.type(page, selector, text, method === "fill", session, signal),
        );
      }
      case "scroll": {
        const selector = normalizeSelector(action.selector);
        const direction =
          readTextArgument(action)?.trim().toLowerCase() === "up" ? -1 : 1;
        return await this.withSession(signal, (page, session) =>
          this.scroll(page, selector, direction, session, signal),
        );
      }
      default:
        return unsupported("method_unsupported");
    }
  }

  private async withSession<T>(
    signal: AbortSignal,
    run: (page: BrowserPage, session: CdpSession) => Promise<T>,
  ): Promise<T> {
    const page = await this.resolvePage(signal);
    const session = await this.openSession(page, signal);

    try {
      return await run(page, session);
    } finally {
      await session.detach().catch(() => undefined);
    }
  }

  private async resolvePage(signal: AbortSignal): Promise<BrowserPage> {
    throwIfAborted(signal);
    const page = this.context.pages().at(-1);
    if (page !== undefined) {
      return page;
    }

    try {
      return await withDeadline(this.context.newPage(), this.timeoutMs, signal, "input_timeout");
    } catch (error) {
      throw toInputError(error);
    }
  }

  private async openSession(
    page: BrowserPage,
    signal: AbortSignal,
  ): Promise<CdpSession> {
    const context = this.context;
    if (!isCdpCapableContext(context)) {
      throw new InputError("input_failed");
    }

    let raw: unknown;
    try {
      raw = await withDeadline(
        context.newCDPSession(page),
        this.timeoutMs,
        signal,
        "input_timeout",
      );
    } catch (error) {
      throw toInputError(error);
    }

    if (!isCdpSession(raw)) {
      throw new InputError("input_failed");
    }

    return raw;
  }

  private async sendCommand(
    session: CdpSession,
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    try {
      return await withDeadline(
        session.send(method, params),
        this.timeoutMs,
        signal,
        "input_timeout",
      );
    } catch (error) {
      throw toInputError(error);
    }
  }

  private requireLocator(page: BrowserPage, selector: string): InputLocator {
    const locator = page.locator(selector);
    if (!isInputLocator(locator)) {
      throw new InputError("input_failed");
    }
    return locator;
  }

  private async callElement<T>(
    signal: AbortSignal,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      return await withDeadline(
        run(),
        ELEMENT_TIMEOUT_MS,
        signal,
        "input_target_not_found",
      );
    } catch (error) {
      throw toInputError(error);
    }
  }

  private async readViewport(
    session: CdpSession,
    signal: AbortSignal,
  ): Promise<Viewport> {
    const metrics = await this.sendCommand(
      session,
      "Page.getLayoutMetrics",
      {},
      signal,
    );
    const viewport = readValue(metrics, "cssLayoutViewport");
    const width = readPositiveNumber(viewport, "clientWidth");
    const height = readPositiveNumber(viewport, "clientHeight");

    if (width === null || height === null) {
      throw new InputError("input_failed");
    }

    return { width, height };
  }

  private async click(
    page: BrowserPage,
    selector: string,
    session: CdpSession,
    signal: AbortSignal,
  ): Promise<InputExecutionResult> {
    const locator = this.requireLocator(page, selector);
    await this.callElement(signal, () =>
      locator.scrollIntoViewIfNeeded({ timeout: ELEMENT_TIMEOUT_MS }),
    );
    const box = await this.callElement(signal, () =>
      locator.boundingBox({ timeout: ELEMENT_TIMEOUT_MS }),
    );
    if (box === null) {
      throw new InputError("input_target_not_found");
    }

    const viewport = await this.readViewport(session, signal);
    const target = pickClickPoint(box, viewport, this.random);
    const start = this.cursor ?? pickInitialCursor(viewport, this.random);
    const path = planMousePath(start, target, this.policy, this.random);

    for (const [index, point] of path.entries()) {
      throwIfAborted(signal);
      await this.sendMouse(session, "mouseMoved", clampPoint(point, viewport), {}, signal);
      if (index < path.length - 1) {
        await wait(this.policy.mouse.stepDelayMs, signal);
      }
    }

    throwIfAborted(signal);
    await this.sendMouse(
      session,
      "mousePressed",
      target,
      { button: "left", buttons: 1, clickCount: 1 },
      signal,
    );
    await this.sendMouse(
      session,
      "mouseReleased",
      target,
      { button: "left", buttons: 0, clickCount: 1 },
      signal,
    );
    this.cursor = target;

    return done();
  }

  private async sendMouse(
    session: CdpSession,
    type: "mouseMoved" | "mousePressed" | "mouseReleased",
    point: MousePoint,
    extra: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<void> {
    await this.sendCommand(
      session,
      "Input.dispatchMouseEvent",
      { type, x: point.x, y: point.y, ...extra },
      signal,
    );
  }

  private async type(
    page: BrowserPage,
    selector: string,
    text: string,
    shouldClear: boolean,
    session: CdpSession,
    signal: AbortSignal,
  ): Promise<InputExecutionResult> {
    const locator = this.requireLocator(page, selector);
    await this.callElement(signal, () =>
      locator.scrollIntoViewIfNeeded({ timeout: ELEMENT_TIMEOUT_MS }),
    );
    await this.callElement(signal, () =>
      locator.focus({ timeout: ELEMENT_TIMEOUT_MS }),
    );

    if (shouldClear) {
      await this.clearValue(session, signal);
    }

    const delays = planTypingDelays(text, this.policy, this.random);
    let index = 0;

    for (const character of text) {
      let pauseMs = 0;
      for (let unit = 0; unit < character.length; unit += 1) {
        pauseMs += delays[index + unit] ?? 0;
      }
      await wait(pauseMs, signal);
      throwIfAborted(signal);
      await this.sendCharacter(session, character, signal);
      index += character.length;
    }

    return done();
  }

  private async clearValue(
    session: CdpSession,
    signal: AbortSignal,
  ): Promise<void> {
    await this.sendKey(
      session,
      {
        type: "keyDown",
        key: "a",
        code: "KeyA",
        windowsVirtualKeyCode: 65,
        nativeVirtualKeyCode: 65,
        modifiers: SELECT_ALL_MODIFIER,
        commands: ["selectAll"],
      },
      signal,
    );
    await this.sendKey(
      session,
      {
        type: "keyUp",
        key: "a",
        code: "KeyA",
        windowsVirtualKeyCode: 65,
        nativeVirtualKeyCode: 65,
        modifiers: SELECT_ALL_MODIFIER,
      },
      signal,
    );
    await this.pressKey(session, "Backspace", "Backspace", 8, signal);
  }

  private async pressKey(
    session: CdpSession,
    key: string,
    code: string,
    windowsVirtualKeyCode: number,
    signal: AbortSignal,
  ): Promise<void> {
    await this.sendKey(
      session,
      {
        type: "keyDown",
        key,
        code,
        windowsVirtualKeyCode,
        nativeVirtualKeyCode: windowsVirtualKeyCode,
      },
      signal,
    );
    await this.sendKey(
      session,
      {
        type: "keyUp",
        key,
        code,
        windowsVirtualKeyCode,
        nativeVirtualKeyCode: windowsVirtualKeyCode,
      },
      signal,
    );
  }

  private async sendCharacter(
    session: CdpSession,
    character: string,
    signal: AbortSignal,
  ): Promise<void> {
    const control = CONTROL_KEYS[character];

    if (control === undefined) {
      await this.sendCommand(session, "Input.insertText", { text: character }, signal);
      return;
    }

    const params: Record<string, unknown> = {
      type: "keyDown",
      key: control.key,
      code: control.code,
      windowsVirtualKeyCode: control.windowsVirtualKeyCode,
      nativeVirtualKeyCode: control.windowsVirtualKeyCode,
    };
    if (control.text !== undefined) {
      params.text = control.text;
      params.unmodifiedText = control.text;
    }

    await this.sendKey(session, params, signal);
    await this.sendKey(
      session,
      {
        type: "keyUp",
        key: control.key,
        code: control.code,
        windowsVirtualKeyCode: control.windowsVirtualKeyCode,
        nativeVirtualKeyCode: control.windowsVirtualKeyCode,
      },
      signal,
    );
  }

  private async sendKey(
    session: CdpSession,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<void> {
    await this.sendCommand(session, "Input.dispatchKeyEvent", params, signal);
  }

  private async scroll(
    page: BrowserPage,
    selector: string | undefined,
    direction: number,
    session: CdpSession,
    signal: AbortSignal,
  ): Promise<InputExecutionResult> {
    const viewport = await this.readViewport(session, signal);
    let point: MousePoint = {
      x: (viewport.width - 1) / 2,
      y: (viewport.height - 1) / 2,
    };

    if (selector !== undefined) {
      const locator = this.requireLocator(page, selector);
      const box = await this.callElement(signal, () =>
        locator.boundingBox({ timeout: ELEMENT_TIMEOUT_MS }),
      );
      if (box === null) {
        throw new InputError("input_target_not_found");
      }
      point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }

    const target = clampPoint(point, viewport);
    const deltas = planScrollDeltas(this.policy);

    for (const delta of deltas) {
      await wait(this.policy.scroll.stepDelayMs, signal);
      throwIfAborted(signal);
      await this.sendCommand(
        session,
        "Input.dispatchMouseEvent",
        {
          type: "mouseWheel",
          x: target.x,
          y: target.y,
          deltaX: 0,
          deltaY: direction * delta,
          buttons: 0,
        },
        signal,
      );
    }

    return done();
  }
}

export function createInputExecutor(options: InputExecutorOptions): InputExecutor {
  return new InputExecutorImpl(options);
}
