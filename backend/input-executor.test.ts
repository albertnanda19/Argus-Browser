import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultProfilePolicy,
  type ProfilePolicy,
} from "../shared/profile-policy";
import type { BrowserLocator, BrowserPage, BrowserSessionContext } from "./browser-launcher";
import { planScrollDeltas } from "./human-like";
import {
  createInputExecutor,
  InputError,
  type InputAction,
  type InputExecutionResult,
} from "./input-executor";

type Box = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

type CdpCall = {
  readonly method: string;
  readonly params: Record<string, unknown>;
};

type LocatorCall = {
  readonly selector: string;
  readonly operation: string;
  readonly timeout: number;
};

type HarnessState = {
  cdpSessions: number;
  detachCalls: number;
  closeCalls: number;
  pageClicks: number;
  pageFills: number;
};

type FakeSession = {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  detach(): Promise<void>;
};

type FakeContext = BrowserSessionContext & {
  newCDPSession(page: BrowserPage): Promise<unknown>;
};

type FakeHarness = {
  readonly context: FakeContext;
  readonly state: HarnessState;
  readonly cdpCalls: CdpCall[];
  readonly locatorCalls: LocatorCall[];
};

type HarnessOptions = {
  readonly box?: Box | null;
  readonly boxError?: unknown;
  readonly viewport?: { readonly width: number; readonly height: number };
  readonly send?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
};

const VIEWPORT = { width: 800, height: 600 };
const DEFAULT_BOX: Box = { x: 200, y: 150, width: 100, height: 60 };

function createFakeHarness(options: HarnessOptions = {}): FakeHarness {
  const state: HarnessState = {
    cdpSessions: 0,
    detachCalls: 0,
    closeCalls: 0,
    pageClicks: 0,
    pageFills: 0,
  };
  const cdpCalls: CdpCall[] = [];
  const locatorCalls: LocatorCall[] = [];
  const viewport = options.viewport ?? VIEWPORT;

  const session: FakeSession = {
    async send(method, params = {}) {
      cdpCalls.push({ method, params });
      if (options.send !== undefined) {
        return options.send(method, params);
      }
      if (method === "Page.getLayoutMetrics") {
        return {
          cssLayoutViewport: {
            clientWidth: viewport.width,
            clientHeight: viewport.height,
          },
        };
      }
      return {};
    },
    async detach() {
      state.detachCalls += 1;
    },
  };

  const page: BrowserPage = {
    async goto() {
      return undefined;
    },
    url: () => "http://127.0.0.1/",
    locator(selector) {
      const locator: BrowserLocator & {
        scrollIntoViewIfNeeded(callOptions: { readonly timeout: number }): Promise<void>;
        boundingBox(callOptions: {
          readonly timeout: number;
        }): Promise<Box | null>;
        focus(callOptions: { readonly timeout: number }): Promise<void>;
      } = {
        async click() {
          state.pageClicks += 1;
        },
        async fill() {
          state.pageFills += 1;
        },
        async innerText() {
          return "";
        },
        async scrollIntoViewIfNeeded({ timeout }) {
          locatorCalls.push({ selector, operation: "scrollIntoViewIfNeeded", timeout });
        },
        async boundingBox({ timeout }) {
          locatorCalls.push({ selector, operation: "boundingBox", timeout });
          if (options.boxError !== undefined) {
            throw options.boxError;
          }
          return options.box === undefined ? DEFAULT_BOX : options.box;
        },
        async focus({ timeout }) {
          locatorCalls.push({ selector, operation: "focus", timeout });
        },
      };
      return locator;
    },
  };

  const context: FakeContext = {
    on: () => undefined,
    pages: () => [page],
    async newPage() {
      throw new Error("Unexpected newPage call.");
    },
    async close() {
      state.closeCalls += 1;
    },
    async newCDPSession() {
      state.cdpSessions += 1;
      return session;
    },
  };

  return { context, state, cdpCalls, locatorCalls };
}

function createExecutor(
  harness: FakeHarness,
  overrides: {
    readonly policy?: ProfilePolicy;
    readonly random?: () => number;
    readonly timeoutMs?: number;
  } = {},
) {
  return createInputExecutor({
    context: harness.context,
    policy: overrides.policy ?? createDefaultProfilePolicy(),
    random: overrides.random ?? (() => 0.5),
    timeoutMs: overrides.timeoutMs,
  });
}

function insertTexts(calls: readonly CdpCall[]): string[] {
  return calls
    .filter((call) => call.method === "Input.insertText")
    .map((call) => String(call.params.text));
}

function keyDownKeys(calls: readonly CdpCall[]): string[] {
  return calls
    .filter(
      (call) =>
        call.method === "Input.dispatchKeyEvent" && call.params.type === "keyDown",
    )
    .map((call) => String(call.params.key));
}

function mouseMoves(calls: readonly CdpCall[]): Array<{ x: number; y: number }> {
  return calls
    .filter(
      (call) =>
        call.method === "Input.dispatchMouseEvent" &&
        call.params.type === "mouseMoved",
    )
    .map((call) => ({ x: Number(call.params.x), y: Number(call.params.y) }));
}

function wheelDeltas(calls: readonly CdpCall[]): number[] {
  return calls
    .filter(
      (call) =>
        call.method === "Input.dispatchMouseEvent" &&
        call.params.type === "mouseWheel",
    )
    .map((call) => Number(call.params.deltaY));
}

function timeoutError(): Error {
  const error = new Error("Target closed.");
  error.name = "TimeoutError";
  return error;
}

async function isUnsupported(
  result: InputExecutionResult,
  reason: string,
): Promise<void> {
  expect(result).toEqual({ status: "unsupported", reason });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("input executor click", () => {
  it("moves the mouse along a multi-point path, clicks the box centre, and keeps the cursor", async () => {
    vi.useFakeTimers();
    const harness = createFakeHarness();
    const executor = createExecutor(harness);
    const action: InputAction = { method: "click", selector: "#target" };

    const first = executor.execute(action, new AbortController().signal);
    await vi.runAllTimersAsync();
    await expect(first).resolves.toEqual({ status: "done", actionCount: 1 });

    const moves = mouseMoves(harness.cdpCalls);
    expect(moves.length).toBeGreaterThan(1);
    for (const point of moves) {
      expect(Number.isFinite(point.x)).toBe(true);
      expect(Number.isFinite(point.y)).toBe(true);
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThanOrEqual(VIEWPORT.width - 1);
      expect(point.y).toBeGreaterThanOrEqual(0);
      expect(point.y).toBeLessThanOrEqual(VIEWPORT.height - 1);
    }

    const finalPoint = moves.at(-1);
    expect(finalPoint).toEqual({ x: 250, y: 180 });
    expect(finalPoint?.x).toBeGreaterThan(DEFAULT_BOX.x);
    expect(finalPoint?.x).toBeLessThan(DEFAULT_BOX.x + DEFAULT_BOX.width);
    expect(finalPoint?.y).toBeGreaterThan(DEFAULT_BOX.y);
    expect(finalPoint?.y).toBeLessThan(DEFAULT_BOX.y + DEFAULT_BOX.height);

    const press = harness.cdpCalls.find(
      (call) =>
        call.method === "Input.dispatchMouseEvent" &&
        call.params.type === "mousePressed",
    );
    const release = harness.cdpCalls.find(
      (call) =>
        call.method === "Input.dispatchMouseEvent" &&
        call.params.type === "mouseReleased",
    );
    expect(press?.params).toMatchObject({
      x: 250,
      y: 180,
      button: "left",
      clickCount: 1,
    });
    expect(release?.params).toMatchObject({
      x: 250,
      y: 180,
      button: "left",
      clickCount: 1,
    });
    expect(harness.locatorCalls).toContainEqual({
      selector: "#target",
      operation: "scrollIntoViewIfNeeded",
      timeout: 10_000,
    });
    expect(harness.locatorCalls).toContainEqual({
      selector: "#target",
      operation: "boundingBox",
      timeout: 10_000,
    });
    expect(harness.state.pageClicks).toBe(0);
    expect(harness.state.closeCalls).toBe(0);
    expect(harness.state.detachCalls).toBe(1);

    const cursorMark = harness.cdpCalls.length;
    const second = executor.execute(action, new AbortController().signal);
    await vi.runAllTimersAsync();
    await expect(second).resolves.toEqual({ status: "done", actionCount: 1 });
    const secondMoves = mouseMoves(harness.cdpCalls.slice(cursorMark));
    expect(secondMoves[0]).toEqual(finalPoint);
  });
});

describe("input executor typing", () => {
  it("sends one insertText per character and waits per planned delay", async () => {
    vi.useFakeTimers();
    const harness = createFakeHarness();
    const executor = createExecutor(harness);
    const action: InputAction = {
      method: "type",
      selector: "#field",
      arguments: ["abc"],
    };

    const execution = executor.execute(action, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(109);
    expect(insertTexts(harness.cdpCalls)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(insertTexts(harness.cdpCalls)).toEqual(["a"]);
    await vi.advanceTimersByTimeAsync(39);
    expect(insertTexts(harness.cdpCalls)).toEqual(["a"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(insertTexts(harness.cdpCalls)).toEqual(["a", "b"]);
    await vi.advanceTimersByTimeAsync(39);
    expect(insertTexts(harness.cdpCalls)).toEqual(["a", "b"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(insertTexts(harness.cdpCalls)).toEqual(["a", "b", "c"]);

    await expect(execution).resolves.toEqual({ status: "done", actionCount: 1 });
    expect(harness.locatorCalls).toContainEqual({
      selector: "#field",
      operation: "focus",
      timeout: 10_000,
    });
    expect(harness.state.pageFills).toBe(0);
    expect(harness.state.closeCalls).toBe(0);
  });

  it("clears the old value before a fill and never uses locator.fill", async () => {
    vi.useFakeTimers();
    const harness = createFakeHarness();
    const executor = createExecutor(harness);

    const execution = executor.execute(
      { method: "fill", selector: "#field", arguments: ["xy"] },
      new AbortController().signal,
    );
    await vi.runAllTimersAsync();
    await expect(execution).resolves.toEqual({ status: "done", actionCount: 1 });

    const selectAllIndex = harness.cdpCalls.findIndex(
      (call) =>
        call.method === "Input.dispatchKeyEvent" &&
        Array.isArray(call.params.commands) &&
        call.params.commands.includes("selectAll"),
    );
    const backspaceIndex = harness.cdpCalls.findIndex(
      (call) =>
        call.method === "Input.dispatchKeyEvent" &&
        call.params.type === "keyDown" &&
        call.params.key === "Backspace",
    );
    const firstInsertIndex = harness.cdpCalls.findIndex(
      (call) => call.method === "Input.insertText",
    );
    expect(selectAllIndex).toBeGreaterThanOrEqual(0);
    expect(backspaceIndex).toBeGreaterThan(selectAllIndex);
    expect(firstInsertIndex).toBeGreaterThan(backspaceIndex);
    expect(insertTexts(harness.cdpCalls)).toEqual(["x", "y"]);
    expect(harness.state.pageFills).toBe(0);
  });

  it("clears on an empty fill and sends nothing on an empty type", async () => {
    vi.useFakeTimers();
    const fillHarness = createFakeHarness();
    const fillExecutor = createExecutor(fillHarness);
    const fillExecution = fillExecutor.execute(
      { method: "fill", selector: "#field", arguments: [""] },
      new AbortController().signal,
    );
    await vi.runAllTimersAsync();
    await expect(fillExecution).resolves.toEqual({
      status: "done",
      actionCount: 1,
    });
    expect(keyDownKeys(fillHarness.cdpCalls)).toEqual(["a", "Backspace"]);
    expect(insertTexts(fillHarness.cdpCalls)).toEqual([]);

    const typeHarness = createFakeHarness();
    const typeExecutor = createExecutor(typeHarness);
    const typeExecution = typeExecutor.execute(
      { method: "type", selector: "#field", arguments: [""] },
      new AbortController().signal,
    );
    await vi.runAllTimersAsync();
    await expect(typeExecution).resolves.toEqual({
      status: "done",
      actionCount: 1,
    });
    expect(
      typeHarness.cdpCalls.filter(
        (call) => call.method === "Input.dispatchKeyEvent",
      ),
    ).toEqual([]);
    expect(insertTexts(typeHarness.cdpCalls)).toEqual([]);
  });

  it("uses key events for Enter, Tab, and Backspace", async () => {
    vi.useFakeTimers();
    const harness = createFakeHarness();
    const executor = createExecutor(harness);

    const execution = executor.execute(
      { method: "type", selector: "#field", arguments: ["a\n\t\b"] },
      new AbortController().signal,
    );
    await vi.runAllTimersAsync();
    await expect(execution).resolves.toEqual({ status: "done", actionCount: 1 });

    expect(insertTexts(harness.cdpCalls)).toEqual(["a"]);
    expect(keyDownKeys(harness.cdpCalls)).toEqual([
      "Enter",
      "Tab",
      "Backspace",
    ]);
    const keyUps = harness.cdpCalls
      .filter(
        (call) =>
          call.method === "Input.dispatchKeyEvent" && call.params.type === "keyUp",
      )
      .map((call) => String(call.params.key));
    expect(keyUps).toEqual(["Enter", "Tab", "Backspace"]);
  });

  it("keeps surrogate pairs together and consumes a delay per code unit", async () => {
    vi.useFakeTimers();
    const harness = createFakeHarness();
    const executor = createExecutor(harness);

    const execution = executor.execute(
      { method: "type", selector: "#field", arguments: ["😀a"] },
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(149);
    expect(insertTexts(harness.cdpCalls)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(insertTexts(harness.cdpCalls)).toEqual(["😀"]);
    await vi.advanceTimersByTimeAsync(39);
    expect(insertTexts(harness.cdpCalls)).toEqual(["😀"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(insertTexts(harness.cdpCalls)).toEqual(["😀", "a"]);
    await expect(execution).resolves.toEqual({ status: "done", actionCount: 1 });
  });

  it("stops the remaining characters after an abort", async () => {
    vi.useFakeTimers();
    const harness = createFakeHarness();
    const executor = createExecutor(harness);
    const controller = new AbortController();
    const text = "rahasia";

    const execution = executor.execute(
      { method: "type", selector: "#field", arguments: [text] },
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(110);
    expect(insertTexts(harness.cdpCalls)).toEqual(["r"]);
    controller.abort();
    await expect(execution).rejects.toMatchObject({ code: "input_cancelled" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(insertTexts(harness.cdpCalls)).toEqual(["r"]);
    await expect(execution).rejects.not.toThrow(text);
  });
});

describe("input executor scroll", () => {
  it("sends one wheel event per planned delta at the element centre", async () => {
    vi.useFakeTimers();
    const harness = createFakeHarness({
      box: { x: 100, y: 100, width: 200, height: 100 },
    });
    const executor = createExecutor(harness);
    const policy = createDefaultProfilePolicy();

    const execution = executor.execute(
      { method: "scroll", selector: "#scroller" },
      new AbortController().signal,
    );
    await vi.runAllTimersAsync();
    await expect(execution).resolves.toEqual({ status: "done", actionCount: 1 });

    const expected = planScrollDeltas(policy);
    expect(wheelDeltas(harness.cdpCalls)).toEqual([...expected]);
    expect(wheelDeltas(harness.cdpCalls)).toHaveLength(policy.scroll.steps);
    for (const call of harness.cdpCalls) {
      if (
        call.method === "Input.dispatchMouseEvent" &&
        call.params.type === "mouseWheel"
      ) {
        expect(call.params).toMatchObject({ x: 200, y: 150, deltaX: 0 });
      }
    }
  });

  it("defaults to the viewport centre and a down direction", async () => {
    vi.useFakeTimers();
    const harness = createFakeHarness();
    const executor = createExecutor(harness);

    const execution = executor.execute(
      { method: "scroll" },
      new AbortController().signal,
    );
    await vi.runAllTimersAsync();
    await expect(execution).resolves.toEqual({ status: "done", actionCount: 1 });

    const wheels = harness.cdpCalls.filter(
      (call) =>
        call.method === "Input.dispatchMouseEvent" &&
        call.params.type === "mouseWheel",
    );
    expect(wheels.length).toBeGreaterThan(0);
    for (const wheel of wheels) {
      expect(wheel.params.x).toBe((VIEWPORT.width - 1) / 2);
      expect(wheel.params.y).toBe((VIEWPORT.height - 1) / 2);
      expect(Number(wheel.params.deltaY)).toBeGreaterThan(0);
    }
  });

  it("negates every delta for an up scroll", async () => {
    vi.useFakeTimers();
    const harness = createFakeHarness();
    const executor = createExecutor(harness);
    const policy = createDefaultProfilePolicy();

    const execution = executor.execute(
      { method: "scroll", arguments: ["up"] },
      new AbortController().signal,
    );
    await vi.runAllTimersAsync();
    await expect(execution).resolves.toEqual({ status: "done", actionCount: 1 });

    expect(wheelDeltas(harness.cdpCalls)).toEqual(
      planScrollDeltas(policy).map((delta) => -delta),
    );
  });

  it("stops after an abort in the middle of the momentum", async () => {
    vi.useFakeTimers();
    const harness = createFakeHarness();
    const executor = createExecutor(harness);
    const controller = new AbortController();

    const execution = executor.execute(
      { method: "scroll" },
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(40);
    expect(wheelDeltas(harness.cdpCalls)).toHaveLength(1);
    controller.abort();
    await expect(execution).rejects.toMatchObject({ code: "input_cancelled" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(wheelDeltas(harness.cdpCalls)).toHaveLength(1);
  });
});

describe("input executor unsupported actions", () => {
  const cases: Array<{ readonly action: InputAction; readonly reason: string }> = [
    { action: { method: "navigate", selector: "#x" }, reason: "method_unsupported" },
    { action: { method: "extract", selector: "#x" }, reason: "method_unsupported" },
    { action: {}, reason: "method_missing" },
    { action: { method: "   " }, reason: "method_missing" },
    { action: { method: "click" }, reason: "selector_missing" },
    { action: { method: "type", arguments: ["a"] }, reason: "selector_missing" },
    { action: { method: "fill", selector: "  ", arguments: ["a"] }, reason: "selector_missing" },
    { action: { method: "type", selector: "#x" }, reason: "text_missing" },
    { action: { method: "fill", selector: "#x", arguments: [] }, reason: "text_missing" },
  ];

  for (const testCase of cases) {
    it(`returns ${testCase.reason} for ${JSON.stringify(testCase.action)}`, async () => {
      const harness = createFakeHarness();
      const executor = createExecutor(harness);

      const result = await executor.execute(
        testCase.action,
        new AbortController().signal,
      );

      await isUnsupported(result, testCase.reason);
      expect(harness.state.cdpSessions).toBe(0);
      expect(harness.cdpCalls).toEqual([]);
      expect(harness.locatorCalls).toEqual([]);
    });
  }
});

describe("input executor errors", () => {
  it("maps a null bounding box to input_target_not_found", async () => {
    vi.useFakeTimers();
    const harness = createFakeHarness({ box: null });
    const executor = createExecutor(harness);

    const execution = executor.execute(
      { method: "click", selector: "#target" },
      new AbortController().signal,
    );
    const assertion = expect(execution).rejects.toBeInstanceOf(InputError);
    await vi.runAllTimersAsync();
    await assertion;
    await expect(execution).rejects.toMatchObject({
      code: "input_target_not_found",
    });
    expect(harness.state.detachCalls).toBe(1);
  });

  it("maps an element timeout to input_target_not_found", async () => {
    vi.useFakeTimers();
    const harness = createFakeHarness({ boxError: timeoutError() });
    const executor = createExecutor(harness);

    const execution = executor.execute(
      { method: "click", selector: "#target" },
      new AbortController().signal,
    );
    const assertion = expect(execution).rejects.toMatchObject({
      code: "input_target_not_found",
    });
    await vi.runAllTimersAsync();
    await assertion;
  });

  it("maps a failed CDP command to input_failed without the raw message", async () => {
    vi.useFakeTimers();
    const harness = createFakeHarness({
      send: async () => {
        throw new Error("CDP boom at ws://127.0.0.1:1");
      },
    });
    const executor = createExecutor(harness);

    const execution = executor.execute(
      { method: "click", selector: "#target" },
      new AbortController().signal,
    );
    const assertion = expect(execution).rejects.toMatchObject({
      code: "input_failed",
    });
    await vi.runAllTimersAsync();
    await assertion;
    await expect(execution).rejects.not.toThrow("CDP boom");
  });

  it("maps a hanging CDP command to input_timeout", async () => {
    vi.useFakeTimers();
    const harness = createFakeHarness({
      send: () => new Promise<unknown>(() => undefined),
    });
    const executor = createExecutor(harness, { timeoutMs: 20 });

    const execution = executor.execute(
      { method: "click", selector: "#target" },
      new AbortController().signal,
    );
    const assertion = expect(execution).rejects.toMatchObject({
      code: "input_timeout",
    });
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
  });

  it("cancels before touching the browser when the signal is already aborted", async () => {
    const harness = createFakeHarness();
    const executor = createExecutor(harness);
    const controller = new AbortController();
    controller.abort();

    await expect(
      executor.execute({ method: "click", selector: "#target" }, controller.signal),
    ).rejects.toMatchObject({ code: "input_cancelled" });
    expect(harness.state.cdpSessions).toBe(0);
    expect(harness.cdpCalls).toEqual([]);
    expect(harness.locatorCalls).toEqual([]);
  });

  it("never puts typed text into the error message", async () => {
    vi.useFakeTimers();
    const secret = "kata-sandi-rahasia";
    const harness = createFakeHarness({
      send: async (method) => {
        if (method === "Input.insertText") {
          throw new Error(`failed for ${secret}`);
        }
        return {};
      },
    });
    const executor = createExecutor(harness);

    const execution = executor.execute(
      { method: "type", selector: "#field", arguments: [secret] },
      new AbortController().signal,
    );
    const assertion = expect(execution).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof InputError &&
        error.code === "input_failed" &&
        !error.message.includes(secret),
    );
    await vi.runAllTimersAsync();
    await assertion;
  });
});
