import type { Context } from "hono";
import { stream } from "hono/streaming";
import type { EventBus, StoredEvent } from "./event-bus";

export const DEFAULT_HEARTBEAT_MS = 15_000;

export type EventStreamRegistry = {
  add(close: () => void): () => void;
  shutdown(): void;
  size(): number;
};

export function createEventStreamRegistry(): EventStreamRegistry {
  const connections = new Set<() => void>();

  return {
    add(close) {
      connections.add(close);
      return () => {
        connections.delete(close);
      };
    },
    shutdown() {
      for (const close of [...connections]) {
        try {
          close();
        } catch {}
      }
      connections.clear();
    },
    size() {
      return connections.size;
    },
  };
}

export type EventStreamOptions = {
  readonly events: EventBus;
  readonly connections: EventStreamRegistry;
  readonly heartbeatMs?: number;
};

export type EventStream = {
  open(context: Context, taskId: string | undefined): Response;
};

function parseLastEventId(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }

  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }

  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function formatEvent(stored: StoredEvent): string {
  const { type, ...data } = stored.event;
  return `id: ${stored.id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function createEventStream(options: EventStreamOptions): EventStream {
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;

  return {
    open(context, taskId) {
      context.header("Content-Type", "text/event-stream; charset=utf-8");
      context.header("Cache-Control", "no-cache");

      return stream(context, async (sse) => {
        const pending: StoredEvent[] = [];
        let isReplaying = true;
        let isClosed = false;
        let highestId = 0;
        let chain: Promise<void> = Promise.resolve();

        const enqueue = (write: () => Promise<void>): void => {
          chain = chain.then(write).catch(() => undefined);
        };

        const writeEvent = (stored: StoredEvent): void => {
          const id = Number(stored.id);
          enqueue(async () => {
            if (isClosed || id <= highestId) {
              return;
            }
            highestId = id;
            await sse.write(formatEvent(stored));
          });
        };

        const unsubscribe = options.events.subscribe((stored) => {
          if (taskId !== undefined && stored.event.taskId !== taskId) {
            return;
          }
          if (isReplaying) {
            pending.push(stored);
            return;
          }
          writeEvent(stored);
        });

        const lastEventId = parseLastEventId(context.req.header("Last-Event-ID"));
        if (lastEventId !== null) {
          for (const stored of options.events.list()) {
            if (taskId !== undefined && stored.event.taskId !== taskId) {
              continue;
            }
            if (Number(stored.id) <= lastEventId) {
              continue;
            }
            writeEvent(stored);
          }
        }

        isReplaying = false;
        for (const stored of pending) {
          writeEvent(stored);
        }
        pending.length = 0;

        const timer = setInterval(() => {
          enqueue(async () => {
            if (!isClosed) {
              await sse.write(": ping\n\n");
            }
          });
        }, heartbeatMs);
        timer.unref();

        let resolveDone = (): void => {};
        let unregister = (): void => {};
        const done = new Promise<void>((resolve) => {
          resolveDone = resolve;
        });

        const close = (): void => {
          if (isClosed) {
            return;
          }
          isClosed = true;
          clearInterval(timer);
          unsubscribe();
          unregister();
          resolveDone();
        };

        sse.onAbort(close);
        unregister = options.connections.add(() => {
          close();
          void sse.close();
        });

        await done;
        close();
      });
    },
  };
}
