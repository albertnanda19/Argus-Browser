import { describe, expect, it, vi } from "vitest";
import {
  createCdpRouter,
  type CdpClientSink,
  type CdpRouterTransport,
} from "./cdp-router";
import type { CdpWireMessage } from "./cdp-pipe";

type FakePipe = {
  readonly pipe: CdpRouterTransport;
  readonly sent: CdpWireMessage[];
  readonly close: ReturnType<typeof vi.fn>;
  emit(message: CdpWireMessage): void;
  emitClose(error?: Error): void;
};

function createFakePipe(): FakePipe {
  const sent: CdpWireMessage[] = [];
  let onMessage: ((message: CdpWireMessage) => void) | null = null;
  let onClose: ((error?: Error) => void) | null = null;
  const close = vi.fn(async () => undefined);

  const pipe: CdpRouterTransport = {
    pid: 99,
    send(message) {
      sent.push(message);
    },
    onMessage(listener) {
      onMessage = listener;
    },
    onClose(listener) {
      onClose = listener;
    },
    close,
  };

  return {
    pipe,
    sent,
    close,
    emit(message) {
      onMessage?.(message);
    },
    emitClose(error) {
      onClose?.(error);
    },
  };
}

function createSink(options: { readonly accept?: boolean } = {}) {
  const messages: CdpWireMessage[] = [];
  const close = vi.fn();
  const sink: CdpClientSink = {
    send(message) {
      if (options.accept === false) {
        return false;
      }
      messages.push(message);
      return true;
    },
    close,
  };
  return { sink, messages, close };
}

async function addClient(
  router: ReturnType<typeof createCdpRouter>,
  pipe: FakePipe,
  sink: CdpClientSink,
  browserSessionId: string,
) {
  const promise = router.addClient(sink);
  await new Promise<void>((resolveTick) => setImmediate(resolveTick));
  const attach = pipe.sent.findLast((message) => message.method === "Target.attachToBrowserTarget");
  if (attach === undefined || attach.id === undefined) {
    throw new Error("Router did not send Target.attachToBrowserTarget.");
  }
  pipe.emit({ id: attach.id, result: { sessionId: browserSessionId } });
  return await promise;
}

function emitAttached(
  pipe: FakePipe,
  parentSessionId: string,
  childSessionId: string,
  type = "page",
): void {
  pipe.emit({
    method: "Target.attachedToTarget",
    sessionId: parentSessionId,
    params: {
      sessionId: childSessionId,
      targetInfo: { type, targetId: `target-${childSessionId}` },
      waitingForDebugger: false,
    },
  });
}

async function flush(): Promise<void> {
  await new Promise<void>((resolveTick) => setImmediate(resolveTick));
}

describe("createCdpRouter", () => {
  it("attaches a browser session per client and ignores the root browser target event", async () => {
    const pipe = createFakePipe();
    const router = createCdpRouter(pipe.pipe);
    const a = createSink();
    await addClient(router, pipe, a.sink, "browser-a");

    pipe.emit({
      method: "Target.attachedToTarget",
      params: {
        sessionId: "browser-a",
        targetInfo: { type: "browser", targetId: "target-browser" },
        waitingForDebugger: false,
      },
    });
    await flush();

    expect(a.messages).toEqual([]);
    expect(pipe.sent[0]).toEqual({
      id: expect.any(Number),
      method: "Target.attachToBrowserTarget",
      params: {},
    });
  });

  it("remaps command ids and returns responses to the owning client", async () => {
    const pipe = createFakePipe();
    const router = createCdpRouter(pipe.pipe);
    const a = createSink();
    const client = await addClient(router, pipe, a.sink, "browser-a");

    client.send({ id: 100, method: "Target.getTargets", params: {} });
    const forwarded = pipe.sent.findLast((entry) => entry.method === "Target.getTargets");
    expect(forwarded?.id).not.toBe(100);
    expect(forwarded?.sessionId).toBe("browser-a");

    pipe.emit({ id: forwarded?.id, result: { targetInfos: [] }, sessionId: "browser-a" });
    await flush();
    expect(a.messages).toEqual([{ id: 100, result: { targetInfos: [] } }]);
  });

  it("forwards flattened child session commands with the child session id", async () => {
    const pipe = createFakePipe();
    const router = createCdpRouter(pipe.pipe);
    const a = createSink();
    const client = await addClient(router, pipe, a.sink, "browser-a");
    emitAttached(pipe, "browser-a", "page-a");

    client.send({ id: 1, method: "Page.enable", params: {}, sessionId: "page-a" });
    const forwarded = pipe.sent.at(-1);
    expect(forwarded).toMatchObject({ method: "Page.enable", sessionId: "page-a" });
  });

  it("rejects a session owned by another client", async () => {
    const pipe = createFakePipe();
    const router = createCdpRouter(pipe.pipe);
    const a = createSink();
    const b = createSink();
    await addClient(router, pipe, a.sink, "browser-a");
    const clientB = await addClient(router, pipe, b.sink, "browser-b");
    emitAttached(pipe, "browser-a", "page-a");

    const sentBefore = pipe.sent.length;
    clientB.send({ id: 5, method: "Page.enable", params: {}, sessionId: "page-a" });
    await flush();

    expect(pipe.sent.length).toBe(sentBefore);
    expect(b.messages.at(-1)).toEqual({
      id: 5,
      error: { code: -32001, message: "Unknown CDP session." },
    });
  });

  it("routes child events only to the owning client", async () => {
    const pipe = createFakePipe();
    const router = createCdpRouter(pipe.pipe);
    const a = createSink();
    const b = createSink();
    await addClient(router, pipe, a.sink, "browser-a");
    await addClient(router, pipe, b.sink, "browser-b");
    emitAttached(pipe, "browser-a", "page-a");
    emitAttached(pipe, "browser-b", "page-b");

    pipe.emit({ method: "Page.loadEventFired", sessionId: "page-a", params: { timestamp: 1 } });
    pipe.emit({ method: "Page.loadEventFired", sessionId: "page-b", params: { timestamp: 2 } });
    await flush();

    expect(a.messages.filter((message) => message.method === "Page.loadEventFired")).toEqual([
      { method: "Page.loadEventFired", sessionId: "page-a", params: { timestamp: 1 } },
    ]);
    expect(b.messages.filter((message) => message.method === "Page.loadEventFired")).toEqual([
      { method: "Page.loadEventFired", sessionId: "page-b", params: { timestamp: 2 } },
    ]);
  });

  it("does not expose child session attach events to another client", async () => {
    const pipe = createFakePipe();
    const router = createCdpRouter(pipe.pipe);
    const a = createSink();
    const b = createSink();
    await addClient(router, pipe, a.sink, "browser-a");
    await addClient(router, pipe, b.sink, "browser-b");

    emitAttached(pipe, "browser-a", "page-a");
    await flush();

    expect(a.messages).toHaveLength(1);
    expect(a.messages[0]?.method).toBe("Target.attachedToTarget");
    expect(a.messages[0]?.sessionId).toBeUndefined();
    expect(b.messages).toEqual([]);
  });

  it("disconnects a client whose bounded queue overflows", async () => {
    const pipe = createFakePipe();
    const router = createCdpRouter(pipe.pipe, { maxQueueMessages: 2 });
    const a = createSink();
    await addClient(router, pipe, a.sink, "browser-a");
    emitAttached(pipe, "browser-a", "page-a");

    pipe.emit({ method: "Page.loadEventFired", sessionId: "page-a", params: {} });
    pipe.emit({ method: "Page.loadEventFired", sessionId: "page-a", params: {} });
    pipe.emit({ method: "Page.loadEventFired", sessionId: "page-a", params: {} });

    expect(a.close).toHaveBeenCalledTimes(1);
    expect(a.close).toHaveBeenCalledWith("slow_client");
    expect(a.messages).toEqual([]);
  });

  it("disconnects a client whose sink rejects a message", async () => {
    const pipe = createFakePipe();
    const router = createCdpRouter(pipe.pipe);
    const a = createSink({ accept: false });
    await addClient(router, pipe, a.sink, "browser-a");
    emitAttached(pipe, "browser-a", "page-a");

    pipe.emit({ method: "Page.loadEventFired", sessionId: "page-a", params: {} });
    await flush();

    expect(a.close).toHaveBeenCalledWith("slow_client");
  });

  it("times out a request and ignores the late response", async () => {
    const pipe = createFakePipe();
    const router = createCdpRouter(pipe.pipe, { requestTimeoutMs: 10 });
    const a = createSink();
    const client = await addClient(router, pipe, a.sink, "browser-a");

    client.send({ id: 9, method: "Target.getTargets", params: {} });
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 30));
    expect(a.messages).toEqual([
      { id: 9, error: { code: -32000, message: "CDP request timed out." } },
    ]);

    const forwarded = pipe.sent.at(-1);
    pipe.emit({ id: forwarded?.id, result: { targetInfos: [] } });
    await flush();
    expect(a.messages).toHaveLength(1);
  });

  it("disconnects only the requested client and keeps the pipe open", async () => {
    const pipe = createFakePipe();
    const router = createCdpRouter(pipe.pipe);
    const a = createSink();
    const b = createSink();
    const clientA = await addClient(router, pipe, a.sink, "browser-a");
    await addClient(router, pipe, b.sink, "browser-b");
    emitAttached(pipe, "browser-b", "page-b");

    await clientA.close();

    expect(pipe.sent.at(-1)).toEqual({
      id: expect.any(Number),
      method: "Target.detachFromTarget",
      params: { sessionId: "browser-a" },
    });
    pipe.emit({ id: pipe.sent.at(-1)?.id, result: {} });
    pipe.emit({ method: "Page.loadEventFired", sessionId: "page-b", params: {} });
    await flush();

    expect(a.close).toHaveBeenCalledWith("client_closed");
    expect(b.close).not.toHaveBeenCalled();
    expect(b.messages.at(-1)).toMatchObject({ method: "Page.loadEventFired" });
    expect(pipe.close).not.toHaveBeenCalled();
  });

  it("rejects Browser.close from a regular client", async () => {
    const pipe = createFakePipe();
    const router = createCdpRouter(pipe.pipe);
    const a = createSink();
    const client = await addClient(router, pipe, a.sink, "browser-a");
    const sentBefore = pipe.sent.length;

    client.send({ id: 3, method: "Browser.close", params: {} });
    await flush();

    expect(pipe.sent.length).toBe(sentBefore);
    expect(a.messages.at(-1)).toEqual({
      id: 3,
      error: { code: -32601, message: "Method is reserved for the lifecycle owner." },
    });
  });

  it("registers sessions created by Target.attachToTarget responses", async () => {
    const pipe = createFakePipe();
    const router = createCdpRouter(pipe.pipe);
    const a = createSink();
    const client = await addClient(router, pipe, a.sink, "browser-a");

    client.send({
      id: 11,
      method: "Target.attachToTarget",
      params: { targetId: "target-1", flatten: true },
    });
    const forwarded = pipe.sent.at(-1);
    pipe.emit({ id: forwarded?.id, result: { sessionId: "page-explicit" } });
    await flush();

    client.send({ id: 12, method: "Page.enable", params: {}, sessionId: "page-explicit" });
    expect(pipe.sent.at(-1)).toMatchObject({
      method: "Page.enable",
      sessionId: "page-explicit",
    });
  });

  it("removes ownership after Target.detachedFromTarget", async () => {
    const pipe = createFakePipe();
    const router = createCdpRouter(pipe.pipe);
    const a = createSink();
    const client = await addClient(router, pipe, a.sink, "browser-a");
    emitAttached(pipe, "browser-a", "page-a");

    pipe.emit({
      method: "Target.detachedFromTarget",
      sessionId: "browser-a",
      params: { sessionId: "page-a", targetId: "target-page-a" },
    });
    await flush();

    client.send({ id: 21, method: "Page.enable", params: {}, sessionId: "page-a" });
    await flush();
    expect(a.messages.at(-1)).toEqual({
      id: 21,
      error: { code: -32001, message: "Unknown CDP session." },
    });
  });

  it("closes pending requests and the pipe when the router closes", async () => {
    const pipe = createFakePipe();
    const router = createCdpRouter(pipe.pipe);
    const a = createSink();
    const client = await addClient(router, pipe, a.sink, "browser-a");

    client.send({ id: 31, method: "Target.getTargets", params: {} });
    await router.close();

    expect(pipe.close).toHaveBeenCalledTimes(1);
    expect(a.close).toHaveBeenCalledWith("router_closed");
    expect(a.messages.at(-1)).toEqual({
      id: 31,
      error: { code: -32000, message: "CDP connection closed." },
    });
  });

  it("rejects new clients after close", async () => {
    const pipe = createFakePipe();
    const router = createCdpRouter(pipe.pipe);
    await router.close();

    await expect(router.addClient(createSink().sink)).rejects.toThrow(
      "CDP router is closed.",
    );
  });
});
