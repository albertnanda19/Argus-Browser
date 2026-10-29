import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { type ClientOptions } from "ws";
import {
  startCdpGateway,
  type CdpGateway,
  type CdpGatewayRouter,
} from "./cdp-gateway";
import type { CdpClientSink, CdpRouterClient } from "./cdp-router";
import type { CdpWireMessage } from "./cdp-pipe";

const API_TOKEN = "gateway-test-api-token";
const CAPABILITY_TOKEN = "gateway-test-capability-token";

function createFakeRouter() {
  let sink: CdpClientSink | null = null;
  const send = vi.fn<(message: CdpWireMessage) => void>();
  const close = vi.fn(async () => undefined);
  const rejectPending = vi.fn<(message: string) => void>((message) => {
    sink?.send({ id: 900, error: { code: -32000, message } });
  });
  const routerClose = vi.fn(async () => undefined);
  let nextClient = 1;

  const router: CdpGatewayRouter & { close(): Promise<void> } = {
    async addClient(clientSink) {
      sink = clientSink;
      const client: CdpRouterClient = {
        id: `c_${nextClient++}`,
        send,
        rejectPending,
        close,
      };
      return client;
    },
    async close() {
      await routerClose();
    },
  };

  return {
    router,
    send,
    close,
    rejectPending,
    routerClose,
    get sink() {
      if (sink === null) {
        throw new Error("No router client was attached.");
      }
      return sink;
    },
  };
}

async function startGateway(router: CdpGatewayRouter): Promise<CdpGateway> {
  return await startCdpGateway({
    router,
    apiToken: API_TOKEN,
    capabilityToken: CAPABILITY_TOKEN,
  });
}

function waitForOpen(url: string, options?: ClientOptions): Promise<WebSocket> {
  return new Promise<WebSocket>((resolveOpen, rejectOpen) => {
    const socket = new WebSocket(url, options);
    socket.once("open", () => resolveOpen(socket));
    socket.once("error", (error) => rejectOpen(error));
  });
}

function waitForRejection(
  url: string,
  options?: ClientOptions,
): Promise<number> {
  return new Promise<number>((resolveReject, rejectReject) => {
    const socket = new WebSocket(url, options);
    socket.once("unexpected-response", (_request, response) => {
      const status = response.statusCode ?? 0;
      socket.terminate();
      resolveReject(status);
    });
    socket.once("open", () => {
      socket.close();
      rejectReject(new Error("WebSocket unexpectedly opened."));
    });
    socket.once("error", (error) => rejectReject(error));
  });
}

function waitForMessage(socket: WebSocket): Promise<CdpWireMessage> {
  return new Promise<CdpWireMessage>((resolveMessage, rejectMessage) => {
    socket.once("message", (data) => {
      resolveMessage(JSON.parse(String(data)) as CdpWireMessage);
    });
    socket.once("error", rejectMessage);
  });
}

function waitForTick(): Promise<void> {
  return new Promise<void>((resolveTick) => setImmediate(resolveTick));
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 2));
  }
  throw new Error("Condition was not met in time.");
}

function waitForClose(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) {
    return Promise.resolve();
  }
  return new Promise<void>((resolveClose) => {
    socket.once("close", () => resolveClose());
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("startCdpGateway", () => {
  it("rejects HTTP requests without a bearer token", async () => {
    const fake = createFakeRouter();
    const gateway = await startGateway(fake.router);
    try {
      const version = await fetch(`${gateway.httpUrl}/json/version`);
      expect(version.status).toBe(401);
      const body = await version.text();
      expect(body).not.toContain(API_TOKEN);
      expect(body).not.toContain(CAPABILITY_TOKEN);

      const list = await fetch(`${gateway.httpUrl}/json/list`);
      expect(list.status).toBe(401);
      expect(await list.text()).not.toContain(CAPABILITY_TOKEN);
    } finally {
      await gateway.close();
    }
  });

  it("rewrites /json/version to the gateway host and port", async () => {
    const fake = createFakeRouter();
    const gateway = await startGateway(fake.router);
    try {
      const response = await fetch(`${gateway.httpUrl}/json/version`, {
        headers: { Authorization: `Bearer ${API_TOKEN}` },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { webSocketDebuggerUrl: string };
      const url = new URL(body.webSocketDebuggerUrl);
      expect(url.protocol).toBe("ws:");
      expect(url.hostname).toBe("127.0.0.1");
      expect(Number(url.port)).toBe(gateway.port);
      expect(url.searchParams.get("token")).toBe(CAPABILITY_TOKEN);
      expect(body.webSocketDebuggerUrl).not.toContain("chrome");
    } finally {
      await gateway.close();
    }
  });

  it("returns a minimal and consistent /json/list", async () => {
    const fake = createFakeRouter();
    const gateway = await startGateway(fake.router);
    try {
      const response = await fetch(`${gateway.httpUrl}/json/list`, {
        headers: { Authorization: `Bearer ${API_TOKEN}` },
      });
      expect(response.status).toBe(200);
      const list = (await response.json()) as Array<{
        id: string;
        type: string;
        webSocketDebuggerUrl: string;
      }>;
      expect(list).toHaveLength(1);
      expect(list[0]?.type).toBe("page");
      expect(list[0]?.webSocketDebuggerUrl).toContain("token=");
      const version = await fetch(`${gateway.httpUrl}/json/version`, {
        headers: { Authorization: `Bearer ${API_TOKEN}` },
      });
      const versionBody = (await version.json()) as { webSocketDebuggerUrl: string };
      expect(list[0]?.webSocketDebuggerUrl).toBe(versionBody.webSocketDebuggerUrl);
    } finally {
      await gateway.close();
    }
  });

  it("rejects an HTTP request with a browser origin", async () => {
    const fake = createFakeRouter();
    const gateway = await startGateway(fake.router);
    try {
      const response = await fetch(`${gateway.httpUrl}/json/version`, {
        headers: {
          Authorization: `Bearer ${API_TOKEN}`,
          Origin: "http://evil.example",
        },
      });
      expect(response.status).toBe(403);
      const body = await response.text();
      expect(body).not.toContain(CAPABILITY_TOKEN);
      expect(body).not.toContain(API_TOKEN);
    } finally {
      await gateway.close();
    }
  });

  it("rejects a WebSocket connection without a token", async () => {
    const fake = createFakeRouter();
    const gateway = await startGateway(fake.router);
    try {
      const status = await waitForRejection(
        `ws://127.0.0.1:${gateway.port}/devtools/browser/test`,
      );
      expect(status).toBe(401);
      expect(fake.routerClose).not.toHaveBeenCalled();
    } finally {
      await gateway.close();
    }
  });

  it("accepts a WebSocket capability query", async () => {
    const fake = createFakeRouter();
    const gateway = await startGateway(fake.router);
    try {
      const version = (await (
        await fetch(`${gateway.httpUrl}/json/version`, {
          headers: { Authorization: `Bearer ${API_TOKEN}` },
        })
      ).json()) as { webSocketDebuggerUrl: string };
      const socket = await waitForOpen(version.webSocketDebuggerUrl);
      socket.send(JSON.stringify({ id: 4, method: "Target.getTargets", params: {} }));
      await waitForCondition(() => fake.send.mock.calls.length > 0);
      expect(fake.send).toHaveBeenCalledWith({
        id: 4,
        method: "Target.getTargets",
        params: {},
      });

      const messagePromise = waitForMessage(socket);
      const accepted = fake.sink.send({ id: 4, result: { targetInfos: [] } });
      expect(accepted).toBe(true);
      expect(await messagePromise).toEqual({ id: 4, result: { targetInfos: [] } });
      socket.close();
    } finally {
      await gateway.close();
    }
  });

  it("accepts a WebSocket bearer header", async () => {
    const fake = createFakeRouter();
    const gateway = await startGateway(fake.router);
    try {
      const socket = await waitForOpen(
        `ws://127.0.0.1:${gateway.port}/devtools/browser/test`,
        { headers: { Authorization: `Bearer ${API_TOKEN}` } },
      );
      expect(socket.readyState).toBe(WebSocket.OPEN);
      socket.close();
    } finally {
      await gateway.close();
    }
  });

  it("rejects a WebSocket request with a browser origin", async () => {
    const fake = createFakeRouter();
    const gateway = await startGateway(fake.router);
    try {
      const status = await waitForRejection(
        `ws://127.0.0.1:${gateway.port}/devtools/browser/test?token=${CAPABILITY_TOKEN}`,
        { origin: "http://evil.example" },
      );
      expect(status).toBe(403);
    } finally {
      await gateway.close();
    }
  });

  it("does not close the router when the gateway closes", async () => {
    const fake = createFakeRouter();
    const gateway = await startGateway(fake.router);
    const socket = await waitForOpen(
      `ws://127.0.0.1:${gateway.port}/devtools/browser/test`,
      { headers: { Authorization: `Bearer ${API_TOKEN}` } },
    );

    await gateway.close();
    await waitForClose(socket);
    await waitForTick();

    expect(fake.routerClose).not.toHaveBeenCalled();
    expect(socket.readyState).toBe(WebSocket.CLOSED);
    expect(fake.close).toHaveBeenCalled();
    await gateway.close();
  });

  it("rejects pending requests with a clear error and closes the listener", async () => {
    const fake = createFakeRouter();
    const gateway = await startGateway(fake.router);
    const socket = await waitForOpen(
      `ws://127.0.0.1:${gateway.port}/devtools/browser/test`,
      { headers: { Authorization: `Bearer ${API_TOKEN}` } },
    );
    const messagePromise = waitForMessage(socket);

    await gateway.close();

    expect(fake.rejectPending).toHaveBeenCalledWith("CDP gateway closed.");
    expect(await messagePromise).toEqual({
      id: 900,
      error: { code: -32000, message: "CDP gateway closed." },
    });
    await waitForClose(socket);
    await expect(fetch(`${gateway.httpUrl}/json/version`)).rejects.toThrow();
    await expect(gateway.close()).resolves.toBeUndefined();
  });

  it("does not reflect tokens in unknown route errors", async () => {
    const fake = createFakeRouter();
    const gateway = await startGateway(fake.router);
    try {
      const response = await fetch(`${gateway.httpUrl}/unknown?token=${CAPABILITY_TOKEN}`, {
        headers: { Authorization: `Bearer ${API_TOKEN}` },
      });
      expect(response.status).toBe(404);
      const body = await response.text();
      expect(body).not.toContain(CAPABILITY_TOKEN);
      expect(body).not.toContain(API_TOKEN);
    } finally {
      await gateway.close();
    }
  });
});
