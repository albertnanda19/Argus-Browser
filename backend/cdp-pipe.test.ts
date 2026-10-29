import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CdpPipeFrameDecoder,
  createCdpPipeTransport,
  launchCdpPipe,
  type CdpPipeTransportOptions,
} from "./cdp-pipe";

function encode(messages: readonly unknown[]): Buffer {
  return Buffer.concat(
    messages.map((message) => Buffer.from(`${JSON.stringify(message)}\0`)),
  );
}

function createHarness(options: Partial<CdpPipeTransportOptions> = {}) {
  const write = new PassThrough();
  const read = new PassThrough();
  read.resume();
  const written: Buffer[] = [];
  write.on("data", (chunk: Buffer) => written.push(chunk));
  const signals: NodeJS.Signals[] = [];
  let hasExited = false;

  const pipe = createCdpPipeTransport({
    pid: 4242,
    write,
    read,
    kill(signal) {
      signals.push(signal);
      hasExited = true;
    },
    async waitForExit() {
      return hasExited;
    },
    browserCloseTimeoutMs: 20,
    terminateTimeoutMs: 10,
    killTimeoutMs: 10,
    ...options,
  });

  return {
    pipe,
    write,
    read,
    written,
    signals,
    writtenMessages() {
      return Buffer.concat(written).toString().split("\0").filter(Boolean).map((part) => JSON.parse(part));
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("CdpPipeFrameDecoder", () => {
  it("decodes multiple messages from one chunk", () => {
    const decoder = new CdpPipeFrameDecoder();
    const messages = decoder.push(encode([{ id: 1, result: {} }, { method: "Page.loadEventFired" }]));
    expect(messages).toEqual([{ id: 1, result: {} }, { method: "Page.loadEventFired" }]);
  });

  it("decodes a message split across chunks including a split null byte", () => {
    const decoder = new CdpPipeFrameDecoder();
    const frame = encode([{ id: 7, result: { ok: true } }]);
    expect(decoder.push(frame.subarray(0, 3))).toEqual([]);
    expect(decoder.push(frame.subarray(3, frame.length - 1))).toEqual([]);
    expect(decoder.push(frame.subarray(frame.length - 1))).toEqual([{ id: 7, result: { ok: true } }]);
  });

  it("decodes a large message", () => {
    const decoder = new CdpPipeFrameDecoder();
    const value = "x".repeat(1_048_576);
    const messages = decoder.push(encode([{ id: 1, result: { value } }]));
    expect(messages).toHaveLength(1);
    expect((messages[0] as { result: { value: string } }).result.value).toHaveLength(1_048_576);
  });

  it("rejects malformed JSON", () => {
    const decoder = new CdpPipeFrameDecoder();
    expect(() => decoder.push(Buffer.from("{broken}\0"))).toThrow("CDP pipe received malformed JSON.");
  });
});

describe("createCdpPipeTransport", () => {
  it("writes JSON frames terminated by a null byte", () => {
    const harness = createHarness();
    harness.pipe.send({ id: 1, method: "Target.getTargets", params: {} });
    expect(harness.writtenMessages()).toEqual([
      { id: 1, method: "Target.getTargets", params: {} },
    ]);
    expect(Buffer.concat(harness.written).at(-1)).toBe(0);
    expect(harness.pipe.pid).toBe(4242);
  });

  it("delivers parsed messages in order", () => {
    const harness = createHarness();
    const received: unknown[] = [];
    harness.pipe.onMessage((message) => received.push(message));
    harness.read.write(encode([{ id: 1, result: { a: 1 } }]));
    harness.read.write(encode([{ method: "Target.targetCreated" }]));
    expect(received).toEqual([
      { id: 1, result: { a: 1 } },
      { method: "Target.targetCreated" },
    ]);
  });

  it("reports EOF once and rejects later sends", async () => {
    const harness = createHarness();
    const closeListener = vi.fn();
    harness.pipe.onClose(closeListener);
    harness.read.end();
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
    expect(closeListener).toHaveBeenCalledTimes(1);
    expect(closeListener.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect((closeListener.mock.calls[0]?.[0] as Error).message).toBe("CDP pipe closed.");
    expect(() => harness.pipe.send({ id: 2, method: "Target.getTargets" })).toThrow(
      "CDP pipe is closed.",
    );
  });

  it("reports malformed input as an error and closes once", () => {
    const harness = createHarness();
    const closeListener = vi.fn();
    harness.pipe.onClose(closeListener);
    harness.read.write(Buffer.from("{broken}\0"));
    expect(closeListener).toHaveBeenCalledTimes(1);
    expect(closeListener.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it("sends Browser.close and waits for a graceful exit", async () => {
    const harness = createHarness({
      async waitForExit() {
        return true;
      },
    });
    await harness.pipe.close();
    expect(harness.writtenMessages()).toEqual([{ id: 0, method: "Browser.close" }]);
    expect(harness.signals).toEqual([]);
  });

  it("escalates to SIGTERM when Browser.close does not exit in time", async () => {
    let calls = 0;
    const harness = createHarness({
      async waitForExit() {
        calls += 1;
        return calls > 1;
      },
    });
    await harness.pipe.close();
    expect(harness.signals).toEqual(["SIGTERM"]);
  });

  it("escalates to SIGKILL when SIGTERM does not exit", async () => {
    const harness = createHarness({
      async waitForExit() {
        return false;
      },
    });
    await harness.pipe.close();
    expect(harness.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("is idempotent", async () => {
    const harness = createHarness({
      async waitForExit() {
        return true;
      },
    });
    await Promise.all([harness.pipe.close(), harness.pipe.close()]);
    expect(harness.writtenMessages()).toEqual([{ id: 0, method: "Browser.close" }]);
  });

  it("keeps Browser.close, SIGTERM, and SIGKILL inside the configured budget", async () => {
    const timeouts: number[] = [];
    const harness = createHarness({
      browserCloseTimeoutMs: 100,
      terminateTimeoutMs: 50,
      killTimeoutMs: 50,
      async waitForExit(timeoutMs) {
        timeouts.push(timeoutMs);
        return false;
      },
    });

    await harness.pipe.close();

    expect(harness.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(timeouts).toHaveLength(3);
    expect(timeouts[0]).toBeLessThanOrEqual(100);
    expect(timeouts[1]).toBeLessThanOrEqual(50);
    expect(timeouts[2]).toBeLessThanOrEqual(50);
    expect(timeouts.reduce((total, value) => total + value, 0)).toBeLessThanOrEqual(200);
  });

  it("does not send Browser.close after a pipe EOF", async () => {
    const harness = createHarness({
      async waitForExit() {
        return true;
      },
    });
    harness.read.end();
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));

    await harness.pipe.close();

    expect(harness.writtenMessages()).toEqual([]);
    expect(harness.signals).toEqual([]);
  });

  it("rejects a Chrome executable that cannot be spawned", async () => {
    await expect(
      launchCdpPipe({
        executablePath: "/nonexistent/argus-chrome-for-testing",
        userDataDir: "/nonexistent/argus-profile",
      }),
    ).rejects.toThrow("Failed to launch Chrome for Testing.");
  });
});
