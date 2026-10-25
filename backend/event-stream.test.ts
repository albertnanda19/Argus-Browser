import { once } from "node:events";
import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ChromeInstallerState } from "../shared/chrome-installer";
import type { DomainEvent } from "../shared/event";
import { createApp } from "./app";
import { createEventBus, type EventBus } from "./event-bus";
import { createEventStreamRegistry, type EventStreamRegistry } from "./event-stream";
import { createTaskManager } from "./task-manager";

const token = "test-token";
const allowedOrigin = "http://127.0.0.1:5173";
const authorization = `Bearer ${token}`;
const fixedNow = "2026-10-25T10:00:00.000Z";
const taskA = "t_0000000000000001";
const taskB = "t_0000000000000002";

const readyState: ChromeInstallerState = {
  status: "ready",
  source: "managed",
  version: "156.0.8078.47",
  progress: null,
  error: null,
};

type Harness = {
  readonly app: Hono;
  readonly events: EventBus;
  readonly connections: EventStreamRegistry;
};

function createHarness(heartbeatMs = 60_000): Harness {
  const events = createEventBus();
  const connections = createEventStreamRegistry();
  const app = createApp({
    token,
    allowedOrigin,
    chromeInstaller: {
      getState: () => readyState,
      start: async () => readyState,
      setLocalBinary: async () => ({ ok: true, path: "/tmp/chrome", version: "1" }),
      clearLocalBinary: async () => readyState,
    },
    profiles: {
      list: async () => [],
      create: async () => {
        throw new Error("Unused profile creation.");
      },
      delete: async () => undefined,
    },
    sessions: {
      start: async () => {
        throw new Error("Unused session start.");
      },
      listActive: () => [],
      get: () => null,
      close: async () => {
        throw new Error("Unused session close.");
      },
    },
    tasks: createTaskManager({ sessions: { get: () => null }, events }),
    actions: {
      execute: async () => {
        throw new Error("Unused action execution.");
      },
    },
    events,
    eventConnections: connections,
    eventHeartbeatMs: heartbeatMs,
  });

  return { app, events, connections };
}

function withAuth(init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: { ...init.headers, Authorization: authorization },
  };
}

function completed(taskId = taskA): DomainEvent {
  return { type: "task.completed", taskId, result: {}, at: fixedNow };
}

function cancelled(taskId = taskA): DomainEvent {
  return { type: "task.cancelled", taskId, reason: "Task dibatalkan.", at: fixedNow };
}

function failed(taskId = taskA): DomainEvent {
  return { type: "task.failed", taskId, reason: "Gagal.", at: fixedNow };
}

function stepWithoutTask(): DomainEvent {
  return {
    type: "step",
    taskId: null,
    action: "click",
    selector: "#submit",
    at: fixedNow,
  };
}

type SseFrame = {
  readonly comment: string | null;
  readonly id: string | null;
  readonly event: string | null;
  readonly data: string | null;
};

function parseFrame(raw: string): SseFrame {
  let comment: string | null = null;
  let id: string | null = null;
  let event: string | null = null;
  let data: string | null = null;

  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) {
      comment = line.slice(1).trim();
      continue;
    }

    const separator = line.indexOf(":");
    if (separator === -1) {
      continue;
    }

    const field = line.slice(0, separator);
    const value = line.slice(separator + 1).replace(/^ /, "");
    if (field === "id") {
      id = value;
    }
    if (field === "event") {
      event = value;
    }
    if (field === "data") {
      data = value;
    }
  }

  return { comment, id, event, data };
}

class SseClient {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffer = "";

  constructor(response: Response) {
    if (response.body === null) {
      throw new Error("Response body is missing.");
    }
    this.reader = response.body.getReader();
  }

  async nextFrame(): Promise<string> {
    while (true) {
      const boundary = this.buffer.indexOf("\n\n");
      if (boundary !== -1) {
        const frame = this.buffer.slice(0, boundary);
        this.buffer = this.buffer.slice(boundary + 2);
        return frame;
      }

      const chunk = await this.reader.read();
      if (chunk.done) {
        throw new Error("Stream ended before a frame arrived.");
      }
      this.buffer += this.decoder.decode(chunk.value, { stream: true });
    }
  }

  async readToEnd(): Promise<void> {
    while (!(await this.reader.read()).done) {
      continue;
    }
  }

  async close(): Promise<void> {
    await this.reader.cancel();
  }
}

async function waitFor(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (!check()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Condition was not met in time.");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function openStream(
  harness: Harness,
  query = "",
  headers: Record<string, string> = {},
): Promise<{ readonly response: Response; readonly client: SseClient }> {
  const response = await harness.app.request(`/v1/events${query}`, withAuth({ headers }));
  return { response, client: new SseClient(response) };
}

describe("GET /v1/events", () => {
  it("returns an SSE response with the required headers", async () => {
    const harness = createHarness();
    const { response, client } = await openStream(harness);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-cache");

    await client.close();
  });

  it("streams a live event frame with the bus id and event type", async () => {
    const harness = createHarness();
    const { client } = await openStream(harness);

    harness.events.publish(completed());
    const frame = parseFrame(await client.nextFrame());

    expect(frame).toEqual({
      comment: null,
      id: "1",
      event: "task.completed",
      data: JSON.stringify({ taskId: taskA, result: {}, at: fixedNow }),
    });

    await client.close();
  });

  it("filters events by taskId and keeps sending heartbeats", async () => {
    const harness = createHarness(100);
    const { client } = await openStream(harness, `?taskId=${taskA}`);

    harness.events.publish(failed(taskB));
    harness.events.publish(cancelled(taskA));

    const event = parseFrame(await client.nextFrame());
    expect(event.id).toBe("2");
    expect(event.event).toBe("task.cancelled");
    expect(event.data).toBe(
      JSON.stringify({ taskId: taskA, reason: "Task dibatalkan.", at: fixedNow }),
    );

    const heartbeat = parseFrame(await client.nextFrame());
    expect(heartbeat.comment).toBe("ping");
    expect(heartbeat.id).toBeNull();
    expect(heartbeat.event).toBeNull();

    await client.close();
  });

  it("does not deliver a step without a task to a task-filtered stream", async () => {
    const harness = createHarness(100);
    const { client } = await openStream(harness, `?taskId=${taskA}`);

    harness.events.publish(stepWithoutTask());
    harness.events.publish(completed());

    const event = parseFrame(await client.nextFrame());
    expect(event.id).toBe("2");
    expect(event.event).toBe("task.completed");
    expect(event.data).toBe(JSON.stringify({ taskId: taskA, result: {}, at: fixedNow }));

    await client.close();
  });

  it("replays buffered events after Last-Event-ID without duplicates", async () => {
    const harness = createHarness();
    harness.events.publish(completed());
    harness.events.publish(failed());
    harness.events.publish(cancelled());

    const { client } = await openStream(harness, "", { "Last-Event-ID": "1" });

    const second = parseFrame(await client.nextFrame());
    const third = parseFrame(await client.nextFrame());
    expect([second.id, second.event]).toEqual(["2", "task.failed"]);
    expect([third.id, third.event]).toEqual(["3", "task.cancelled"]);

    harness.events.publish(completed(taskB));
    const live = parseFrame(await client.nextFrame());
    expect([live.id, live.event]).toEqual(["4", "task.completed"]);
    expect(JSON.parse(live.data ?? "{}")).toMatchObject({ taskId: taskB });

    await client.close();
  });

  it("holds live events until replay finishes and keeps ids ascending", async () => {
    const harness = createHarness();
    harness.events.publish(completed());
    harness.events.publish(failed());
    harness.events.publish(cancelled());

    const { client } = await openStream(harness, "", { "Last-Event-ID": "0" });
    harness.events.publish(completed(taskB));

    const ids: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const frame = parseFrame(await client.nextFrame());
      if (frame.id !== null) {
        ids.push(frame.id);
      }
    }

    expect(ids).toEqual(["1", "2", "3", "4"]);
    await client.close();
  });

  it.each(["not-a-number", "-1", "999"])(
    "ignores an unusable Last-Event-ID (%s) and starts live",
    async (lastEventId) => {
      const harness = createHarness();
      harness.events.publish(completed());

      const { client } = await openStream(harness, "", { "Last-Event-ID": lastEventId });
      harness.events.publish(failed());

      const frame = parseFrame(await client.nextFrame());
      expect(frame.id).toBe("2");
      expect(frame.event).toBe("task.failed");

      await client.close();
    },
  );

  it("replays every buffered event for Last-Event-ID 0", async () => {
    const harness = createHarness();
    harness.events.publish(completed());
    harness.events.publish(failed());

    const { client } = await openStream(harness, "", { "Last-Event-ID": "0" });
    const first = parseFrame(await client.nextFrame());
    const second = parseFrame(await client.nextFrame());

    expect([first.id, second.id]).toEqual(["1", "2"]);
    await client.close();
  });

  it("releases the bus subscription and registry entry when the client aborts", async () => {
    const harness = createHarness(20);
    const { client } = await openStream(harness, `?taskId=${taskA}`);

    expect(harness.events.subscriberCount()).toBe(1);
    expect(harness.connections.size()).toBe(1);

    harness.events.publish(completed());
    await client.nextFrame();
    await client.close();

    await waitFor(() => harness.events.subscriberCount() === 0);
    expect(harness.connections.size()).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(harness.events.subscriberCount()).toBe(0);
    expect(harness.connections.size()).toBe(0);
  });

  it("closes every stream on registry shutdown and is idempotent", async () => {
    const harness = createHarness();
    const { client } = await openStream(harness, "", { "Last-Event-ID": "0" });
    harness.events.publish(completed());
    await client.nextFrame();

    expect(harness.events.subscriberCount()).toBe(1);

    harness.connections.shutdown();
    await waitFor(() => harness.events.subscriberCount() === 0);
    expect(harness.connections.size()).toBe(0);
    await client.readToEnd();

    expect(() => harness.connections.shutdown()).not.toThrow();
    expect(() => harness.connections.shutdown()).not.toThrow();

    harness.events.publish(failed());
    expect(harness.events.subscriberCount()).toBe(0);
  });

  it("lets a real http server finish closing after registry shutdown", async () => {
    const harness = createHarness();
    const server = serve({
      fetch: harness.app.fetch,
      hostname: "127.0.0.1",
      port: 0,
    });
    await once(server, "listening");

    try {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Server did not expose a TCP address.");
      }

      const response = await fetch(`http://127.0.0.1:${address.port}/v1/events`, withAuth());
      expect(response.status).toBe(200);
      const client = new SseClient(response);

      harness.events.publish(completed());
      parseFrame(await client.nextFrame());
      expect(harness.events.subscriberCount()).toBe(1);

      harness.connections.shutdown();
      await client.readToEnd();

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Server close did not finish.")), 2_000);
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    } finally {
      harness.connections.shutdown();
      if (server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  });

  it("requires a bearer token and rejects a token in the query string", async () => {
    const harness = createHarness();
    const missing = await harness.app.request("/v1/events");
    const query = await harness.app.request(`/v1/events?token=${token}`);

    expect(missing.status).toBe(401);
    expect(query.status).toBe(401);
  });

  it.each(["abc", "t_1234", "t_000000000000000g", ""])(
    "rejects an invalid taskId (%j) with 400",
    async (taskId) => {
      const harness = createHarness();
      const response = await harness.app.request(`/v1/events?taskId=${taskId}`, withAuth());

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        type: "about:blank",
        title: "Bad Request",
        status: 400,
        detail: "Id task tidak valid.",
      });
    },
  );

  it("allows Last-Event-ID in CORS preflight without a wildcard", async () => {
    const harness = createHarness();
    const response = await harness.app.request("/v1/events", {
      method: "OPTIONS",
      headers: {
        Origin: allowedOrigin,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization,last-event-id",
      },
    });

    expect(response.status).toBe(204);
    const allowedHeaders = response.headers.get("access-control-allow-headers") ?? "";
    expect(allowedHeaders).toContain("Authorization");
    expect(allowedHeaders).toContain("Content-Type");
    expect(allowedHeaders).toContain("Idempotency-Key");
    expect(allowedHeaders).toContain("Last-Event-ID");
    expect(allowedHeaders).not.toContain("*");
  });
});
