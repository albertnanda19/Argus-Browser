import { randomBytes } from "node:crypto";
import type { CdpWireMessage } from "./cdp-pipe";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_ATTACH_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_QUEUE_MESSAGES = 1_000;
const LIFECYCLE_METHODS = new Set([
  "Browser.close",
  "Browser.crash",
  "Browser.crashGpuProcess",
  "Target.attachToBrowserTarget",
]);

export type CdpRouterTransport = {
  readonly pid: number;
  send(message: CdpWireMessage): void;
  onMessage(listener: (message: CdpWireMessage) => void): void;
  onClose(listener: (error?: Error) => void): void;
  close(): Promise<void>;
};

export type CdpClientSink = {
  send(message: CdpWireMessage): boolean;
  close(reason: string): void;
};

export type CdpRouterClient = {
  readonly id: string;
  send(message: CdpWireMessage): void;
  close(): Promise<void>;
};

export type CdpRouterOptions = {
  readonly requestTimeoutMs?: number;
  readonly attachTimeoutMs?: number;
  readonly maxQueueMessages?: number;
};

export type CdpRouter = {
  readonly pid: number;
  addClient(sink: CdpClientSink): Promise<CdpRouterClient>;
  close(): Promise<void>;
};

type SessionRecord = {
  readonly clientId: string;
  readonly parent: string | null;
  readonly isBrowser: boolean;
};

type ClientState = {
  readonly id: string;
  readonly sink: CdpClientSink;
  readonly browserSessionId: string;
  isClosed: boolean;
  queue: CdpWireMessage[];
  isFlushing: boolean;
  closePromise: Promise<void> | null;
};

type PendingRequest = {
  readonly kind: "client" | "control";
  readonly clientId: string | null;
  readonly clientRequestId: number | null;
  readonly method: string;
  readonly sessionId: string | null;
  readonly targetSessionId: string | null;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly resolveControl: ((message: CdpWireMessage) => void) | null;
  readonly rejectControl: ((error: Error) => void) | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorResponse(id: number, code: number, message: string): CdpWireMessage {
  return { id, error: { code, message } };
}

function sanitizedError(error: unknown): { readonly code: number; readonly message: string } {
  if (isRecord(error) && typeof error.code === "number" && typeof error.message === "string") {
    const message = error.message.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 500);
    return {
      code: error.code,
      message: message.length === 0 ? "CDP command failed." : message,
    };
  }
  return { code: -32000, message: "CDP command failed." };
}

export function createCdpRouter(
  transport: CdpRouterTransport,
  options: CdpRouterOptions = {},
): CdpRouter {
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const attachTimeoutMs = options.attachTimeoutMs ?? DEFAULT_ATTACH_TIMEOUT_MS;
  const maxQueueMessages = options.maxQueueMessages ?? DEFAULT_MAX_QUEUE_MESSAGES;
  const clients = new Map<string, ClientState>();
  const sessions = new Map<string, SessionRecord>();
  const pending = new Map<number, PendingRequest>();
  let nextPipeId = 1;
  let isRouterClosed = false;
  let closePromise: Promise<void> | null = null;

  const drainClient = (client: ClientState): void => {
    while (!client.isClosed && client.queue.length > 0) {
      const message = client.queue.shift();
      if (message === undefined) {
        return;
      }
      let accepted = false;
      try {
        accepted = client.sink.send(message);
      } catch {
        accepted = false;
      }
      if (!accepted) {
        void closeClient(client, "slow_client");
        return;
      }
    }
    client.isFlushing = false;
  };

  const enqueue = (client: ClientState, message: CdpWireMessage): void => {
    if (client.isClosed) {
      return;
    }
    if (client.queue.length >= maxQueueMessages) {
      void closeClient(client, "slow_client");
      return;
    }
    client.queue.push(message);
    if (!client.isFlushing) {
      client.isFlushing = true;
      queueMicrotask(() => drainClient(client));
    }
  };

  const clearPendingForClient = (clientId: string): void => {
    for (const [pipeId, entry] of pending) {
      if (entry.clientId === clientId) {
        clearTimeout(entry.timer);
        pending.delete(pipeId);
      }
    }
  };

  const closeClient = (client: ClientState, reason: string): Promise<void> => {
    if (client.closePromise !== null) {
      return client.closePromise;
    }

    client.isClosed = true;
    client.queue = [];
    client.isFlushing = false;
    clients.delete(client.id);
    clearPendingForClient(client.id);

    for (const [sessionId, record] of sessions) {
      if (record.clientId === client.id) {
        sessions.delete(sessionId);
      }
    }

    try {
      client.sink.close(reason);
    } catch {}

    if (!isRouterClosed) {
      try {
        transport.send({
          id: nextPipeId++,
          method: "Target.detachFromTarget",
          params: { sessionId: client.browserSessionId },
        });
      } catch {}
    }

    client.closePromise = Promise.resolve();
    return client.closePromise;
  };

  const rejectClientRequests = (message: string): void => {
    for (const [pipeId, entry] of pending) {
      if (entry.kind !== "client" || entry.clientId === null || entry.clientRequestId === null) {
        continue;
      }
      const client = clients.get(entry.clientId);
      if (client === undefined) {
        clearTimeout(entry.timer);
        pending.delete(pipeId);
        continue;
      }
      clearTimeout(entry.timer);
      pending.delete(pipeId);
      enqueue(client, errorResponse(entry.clientRequestId, -32000, message));
      drainClient(client);
    }
  };

  const rejectControlRequests = (message: string): void => {
    for (const [pipeId, entry] of pending) {
      if (entry.kind === "control") {
        clearTimeout(entry.timer);
        pending.delete(pipeId);
        entry.rejectControl?.(new Error(message));
      }
    }
  };

  const handlePipeClose = (): void => {
    if (isRouterClosed) {
      return;
    }
    isRouterClosed = true;
    rejectClientRequests("CDP connection closed.");
    rejectControlRequests("CDP connection closed.");
    for (const client of [...clients.values()]) {
      void closeClient(client, "cdp_closed");
    }
  };

  const handleResponse = (message: CdpWireMessage): void => {
    if (typeof message.id !== "number") {
      return;
    }
    const entry = pending.get(message.id);
    if (entry === undefined) {
      return;
    }
    pending.delete(message.id);
    clearTimeout(entry.timer);

    if (entry.kind === "control") {
      if (isRecord(message.error)) {
        entry.rejectControl?.(new Error("CDP browser session attach failed."));
        return;
      }
      entry.resolveControl?.(message);
      return;
    }

    if (entry.clientId === null || entry.clientRequestId === null) {
      return;
    }
    const client = clients.get(entry.clientId);
    if (client === undefined || client.isClosed) {
      return;
    }

    if (isRecord(message.error)) {
      enqueue(client, { id: entry.clientRequestId, error: sanitizedError(message.error) });
      return;
    }

    const result = isRecord(message.result) ? message.result : {};
    if (entry.method === "Target.attachToTarget" && typeof result.sessionId === "string") {
      sessions.set(result.sessionId, {
        clientId: client.id,
        parent: entry.sessionId,
        isBrowser: false,
      });
    }
    if (entry.method === "Target.detachFromTarget" && entry.targetSessionId !== null) {
      sessions.delete(entry.targetSessionId);
    }

    const envelope =
      entry.sessionId === client.browserSessionId || entry.sessionId === null
        ? {}
        : { sessionId: entry.sessionId };
    enqueue(client, { id: entry.clientRequestId, result, ...envelope });
  };

  const handleEvent = (message: CdpWireMessage): void => {
    const envelope = message.sessionId;
    const params = isRecord(message.params) ? message.params : null;

    if (message.method === "Target.attachedToTarget" && params !== null) {
      const childSessionId = typeof params.sessionId === "string" ? params.sessionId : null;
      const targetInfo = isRecord(params.targetInfo) ? params.targetInfo : null;
      if (envelope === undefined) {
        if (childSessionId !== null && targetInfo?.type === "browser") {
          return;
        }
      } else if (childSessionId !== null) {
        const parent = sessions.get(envelope);
        if (parent !== undefined) {
          sessions.set(childSessionId, {
            clientId: parent.clientId,
            parent: envelope,
            isBrowser: false,
          });
          const client = clients.get(parent.clientId);
          if (client !== undefined) {
            enqueue(client, {
              method: message.method,
              params: message.params,
              ...(parent.isBrowser ? {} : { sessionId: envelope }),
            });
          }
          return;
        }
      }
    }

    if (message.method === "Target.detachedFromTarget" && params !== null) {
      const childSessionId = typeof params.sessionId === "string" ? params.sessionId : null;
      if (childSessionId !== null) {
        const child = sessions.get(childSessionId);
        if (child !== undefined) {
          sessions.delete(childSessionId);
          if (child.isBrowser) {
            const client = clients.get(child.clientId);
            if (client !== undefined) {
              void closeClient(client, "cdp_detached");
            }
            return;
          }
          const client = clients.get(child.clientId);
          if (client !== undefined) {
            const parentEnvelope =
              child.parent === null || child.parent === client.browserSessionId
                ? {}
                : { sessionId: child.parent };
            enqueue(client, {
              method: message.method,
              params: message.params,
              ...parentEnvelope,
            });
          }
          return;
        }
      }
    }

    if (envelope === undefined) {
      return;
    }
    const record = sessions.get(envelope);
    if (record === undefined) {
      return;
    }
    const client = clients.get(record.clientId);
    if (client === undefined) {
      return;
    }
    if (record.isBrowser) {
      enqueue(client, { method: message.method, params: message.params });
      return;
    }
    enqueue(client, message);
  };

  const handleMessage = (message: CdpWireMessage): void => {
    if (typeof message.id === "number") {
      handleResponse(message);
      return;
    }
    if (typeof message.method === "string") {
      handleEvent(message);
    }
  };

  transport.onMessage(handleMessage);
  transport.onClose(handlePipeClose);

  const sendControl = (method: string, params: Record<string, unknown>): Promise<CdpWireMessage> =>
    new Promise<CdpWireMessage>((resolveControl, rejectControl) => {
      const id = nextPipeId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectControl(new Error("CDP browser session attach timed out."));
      }, attachTimeoutMs);
      timer.unref?.();
      pending.set(id, {
        kind: "control",
        clientId: null,
        clientRequestId: null,
        method,
        sessionId: null,
        targetSessionId: null,
        timer,
        resolveControl,
        rejectControl,
      });
      try {
        transport.send({ id, method, params });
      } catch {
        clearTimeout(timer);
        pending.delete(id);
        rejectControl(new Error("CDP connection closed."));
      }
    });

  const router: CdpRouter = {
    pid: transport.pid,
    async addClient(sink) {
      if (isRouterClosed) {
        throw new Error("CDP router is closed.");
      }
      const response = await sendControl("Target.attachToBrowserTarget", {});
      if (!isRecord(response.result) || typeof response.result.sessionId !== "string") {
        throw new Error("CDP browser session attach failed.");
      }
      const browserSessionId = response.result.sessionId;
      if (sessions.has(browserSessionId)) {
        throw new Error("CDP browser session attach failed.");
      }

      const client: ClientState = {
        id: `c_${randomBytes(8).toString("hex")}`,
        sink,
        browserSessionId,
        isClosed: false,
        queue: [],
        isFlushing: false,
        closePromise: null,
      };
      clients.set(client.id, client);
      sessions.set(browserSessionId, {
        clientId: client.id,
        parent: null,
        isBrowser: true,
      });

      return {
        id: client.id,
        send(message) {
          if (client.isClosed) {
            throw new Error("CDP client is closed.");
          }
          if (typeof message.id !== "number" || typeof message.method !== "string") {
            throw new Error("CDP client message is invalid.");
          }
          const requestId = message.id;
          const method = message.method;
          if (LIFECYCLE_METHODS.has(method)) {
            enqueue(client, {
              id: requestId,
              error: {
                code: -32601,
                message: "Method is reserved for the lifecycle owner.",
              },
            });
            return;
          }

          let envelope: string | null = browserSessionId;
          if (message.sessionId !== undefined) {
            const session = sessions.get(message.sessionId);
            if (session === undefined || session.clientId !== client.id) {
              enqueue(
                client,
                errorResponse(requestId, -32001, "Unknown CDP session."),
              );
              return;
            }
            envelope = session.isBrowser ? null : message.sessionId;
          }

          const pipeId = nextPipeId++;
          const timer = setTimeout(() => {
            pending.delete(pipeId);
            enqueue(client, errorResponse(requestId, -32000, "CDP request timed out."));
          }, requestTimeoutMs);
          timer.unref?.();
          pending.set(pipeId, {
            kind: "client",
            clientId: client.id,
            clientRequestId: requestId,
            method,
            sessionId: envelope,
            targetSessionId:
              method === "Target.detachFromTarget" &&
              isRecord(message.params) &&
              typeof message.params.sessionId === "string"
                ? message.params.sessionId
                : null,
            timer,
            resolveControl: null,
            rejectControl: null,
          });

          try {
            transport.send({
              id: pipeId,
              method,
              params: message.params ?? {},
              ...(envelope === null ? {} : { sessionId: envelope }),
            });
          } catch {
            clearTimeout(timer);
            pending.delete(pipeId);
            enqueue(client, errorResponse(requestId, -32000, "CDP request failed."));
          }
        },
        close() {
          return closeClient(client, "client_closed");
        },
      };
    },
    close() {
      closePromise ??= (async () => {
        if (isRouterClosed) {
          await transport.close();
          return;
        }
        isRouterClosed = true;
        rejectClientRequests("CDP connection closed.");
        rejectControlRequests("CDP connection closed.");
        for (const client of [...clients.values()]) {
          await closeClient(client, "router_closed");
        }
        await transport.close();
      })();
      return closePromise;
    },
  };

  return router;
}
