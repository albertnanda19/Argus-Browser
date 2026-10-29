import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { CdpWireMessage } from "./cdp-pipe";
import type { CdpRouter, CdpRouterClient } from "./cdp-router";

const DEFAULT_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const SOCKET_CLOSE_TIMEOUT_MS = 500;
const WSS_CLOSE_TIMEOUT_MS = 500;
const SERVER_CLOSE_TIMEOUT_MS = 500;

export type CdpGatewayRouter = Pick<CdpRouter, "addClient">;

export type CdpGatewayOptions = {
  readonly router: CdpGatewayRouter;
  readonly apiToken: string;
  readonly capabilityToken?: string;
  readonly maxBufferedBytes?: number;
};

export type CdpGateway = {
  readonly port: number;
  readonly httpUrl: string;
  readonly webSocketDebuggerUrl: string;
  readonly capabilityToken: string;
  close(): Promise<void>;
};

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function isTokenEqual(candidate: string, expected: string): boolean {
  return timingSafeEqual(digest(candidate), digest(expected));
}

function readBearer(header: string | undefined): string | null {
  if (header === undefined) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

function isAllowedOrigin(origin: string | undefined): boolean {
  return origin === undefined || origin.startsWith("chrome-extension://");
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  const headers: Record<string, string | number> = {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (status === 401) {
    headers["WWW-Authenticate"] = "Bearer";
  }
  response.writeHead(status, headers);
  response.end(body);
}

function rejectUpgrade(socket: Socket, status: number): void {
  const phrase = status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Not Found";
  socket.write(
    `HTTP/1.1 ${status} ${phrase}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    () => socket.destroy(),
  );
}

function settleWithin(promise: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolveSettle) => {
    const timer = setTimeout(resolveSettle, timeoutMs);
    timer.unref?.();
    void promise.then(
      () => {
        clearTimeout(timer);
        resolveSettle();
      },
      () => {
        clearTimeout(timer);
        resolveSettle();
      },
    );
  });
}

function waitForSocketClose(socket: WebSocket, timeoutMs: number): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) {
    return Promise.resolve();
  }
  return new Promise<void>((resolveClose) => {
    const timer = setTimeout(() => {
      socket.terminate();
      resolveClose();
    }, timeoutMs);
    timer.unref?.();
    socket.once("close", () => {
      clearTimeout(timer);
      resolveClose();
    });
  });
}

function readMessage(data: RawData): string {
  if (typeof data === "string") {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  return data.toString("utf8");
}

function isCommand(value: unknown): value is {
  readonly id: number;
  readonly method: string;
  readonly params?: JsonObject;
  readonly sessionId?: string;
} {
  return (
    isRecord(value) &&
    typeof value.id === "number" &&
    typeof value.method === "string" &&
    (value.params === undefined || isRecord(value.params)) &&
    (value.sessionId === undefined || typeof value.sessionId === "string")
  );
}

export async function startCdpGateway(options: CdpGatewayOptions): Promise<CdpGateway> {
  if (options.apiToken.length === 0) {
    throw new Error("CDP gateway API token is required.");
  }
  const capabilityToken =
    options.capabilityToken ?? randomBytes(32).toString("base64url");
  if (capabilityToken.length === 0) {
    throw new Error("CDP gateway capability token is required.");
  }
  const maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  const browserId = randomBytes(12).toString("hex");
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: 64 * 1024 * 1024,
  });
  const sockets = new Set<WebSocket>();
  const routerClients = new Set<CdpRouterClient>();
  let isClosing = false;
  let closePromise: Promise<void> | null = null;

  const createWebSocketUrl = (port: number): string =>
    `ws://127.0.0.1:${port}/devtools/browser/${browserId}?token=${encodeURIComponent(
      capabilityToken,
    )}`;

  const server = createServer((request, response) => {
    const origin = request.headers.origin;
    if (!isAllowedOrigin(origin)) {
      sendJson(response, 403, { error: "Forbidden." });
      return;
    }
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "Method not allowed." });
      return;
    }
    const authorization = readBearer(request.headers.authorization);
    if (authorization === null || !isTokenEqual(authorization, options.apiToken)) {
      sendJson(response, 401, { error: "Unauthorized." });
      return;
    }

    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const address = server.address();
    if (address === null || typeof address === "string") {
      sendJson(response, 503, { error: "Gateway unavailable." });
      return;
    }
    const webSocketDebuggerUrl = createWebSocketUrl(address.port);

    if (url.pathname === "/json/version") {
      sendJson(response, 200, {
        Browser: "Chrome/Argus",
        "Protocol-Version": "1.3",
        "User-Agent": "Argus CDP Gateway",
        "V8-Version": "0",
        "WebKit-Version": "0",
        webSocketDebuggerUrl,
      });
      return;
    }

    if (url.pathname === "/json/list" || url.pathname === "/json") {
      sendJson(response, 200, [
        {
          description: "Argus CDP Gateway",
          id: browserId,
          title: "Argus",
          type: "page",
          url: "about:blank",
          webSocketDebuggerUrl,
        },
      ]);
      return;
    }

    sendJson(response, 404, { error: "Not found." });
  });

  server.on("clientError", (_error, socket) => {
    socket.destroy();
  });

  server.on("upgrade", (request: IncomingMessage, socket: Socket, head: Buffer) => {
    socket.on("error", () => undefined);

    if (!isAllowedOrigin(request.headers.origin)) {
      rejectUpgrade(socket, 403);
      return;
    }

    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (!url.pathname.startsWith("/devtools/browser/")) {
      rejectUpgrade(socket, 404);
      return;
    }

    const authorization = readBearer(request.headers.authorization);
    const queryToken = url.searchParams.get("token");
    const isAuthorized =
      (authorization !== null && isTokenEqual(authorization, options.apiToken)) ||
      (queryToken !== null && isTokenEqual(queryToken, capabilityToken));
    if (!isAuthorized) {
      rejectUpgrade(socket, 401);
      return;
    }

    wss.handleUpgrade(request, socket, head, (webSocket) => {
      wss.emit("connection", webSocket, request);
    });
  });

  wss.on("error", () => undefined);
  wss.on("connection", (webSocket: WebSocket) => {
    if (isClosing) {
      webSocket.close(1001, "Gateway closing.");
      return;
    }
    sockets.add(webSocket);
    webSocket.pause();

    let client: CdpRouterClient | null = null;
    let isSocketClosed = false;

    const detach = (): void => {
      if (client === null) {
        return;
      }
      const current = client;
      client = null;
      routerClients.delete(current);
      void current.close();
    };

    const sink = {
      send(message: CdpWireMessage): boolean {
        if (webSocket.readyState !== WebSocket.OPEN) {
          return false;
        }
        if (webSocket.bufferedAmount > maxBufferedBytes) {
          return false;
        }
        try {
          webSocket.send(JSON.stringify(message));
          return true;
        } catch {
          return false;
        }
      },
      close(): void {
        if (webSocket.readyState === WebSocket.OPEN) {
          webSocket.close(1001, "CDP client closed.");
          return;
        }
        webSocket.terminate();
      },
    };

    webSocket.on("close", () => {
      isSocketClosed = true;
      sockets.delete(webSocket);
      detach();
    });
    webSocket.on("error", () => {
      isSocketClosed = true;
      sockets.delete(webSocket);
      webSocket.terminate();
      detach();
    });

    void options.router
      .addClient(sink)
      .then((attached) => {
        if (isSocketClosed || isClosing) {
          void attached.close();
          return;
        }
        client = attached;
        routerClients.add(attached);
        webSocket.on("message", (data) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(readMessage(data));
          } catch {
            webSocket.close(1003, "Invalid CDP message.");
            return;
          }
          if (!isCommand(parsed)) {
            if (isRecord(parsed) && typeof parsed.id === "number") {
              sink.send({
                id: parsed.id,
                error: { code: -32600, message: "Invalid CDP message." },
              });
            } else {
              webSocket.close(1003, "Invalid CDP message.");
            }
            return;
          }
          try {
            attached.send(parsed);
          } catch {
            webSocket.close(1001, "CDP client unavailable.");
          }
        });
        webSocket.resume();
      })
      .catch(() => {
        webSocket.close(1011, "CDP session unavailable.");
      });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error): void => {
      server.removeListener("listening", onListening);
      rejectListen(error);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("CDP gateway did not receive a TCP port.");
  }
  const port = address.port;

  return {
    port,
    httpUrl: `http://127.0.0.1:${port}`,
    webSocketDebuggerUrl: createWebSocketUrl(port),
    capabilityToken,
    close() {
      closePromise ??= (async () => {
        isClosing = true;
        for (const client of routerClients) {
          try {
            client.rejectPending("CDP gateway closed.");
          } catch {}
        }
        const closingSockets = [...sockets].map((socket) => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.close(1001, "Gateway closing.");
          } else if (socket.readyState === WebSocket.CONNECTING) {
            socket.terminate();
          }
          return waitForSocketClose(socket, SOCKET_CLOSE_TIMEOUT_MS);
        });
        await Promise.all(closingSockets);
        for (const socket of sockets) {
          socket.terminate();
        }
        sockets.clear();
        routerClients.clear();
        await settleWithin(
          new Promise<void>((resolveClose) => {
            wss.close(() => resolveClose());
          }),
          WSS_CLOSE_TIMEOUT_MS,
        );
        server.closeAllConnections();
        await settleWithin(
          new Promise<void>((resolveClose) => {
            server.close(() => resolveClose());
          }),
          SERVER_CLOSE_TIMEOUT_MS,
        );
      })();
      return closePromise;
    },
  };
}
