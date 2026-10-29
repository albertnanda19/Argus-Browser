import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChromeInstallerState } from "../shared/chrome-installer";
import type { Profile } from "../shared/profile";
import type { Session } from "../shared/session";
import { createOpenApiDocument } from "../shared/openapi";
import { createApp, type ProfileService, type SessionService } from "./app";
import { createEventBus } from "./event-bus";
import { createEventStreamRegistry } from "./event-stream";
import { createTaskManager } from "./task-manager";

vi.mock("../shared/openapi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/openapi")>();
  return { ...actual, createOpenApiDocument: vi.fn(actual.createOpenApiDocument) };
});

const token = "test-token";
const allowedOrigin = "http://127.0.0.1:5173";
const authorization = `Bearer ${token}`;
const now = "2026-10-25T10:00:00.000Z";

const readyState: ChromeInstallerState = {
  status: "ready",
  source: "managed",
  version: "156.0.8078.47",
  progress: null,
  error: null,
};

function createHarness() {
  const events = createEventBus();
  const session: Session = {
    id: "s_0000000000000001",
    profileId: "p_0000000000000001",
    status: "ready",
    startedAt: now,
    endedAt: null,
    pid: null,
  };

  const sessions: SessionService = {
    start: async () => session,
    listActive: () => [session],
    get: (sessionId) => (sessionId === session.id ? session : null),
    close: async () => ({ ...session, status: "closed", endedAt: now }),
  };

  const profiles: ProfileService = {
    list: async (): Promise<Profile[]> => [],
    create: async (name: string) => ({
      id: "p_0000000000000001",
      name,
      createdAt: now,
      lastUsedAt: null,
    }),
    delete: async () => undefined,
  };

  return createApp({
    token,
    allowedOrigin,
    chromeInstaller: {
      getState: () => readyState,
      start: async () => readyState,
      setLocalBinary: async () => ({ ok: true, path: "/chrome", version: "1" }),
      clearLocalBinary: async () => readyState,
    },
    profiles,
    profilePolicies: {
      get: async () => {
        throw new Error("Unused profile policy lookup.");
      },
      set: async () => {
        throw new Error("Unused profile policy update.");
      },
    },
    sessions,
    tasks: createTaskManager({ sessions, events, now: () => new Date(now) }),
    steps: { listByTask: () => [] },
    runner: {
      start: () => undefined,
      cancel: () => undefined,
    },
    actions: {
      execute: async () => {
        throw new Error("Unused action execution.");
      },
    },
    providers: {
      getConfig: () => ({
        provider: null,
        model: null,
        configured: false,
        updatedAt: null,
        available: [],
        keys: [],
      }),
      setConfig: async () => {
        throw new Error("Unused provider update.");
      },
    },
    events,
    eventConnections: createEventStreamRegistry(),
  });
}

function withAuth(): RequestInit {
  return { headers: { Authorization: authorization } };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /v1/openapi.json", () => {
  it("requires a bearer token", async () => {
    const app = createHarness();
    const response = await app.request("/v1/openapi.json");

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
  });

  it("serves the OpenAPI 3.1 document with all operations", async () => {
    const app = createHarness();
    const response = await app.request("/v1/openapi.json", withAuth());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");

    const body = (await response.json()) as {
      openapi: string;
      paths: Record<string, Record<string, unknown>>;
    };
    const operationCount = Object.values(body.paths).reduce(
      (total, item) => total + Object.keys(item).length,
      0,
    );

    expect(body.openapi).toBe("3.1.0");
    expect(operationCount).toBe(32);
  });

  it("builds the document once when the app is created", async () => {
    const app = createHarness();

    expect(vi.mocked(createOpenApiDocument)).toHaveBeenCalledTimes(1);

    await app.request("/v1/openapi.json", withAuth());
    await app.request("/v1/openapi.json", withAuth());

    expect(vi.mocked(createOpenApiDocument)).toHaveBeenCalledTimes(1);
  });

  it("does not expose credentials or filesystem paths", async () => {
    const app = createHarness();
    const response = await app.request("/v1/openapi.json", withAuth());
    const body = await response.text();

    expect(body).not.toContain(token);
    expect(body).not.toContain("/Users/");
  });
});
