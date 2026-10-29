import { describe, expect, it, vi } from "vitest";
import type { ChromeInstallerState } from "../shared/chrome-installer";
import type { Profile } from "../shared/profile";
import type { Session } from "../shared/session";
import type { Task, TaskEntity } from "../shared/task";
import { createApp, type ProfileService, type SessionService } from "./app";
import type { BrowserPage, BrowserSessionContext } from "./browser-launcher";
import { createEventBus } from "./event-bus";
import { createEventStreamRegistry } from "./event-stream";
import { createTaskManager } from "./task-manager";

const token = "test-token";
const allowedOrigin = "http://127.0.0.1:5173";
const authorization = `Bearer ${token}`;
const readySessionId = "s_0000000000000001";
const secondReadySessionId = "s_0000000000000003";
const startingSessionId = "s_0000000000000002";
const fixedNow = "2026-10-25T10:00:00.000Z";
const jpegBytes = [0xff, 0xd8, 0xff, 0xd9];

const readyState: ChromeInstallerState = {
  status: "ready",
  source: "managed",
  version: "156.0.8078.47",
  progress: null,
  error: null,
};

function makeSession(sessionId: string, status: Session["status"]): Session {
  return {
    id: sessionId,
    profileId: "p_0000000000000001",
    status,
    startedAt: "2026-10-25T09:00:00.000Z",
    endedAt: null,
    pid: null,
  };
}

type HarnessOptions = {
  readonly thumbnailPages?: number;
  readonly thumbnailFails?: boolean;
  readonly thumbnailBarrier?: Promise<void>;
};

function createHarness(options: HarnessOptions = {}) {
  let currentTime = new Date(fixedNow);
  const events = createEventBus();
  const sessions = new Map<string, Session>([
    [readySessionId, makeSession(readySessionId, "ready")],
    [secondReadySessionId, makeSession(secondReadySessionId, "ready")],
    [startingSessionId, makeSession(startingSessionId, "starting")],
  ]);
  const thumbnailCaptureParams: Record<string, unknown>[] = [];
  let activeCaptures = 0;
  let maxActiveCaptures = 0;

  const thumbnailPage: BrowserPage = {
    goto: async () => undefined,
    url: () => "https://example.test/",
    locator: () => ({
      click: async () => undefined,
      fill: async () => undefined,
      innerText: async () => "",
    }),
  };
  const thumbnailContext: BrowserSessionContext & {
    newCDPSession(page: BrowserPage): Promise<unknown>;
  } = {
    close: async () => undefined,
    on: () => undefined,
    pages: () => ((options.thumbnailPages ?? 1) === 0 ? [] : [thumbnailPage]),
    newPage: async () => thumbnailPage,
    newCDPSession: async () => {
      if (options.thumbnailFails === true) {
        throw new Error("CDP session unavailable.");
      }
      return {
        send: async (method: string, params?: Record<string, unknown>) => {
          if (method === "Page.getLayoutMetrics") {
            return { cssLayoutViewport: { clientWidth: 1280, clientHeight: 720 } };
          }
          activeCaptures += 1;
          maxActiveCaptures = Math.max(maxActiveCaptures, activeCaptures);
          if (options.thumbnailBarrier !== undefined) {
            await options.thumbnailBarrier;
          }
          thumbnailCaptureParams.push(params ?? {});
          activeCaptures -= 1;
          return { data: Buffer.from(jpegBytes).toString("base64") };
        },
        detach: async () => undefined,
      };
    },
  };

  const sessionsService: SessionService = {
    start: async (profileId: string) => makeSession(readySessionId, "ready"),
    listActive: () => [],
    get: (sessionId) => sessions.get(sessionId) ?? null,
    getContext: (sessionId) =>
      sessionId === readySessionId ? thumbnailContext : null,
    close: async (sessionId) => makeSession(sessionId, "closed"),
  };

  const tasks = createTaskManager({
    sessions: sessionsService,
    events,
    now: () => currentTime,
  });
  const runner = {
    start: vi.fn(),
    cancel: vi.fn(),
    notifyApprovalDecision: vi.fn(),
  };

  const profilesService: ProfileService = {
    list: async (): Promise<Profile[]> => [],
    create: async (name: string) => ({
      id: "p_0000000000000001",
      name,
      createdAt: fixedNow,
      lastUsedAt: null,
    }),
    delete: async () => undefined,
  };

  const app = createApp({
    token,
    allowedOrigin,
    chromeInstaller: {
      getState: () => readyState,
      start: async () => readyState,
      setLocalBinary: async () => ({ ok: true, path: "/tmp/chrome", version: "1" }),
      clearLocalBinary: async () => readyState,
    },
    profiles: profilesService,
    profilePolicies: {
      get: async () => {
        throw new Error("Unused profile policy lookup.");
      },
      set: async () => {
        throw new Error("Unused profile policy update.");
      },
    },
    sessions: sessionsService,
    tasks,
    steps: { listByTask: () => [] },
    runner,
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

  return {
    app,
    tasks,
    events,
    sessions,
    runner,
    thumbnailCaptureParams,
    get maxActiveCaptures() {
      return maxActiveCaptures;
    },
    advance(milliseconds: number) {
      currentTime = new Date(currentTime.getTime() + milliseconds);
    },
  };
}

function withAuth(init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: { ...init.headers, Authorization: authorization },
  };
}

function taskRequest(
  sessionId: string,
  body: unknown,
  headers: Record<string, string> = {},
): RequestInit {
  return withAuth({
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function answerRequest(taskId: string, body: unknown): RequestInit {
  return withAuth({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

describe("POST /v1/sessions/:id/tasks", () => {
  it("creates a queued task with 202", async () => {
    const { app, runner } = createHarness();
    const response = await app.request(
      `/v1/sessions/${readySessionId}/tasks`,
      taskRequest(
        readySessionId,
        { goal: "Buka halaman kontak" },
        { "Idempotency-Key": "key-create" },
      ),
    );

    expect(response.status).toBe(202);
    const body = await json<{ data: TaskEntity }>(response);
    expect(body.data.id).toMatch(/^t_[0-9a-f]{16}$/);
    expect(body.data.sessionId).toBe(readySessionId);
    expect(body.data.goal).toBe("Buka halaman kontak");
    expect(body.data.kind).toBe("agent");
    expect(body.data.research).toBeNull();
    expect(body.data.outputSchema).toBeNull();
    expect(body.data.status).toBe("queued");
    expect(body.data.createdAt).toBe(fixedNow);
    expect(body.data.completedAt).toBeNull();
    expect(runner.start).toHaveBeenCalledWith(body.data.id);
  });

  it("returns the same task for a replayed key without a new record", async () => {
    const harness = createHarness();
    const request = () =>
      harness.app.request(
        `/v1/sessions/${readySessionId}/tasks`,
        taskRequest(
          readySessionId,
          { goal: "Buka halaman", outputSchema: { hasil: "string" } },
          { "Idempotency-Key": "key-replay" },
        ),
      );

    const first = await request();
    const second = await request();
    const firstBody = await json<{ data: Task }>(first);
    const secondBody = await json<{ data: Task }>(second);

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(secondBody.data.id).toBe(firstBody.data.id);
    expect(harness.tasks.listBySession(readySessionId)).toHaveLength(1);
    expect(harness.runner.start).toHaveBeenCalledTimes(2);
    expect(harness.runner.start).toHaveBeenNthCalledWith(1, firstBody.data.id);
    expect(harness.runner.start).toHaveBeenNthCalledWith(2, firstBody.data.id);
  });

  it("trims the idempotency key", async () => {
    const harness = createHarness();
    const first = await harness.app.request(
      `/v1/sessions/${readySessionId}/tasks`,
      taskRequest(readySessionId, { goal: "Buka" }, { "Idempotency-Key": "key-trim" }),
    );
    const second = await harness.app.request(
      `/v1/sessions/${readySessionId}/tasks`,
      taskRequest(readySessionId, { goal: "Buka" }, { "Idempotency-Key": "  key-trim  " }),
    );

    expect((await json<{ data: Task }>(second)).data.id).toBe(
      (await json<{ data: Task }>(first)).data.id,
    );
    expect(harness.tasks.listBySession(readySessionId)).toHaveLength(1);
  });

  it("creates one task for two identical concurrent requests", async () => {
    const harness = createHarness();
    const send = () =>
      harness.app.request(
        `/v1/sessions/${readySessionId}/tasks`,
        taskRequest(readySessionId, { goal: "Buka" }, { "Idempotency-Key": "key-concurrent" }),
      );

    const [first, second] = await Promise.all([send(), send()]);
    const firstTask = (await json<{ data: Task }>(first)).data;
    const secondTask = (await json<{ data: Task }>(second)).data;

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(secondTask.id).toBe(firstTask.id);
    expect(harness.tasks.listBySession(readySessionId)).toHaveLength(1);
  });

  it("rejects the same key with a different body with 409", async () => {
    const harness = createHarness();
    await harness.app.request(
      `/v1/sessions/${readySessionId}/tasks`,
      taskRequest(readySessionId, { goal: "Satu" }, { "Idempotency-Key": "key-conflict" }),
    );
    const response = await harness.app.request(
      `/v1/sessions/${readySessionId}/tasks`,
      taskRequest(readySessionId, { goal: "Dua" }, { "Idempotency-Key": "key-conflict" }),
    );

    expect(response.status).toBe(409);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    await expect(response.json()).resolves.toEqual({
      type: "about:blank",
      title: "Conflict",
      status: 409,
      detail: "Idempotency-Key sudah dipakai untuk permintaan berbeda.",
    });
    expect(harness.tasks.listBySession(readySessionId)).toHaveLength(1);
  });

  it("creates a new task after the idempotency key expires", async () => {
    const harness = createHarness();
    const first = await harness.app.request(
      `/v1/sessions/${readySessionId}/tasks`,
      taskRequest(readySessionId, { goal: "Satu" }, { "Idempotency-Key": "key-ttl" }),
    );
    harness.advance(24 * 60 * 60 * 1_000 + 1);
    const second = await harness.app.request(
      `/v1/sessions/${readySessionId}/tasks`,
      taskRequest(readySessionId, { goal: "Satu" }, { "Idempotency-Key": "key-ttl" }),
    );

    expect((await json<{ data: Task }>(second)).data.id).not.toBe(
      (await json<{ data: Task }>(first)).data.id,
    );
    expect(harness.tasks.listBySession(readySessionId)).toHaveLength(2);
  });

  it("rejects a missing idempotency key with 400", async () => {
    const harness = createHarness();
    const response = await harness.app.request(
      `/v1/sessions/${readySessionId}/tasks`,
      taskRequest(readySessionId, { goal: "Buka" }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      type: "about:blank",
      title: "Bad Request",
      status: 400,
      detail: "Idempotency-Key wajib diisi.",
    });
    expect(harness.tasks.listBySession(readySessionId)).toHaveLength(0);
  });

  it("rejects an idempotency key longer than 200 characters with 400", async () => {
    const { app } = createHarness();
    const response = await app.request(
      `/v1/sessions/${readySessionId}/tasks`,
      taskRequest(readySessionId, { goal: "Buka" }, { "Idempotency-Key": "x".repeat(201) }),
    );

    expect(response.status).toBe(400);
    const body = await json<{ detail: string }>(response);
    expect(body.detail).toBe("Idempotency-Key tidak valid.");
  });

  it("rejects a whitespace-only idempotency key with 400", async () => {
    const harness = createHarness();
    const response = await harness.app.request(
      `/v1/sessions/${readySessionId}/tasks`,
      taskRequest(readySessionId, { goal: "Buka" }, { "Idempotency-Key": "   " }),
    );

    expect(response.status).toBe(400);
    expect(harness.tasks.listBySession(readySessionId)).toHaveLength(0);
  });

  it("validates the session id before the body and header", async () => {
    const { app } = createHarness();
    const response = await app.request(
      "/v1/sessions/not-a-session/tasks",
      withAuth({ method: "POST" }),
    );

    expect(response.status).toBe(400);
    const body = await json<{ detail: string }>(response);
    expect(body.detail).toBe("Id sesi tidak valid.");
  });

  it("validates the body before the header", async () => {
    const { app } = createHarness();
    const response = await app.request(
      `/v1/sessions/${readySessionId}/tasks`,
      taskRequest(readySessionId, { goal: "" }),
    );

    expect(response.status).toBe(400);
    const body = await json<{ detail: string }>(response);
    expect(body.detail).toBe("Body permintaan tidak valid.");
  });

  it.each([
    { goal: "" },
    { goal: "x".repeat(2001) },
    { goal: "Buka", extra: true },
    {},
  ])("rejects an invalid body %j with 400", async (body) => {
    const harness = createHarness();
    const response = await harness.app.request(
      `/v1/sessions/${readySessionId}/tasks`,
      taskRequest(readySessionId, body, { "Idempotency-Key": "key-invalid-body" }),
    );

    expect(response.status).toBe(400);
    expect(harness.tasks.listBySession(readySessionId)).toHaveLength(0);
  });

  it("returns 404 for an unknown session", async () => {
    const { app } = createHarness();
    const response = await app.request(
      "/v1/sessions/s_ffffffffffffffff/tasks",
      taskRequest("s_ffffffffffffffff", { goal: "Buka" }, { "Idempotency-Key": "key-404" }),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      type: "about:blank",
      title: "Not Found",
      status: 404,
      detail: "Sesi tidak ditemukan.",
    });
  });

  it("returns 409 for a session that is not ready", async () => {
    const { app } = createHarness();
    const response = await app.request(
      `/v1/sessions/${startingSessionId}/tasks`,
      taskRequest(startingSessionId, { goal: "Buka" }, { "Idempotency-Key": "key-409" }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      type: "about:blank",
      title: "Conflict",
      status: 409,
      detail: "Sesi belum siap menerima task.",
    });
  });

  it("requires a bearer token", async () => {
    const { app } = createHarness();
    const response = await app.request(
      `/v1/sessions/${readySessionId}/tasks`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": "key-401" },
        body: JSON.stringify({ goal: "Buka" }),
      },
    );

    expect(response.status).toBe(401);
  });
});

describe("POST /v1/sessions/:id/tasks research kind", () => {
  async function createResearchTask(
    harness: ReturnType<typeof createHarness>,
    research: Record<string, unknown>,
    key = "key-research",
  ) {
    const response = await harness.app.request(
      `/v1/sessions/${readySessionId}/tasks`,
      taskRequest(
        readySessionId,
        { goal: "Cari kontak Budi", kind: "research", research },
        { "Idempotency-Key": key },
      ),
    );
    return response;
  }

  it("creates a research task and keeps outputSchema opaque", async () => {
    const harness = createHarness();
    const outputSchema = { nested: { email: "string", score: 0.5 } };
    const response = await harness.app.request(
      `/v1/sessions/${readySessionId}/tasks`,
      taskRequest(
        readySessionId,
        {
          goal: "Cari kontak Budi",
          kind: "research",
          research: { targetName: "Budi Santoso", organization: "PT Contoh" },
          outputSchema,
        },
        { "Idempotency-Key": "key-research-create" },
      ),
    );

    expect(response.status).toBe(202);
    const body = await json<{ data: TaskEntity }>(response);
    expect(body.data.kind).toBe("research");
    expect(body.data.research).toEqual({
      targetName: "Budi Santoso",
      organization: "PT Contoh",
    });
    expect(body.data.outputSchema).toEqual(outputSchema);
    expect(body.data.status).toBe("queued");
    expect(harness.runner.start).not.toHaveBeenCalled();
  });

  it("stores a missing organization as null", async () => {
    const harness = createHarness();
    const response = await createResearchTask(harness, { targetName: "Budi Santoso" });
    const body = await json<{ data: TaskEntity }>(response);

    expect(response.status).toBe(202);
    expect(body.data.research).toEqual({
      targetName: "Budi Santoso",
      organization: null,
    });
  });

  it.each([
    { goal: "Cari kontak", kind: "research" },
    { goal: "Cari kontak", kind: "research", research: {} },
    { goal: "Cari kontak", kind: "research", research: { targetName: "" } },
    {
      goal: "Cari kontak",
      kind: "research",
      research: { targetName: "x".repeat(201) },
    },
    {
      goal: "Cari kontak",
      kind: "research",
      research: { targetName: "Budi", organization: "x".repeat(201) },
    },
  ])("rejects an invalid research body %j with 400", async (body) => {
    const harness = createHarness();
    const response = await harness.app.request(
      `/v1/sessions/${readySessionId}/tasks`,
      taskRequest(readySessionId, body, { "Idempotency-Key": "key-research-invalid" }),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    await expect(response.json()).resolves.toMatchObject({
      status: 400,
      detail: "Body permintaan tidak valid.",
    });
    expect(harness.tasks.listBySession(readySessionId)).toHaveLength(0);
  });

  it.each([
    { goal: "Cari kontak", research: { targetName: "Budi" } },
    { goal: "Cari kontak", kind: "agent", research: { targetName: "Budi" } },
  ])("rejects research on an agent task %j with 400", async (body) => {
    const harness = createHarness();
    const response = await harness.app.request(
      `/v1/sessions/${readySessionId}/tasks`,
      taskRequest(readySessionId, body, { "Idempotency-Key": "key-agent-research" }),
    );

    expect(response.status).toBe(400);
    expect(harness.tasks.listBySession(readySessionId)).toHaveLength(0);
  });

  it("rejects the same key with a different kind or research target with 409", async () => {
    const harness = createHarness();
    await createResearchTask(harness, { targetName: "Budi" }, "key-research-idempotent");
    const response = await harness.app.request(
      `/v1/sessions/${readySessionId}/tasks`,
      taskRequest(
        readySessionId,
        { goal: "Cari kontak Budi", kind: "research", research: { targetName: "Sari" } },
        { "Idempotency-Key": "key-research-idempotent" },
      ),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      detail: "Idempotency-Key sudah dipakai untuk permintaan berbeda.",
    });
  });
});

describe("GET /v1/tasks/:id/research", () => {
  async function researchTaskId(harness: ReturnType<typeof createHarness>, key: string) {
    const created = await harness.app.request(
      `/v1/sessions/${readySessionId}/tasks`,
      taskRequest(
        readySessionId,
        {
          goal: "Cari kontak",
          kind: "research",
          research: { targetName: "Budi Santoso" },
        },
        { "Idempotency-Key": key },
      ),
    );
    return (await json<{ data: TaskEntity }>(created)).data.id;
  }

  it("returns an empty result immediately after creation", async () => {
    const harness = createHarness();
    const taskId = await researchTaskId(harness, "key-research-read");
    const response = await harness.app.request(
      `/v1/tasks/${taskId}/research`,
      withAuth(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: { taskId, contacts: [], chain: [] },
    });
  });

  it("keeps results isolated between research tasks", async () => {
    const harness = createHarness();
    const firstId = await researchTaskId(harness, "key-research-a");
    const secondId = await researchTaskId(harness, "key-research-b");

    const first = await harness.app.request(`/v1/tasks/${firstId}/research`, withAuth());
    const second = await harness.app.request(`/v1/tasks/${secondId}/research`, withAuth());

    expect((await json<{ data: { taskId: string } }>(first)).data.taskId).toBe(firstId);
    expect((await json<{ data: { taskId: string } }>(second)).data.taskId).toBe(secondId);
  });

  it("returns 409 task_not_research for an agent task", async () => {
    const harness = createHarness();
    const created = await harness.app.request(
      `/v1/sessions/${readySessionId}/tasks`,
      taskRequest(readySessionId, { goal: "Buka" }, { "Idempotency-Key": "key-agent-read" }),
    );
    const taskId = (await json<{ data: TaskEntity }>(created)).data.id;
    const response = await harness.app.request(
      `/v1/tasks/${taskId}/research`,
      withAuth(),
    );

    expect(response.status).toBe(409);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    await expect(response.json()).resolves.toEqual({
      type: "about:blank",
      title: "Conflict",
      status: 409,
      detail: "Task ini bukan task riset.",
    });
  });

  it("returns 404 for an unknown task and 400 for an invalid id", async () => {
    const harness = createHarness();
    const missing = await harness.app.request(
      "/v1/tasks/t_ffffffffffffffff/research",
      withAuth(),
    );
    const invalid = await harness.app.request("/v1/tasks/nope/research", withAuth());

    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({
      detail: "Task tidak ditemukan.",
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({
      detail: "Id task tidak valid.",
    });
  });

  it("requires a bearer token", async () => {
    const { app } = createHarness();
    const response = await app.request("/v1/tasks/t_ffffffffffffffff/research");

    expect(response.status).toBe(401);
  });

  it("still cancels a research task", async () => {
    const harness = createHarness();
    const taskId = await researchTaskId(harness, "key-research-cancel");
    const response = await harness.app.request(
      `/v1/tasks/${taskId}/cancel`,
      withAuth({ method: "POST" }),
    );

    expect(response.status).toBe(202);
    const body = await json<{ data: TaskEntity }>(response);
    expect(body.data.status).toBe("cancelled");
    expect(body.data.kind).toBe("research");
  });
});

describe("GET /v1/tasks/:id", () => {
  it("returns a task by id", async () => {
    const { app } = createHarness();
    const created = await app.request(
      `/v1/sessions/${readySessionId}/tasks`,
      taskRequest(readySessionId, { goal: "Buka" }, { "Idempotency-Key": "key-get" }),
    );
    const task = (await json<{ data: Task }>(created)).data;
    const response = await app.request(`/v1/tasks/${task.id}`, withAuth());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: task });
  });

  it("rejects an invalid task id with 400", async () => {
    const { app } = createHarness();
    const response = await app.request("/v1/tasks/not-a-task", withAuth());

    expect(response.status).toBe(400);
  });

  it("returns 404 for an unknown task", async () => {
    const { app } = createHarness();
    const response = await app.request("/v1/tasks/t_ffffffffffffffff", withAuth());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      type: "about:blank",
      title: "Not Found",
      status: 404,
      detail: "Task tidak ditemukan.",
    });
  });
});

describe("GET /v1/tasks", () => {
  it("lists tasks newest first with pagination", async () => {
    const harness = createHarness();
    const first = harness.tasks.createTask(
      readySessionId,
      { goal: "Pertama" },
      "key-list-1",
    );
    harness.advance(1_000);
    const second = harness.tasks.createTask(
      readySessionId,
      { goal: "Kedua" },
      "key-list-2",
    );

    const response = await harness.app.request("/v1/tasks", withAuth());
    const body = await json<{
      data: Task[];
      total: number;
      page: number;
      page_size: number;
    }>(response);

    expect(response.status).toBe(200);
    expect(body).toEqual({
      data: [second, first],
      total: 2,
      page: 1,
      page_size: 20,
    });

    const secondPage = await harness.app.request(
      "/v1/tasks?page=2&page_size=1",
      withAuth(),
    );
    const secondPageBody = await json<{ data: Task[] }>(secondPage);

    expect(secondPageBody.data).toEqual([first]);
  });

  it("breaks createdAt ties by descending id", async () => {
    const harness = createHarness();
    const first = harness.tasks.createTask(
      readySessionId,
      { goal: "Satu" },
      "key-tie-1",
    );
    const second = harness.tasks.createTask(
      readySessionId,
      { goal: "Dua" },
      "key-tie-2",
    );
    const expected = [first.id, second.id].sort().reverse();

    const response = await harness.app.request("/v1/tasks", withAuth());
    const body = await json<{ data: Task[] }>(response);

    expect(body.data.map((task) => task.id)).toEqual(expected);
  });

  it("filters by sessionId and status", async () => {
    const harness = createHarness();
    const running = harness.tasks.createTask(
      readySessionId,
      { goal: "Jalan" },
      "key-filter-1",
    );
    harness.tasks.startTask(running.id);
    const queued = harness.tasks.createTask(
      readySessionId,
      { goal: "Antre" },
      "key-filter-2",
    );
    const other = harness.tasks.createTask(
      secondReadySessionId,
      { goal: "Sesi lain" },
      "key-filter-3",
    );

    const byStatus = await harness.app.request(
      "/v1/tasks?status=running",
      withAuth(),
    );
    const bySession = await harness.app.request(
      `/v1/tasks?sessionId=${secondReadySessionId}`,
      withAuth(),
    );

    await expect(byStatus.json()).resolves.toEqual({
      data: [{ ...running, status: "running" }],
      total: 1,
      page: 1,
      page_size: 20,
    });
    await expect(bySession.json()).resolves.toEqual({
      data: [other],
      total: 1,
      page: 1,
      page_size: 20,
    });
    expect(queued.status).toBe("queued");
  });

  it.each([
    "page=0",
    "page=abc",
    "page_size=0",
    "page_size=101",
    "status=done",
    "sessionId=not-a-session",
  ])("rejects an invalid query %s with 400", async (query) => {
    const harness = createHarness();
    const response = await harness.app.request(`/v1/tasks?${query}`, withAuth());

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    const body = await json<{ detail: string }>(response);
    expect(body.detail).toBe("Parameter daftar task tidak valid.");
  });

  it("requires a bearer token", async () => {
    const { app } = createHarness();
    const response = await app.request("/v1/tasks");

    expect(response.status).toBe(401);
  });
});

describe("GET /v1/approvals", () => {
  function createWaitingApproval(
    harness: ReturnType<typeof createHarness>,
    key: string,
    taskId = readySessionId,
  ) {
    const task = harness.tasks.createTask(
      taskId,
      { goal: "Kirim pesan" },
      key,
    );
    harness.tasks.startTask(task.id);
    const approval = harness.tasks.requestApproval(task.id, {
      action: "click",
      target: "Tombol kirim",
      selector: "#kirim",
      highlighted: true,
      category: "send_message",
      payload: {
        selector: "#kirim",
        highlighted: true,
        category: "send_message",
      },
    });
    return { task, approval };
  }

  it("lists pending approvals with target and requestedAt newest first", async () => {
    const harness = createHarness();
    const first = createWaitingApproval(harness, "key-approval-list-1");
    harness.advance(1_000);
    const second = createWaitingApproval(harness, "key-approval-list-2");

    const response = await harness.app.request("/v1/approvals", withAuth());
    const body = await json<{
      data: Array<{
        id: string;
        target: string;
        requestedAt: string;
        decision: string;
        payload: Record<string, unknown>;
      }>;
      total: number;
    }>(response);

    expect(response.status).toBe(200);
    expect(body.total).toBe(2);
    expect(body.data.map((approval) => approval.id)).toEqual([
      second.approval.id,
      first.approval.id,
    ]);
    expect(body.data[0]).toMatchObject({
      target: "Tombol kirim",
      requestedAt: "2026-10-25T10:00:01.000Z",
      decision: "pending",
      payload: {
        selector: "#kirim",
        highlighted: true,
        category: "send_message",
      },
    });
  });

  it("breaks requestedAt ties by descending id", async () => {
    const harness = createHarness();
    const first = createWaitingApproval(harness, "key-approval-tie-1");
    const second = createWaitingApproval(harness, "key-approval-tie-2");
    const expected = [first.approval.id, second.approval.id].sort().reverse();

    const response = await harness.app.request("/v1/approvals", withAuth());
    const body = await json<{ data: Array<{ id: string }> }>(response);

    expect(body.data.map((approval) => approval.id)).toEqual(expected);
  });

  it("filters by decision and taskId and keeps decided approvals", async () => {
    const harness = createHarness();
    const first = createWaitingApproval(harness, "key-approval-filter-1");
    harness.advance(1_000);
    const second = createWaitingApproval(harness, "key-approval-filter-2");

    await harness.app.request(
      `/v1/tasks/${first.task.id}/approval`,
      answerRequest(first.task.id, { approve: true }),
    );

    const approved = await harness.app.request(
      "/v1/approvals?decision=approved",
      withAuth(),
    );
    const pending = await harness.app.request(
      "/v1/approvals?decision=pending",
      withAuth(),
    );
    const byTask = await harness.app.request(
      `/v1/approvals?taskId=${second.task.id}`,
      withAuth(),
    );

    expect((await json<{ data: unknown[] }>(approved)).data).toHaveLength(1);
    expect((await json<{ data: Array<{ id: string }> }>(pending)).data).toEqual([
      expect.objectContaining({ id: second.approval.id }),
    ]);
    expect((await json<{ data: Array<{ id: string }> }>(byTask)).data).toEqual([
      expect.objectContaining({ id: second.approval.id }),
    ]);
  });

  it.each([
    "page=0",
    "page_size=101",
    "decision=maybe",
    "taskId=not-a-task",
  ])("rejects an invalid query %s with 400", async (query) => {
    const harness = createHarness();
    const response = await harness.app.request(
      `/v1/approvals?${query}`,
      withAuth(),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    await expect(response.json()).resolves.toMatchObject({
      detail: "Parameter daftar approval tidak valid.",
    });
  });

  it("requires a bearer token", async () => {
    const { app } = createHarness();
    const response = await app.request("/v1/approvals");

    expect(response.status).toBe(401);
  });
});

describe("GET /v1/sessions/:id/thumbnail", () => {
  it("returns a viewport JPEG capped at 640 px without caching", async () => {
    const harness = createHarness();
    const response = await harness.app.request(
      `/v1/sessions/${readySessionId}/thumbnail`,
      withAuth(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array(jpegBytes),
    );
    expect(harness.thumbnailCaptureParams).toEqual([
      {
        format: "jpeg",
        quality: 60,
        fromSurface: true,
        captureBeyondViewport: false,
        clip: { x: 0, y: 0, width: 1280, height: 720, scale: 0.5 },
      },
    ]);
  });

  it("serializes concurrent captures for the same session", async () => {
    let release: () => void = () => undefined;
    const barrier = new Promise<void>((resolveBarrier) => {
      release = resolveBarrier;
    });
    const harness = createHarness({ thumbnailBarrier: barrier });
    const request = () =>
      harness.app.request(
        `/v1/sessions/${readySessionId}/thumbnail`,
        withAuth(),
      );

    const pending = Promise.all([request(), request()]);
    release();
    const [first, second] = await pending;

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(harness.thumbnailCaptureParams).toHaveLength(2);
    expect(harness.maxActiveCaptures).toBe(1);
  });

  it("returns 404 for an unknown session", async () => {
    const { app } = createHarness();
    const response = await app.request(
      "/v1/sessions/s_ffffffffffffffff/thumbnail",
      withAuth(),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
  });

  it("returns 409 when the session has no page", async () => {
    const { app } = createHarness({ thumbnailPages: 0 });
    const response = await app.request(
      `/v1/sessions/${readySessionId}/thumbnail`,
      withAuth(),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      detail: "Sesi belum memiliki halaman.",
    });
  });

  it("returns 409 when the session is not ready", async () => {
    const { app } = createHarness();
    const response = await app.request(
      `/v1/sessions/${startingSessionId}/thumbnail`,
      withAuth(),
    );

    expect(response.status).toBe(409);
  });

  it("returns 500 when capture fails", async () => {
    const { app } = createHarness({ thumbnailFails: true });
    const response = await app.request(
      `/v1/sessions/${readySessionId}/thumbnail`,
      withAuth(),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      detail: "Cuplikan halaman gagal dibuat.",
    });
  });

  it("validates the session id and requires a bearer token", async () => {
    const { app } = createHarness();
    const invalid = await app.request("/v1/sessions/nope/thumbnail", withAuth());
    const unauthorized = await app.request(
      `/v1/sessions/${readySessionId}/thumbnail`,
    );

    expect(invalid.status).toBe(400);
    expect(unauthorized.status).toBe(401);
  });
});

describe("POST /v1/tasks/:id/cancel", () => {
  it("cancels a queued task with 202", async () => {
    const harness = createHarness();
    const created = await harness.app.request(
      `/v1/sessions/${readySessionId}/tasks`,
      taskRequest(readySessionId, { goal: "Buka" }, { "Idempotency-Key": "key-cancel" }),
    );
    const task = (await json<{ data: Task }>(created)).data;
    const response = await harness.app.request(
      `/v1/tasks/${task.id}/cancel`,
      withAuth({ method: "POST" }),
    );

    expect(response.status).toBe(202);
    const body = await json<{ data: Task }>(response);
    expect(body.data.status).toBe("cancelled");
    expect(body.data.completedAt).toBe(fixedNow);
    expect(harness.runner.cancel).toHaveBeenCalledWith(task.id);

    const fetched = await harness.app.request(`/v1/tasks/${task.id}`, withAuth());
    await expect(fetched.json()).resolves.toEqual({ data: body.data });
  });

  it("rejects cancelling a terminal task with 409", async () => {
    const harness = createHarness();
    const created = await harness.app.request(
      `/v1/sessions/${readySessionId}/tasks`,
      taskRequest(readySessionId, { goal: "Buka" }, { "Idempotency-Key": "key-cancel-twice" }),
    );
    const task = (await json<{ data: Task }>(created)).data;
    await harness.app.request(`/v1/tasks/${task.id}/cancel`, withAuth({ method: "POST" }));
    harness.runner.cancel.mockClear();
    const response = await harness.app.request(
      `/v1/tasks/${task.id}/cancel`,
      withAuth({ method: "POST" }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      type: "about:blank",
      title: "Conflict",
      status: 409,
      detail: "Task tidak dapat dibatalkan pada status ini.",
    });
    expect(harness.runner.cancel).not.toHaveBeenCalled();
  });
});

describe("POST /v1/tasks/:id/approval", () => {
  async function waitingTask(harness: ReturnType<typeof createHarness>) {
    const created = await harness.app.request(
      `/v1/sessions/${readySessionId}/tasks`,
      taskRequest(readySessionId, { goal: "Kirim pesan" }, { "Idempotency-Key": "key-approval" }),
    );
    const task = (await json<{ data: Task }>(created)).data;
    harness.tasks.startTask(task.id);
    const approval = harness.tasks.requestApproval(task.id, {
      action: "send_message",
      payload: {
        selector: "#kirim",
        highlighted: true,
        category: "send_message",
      },
      target: "#kirim",
      selector: "#kirim",
      highlighted: true,
      category: "send_message",
    });
    return { taskId: task.id, approvalId: approval.id };
  }

  it("approves a pending action and resumes the task", async () => {
    const harness = createHarness();
    const { taskId, approvalId } = await waitingTask(harness);
    const response = await harness.app.request(
      `/v1/tasks/${taskId}/approval`,
      answerRequest(taskId, { approve: true }),
    );

    expect(response.status).toBe(202);
    const body = await json<{
      data: {
        task: Task;
        approval: {
          id: string;
          target: string;
          requestedAt: string;
          decision: string;
          decidedAt: string;
        };
      };
    }>(response);
    expect(body.data.task.status).toBe("running");
    expect(body.data.approval.id).toBe(approvalId);
    expect(body.data.approval.target).toBe("#kirim");
    expect(body.data.approval.requestedAt).toBe(fixedNow);
    expect(body.data.approval.decision).toBe("approved");
    expect(body.data.approval.decidedAt).toBe(fixedNow);
    expect(harness.runner.notifyApprovalDecision).toHaveBeenCalledWith(
      taskId,
      true,
    );

    const fetched = await harness.app.request(`/v1/tasks/${taskId}`, withAuth());
    expect((await json<{ data: Task }>(fetched)).data.status).toBe("running");
  });

  it("rejects a pending action and cancels the task", async () => {
    const harness = createHarness();
    const { taskId } = await waitingTask(harness);
    const response = await harness.app.request(
      `/v1/tasks/${taskId}/approval`,
      answerRequest(taskId, { approve: false, reason: "Nomor tujuan salah." }),
    );

    expect(response.status).toBe(202);
    const body = await json<{ data: { task: Task; approval: { decision: string } } }>(response);
    expect(body.data.task.status).toBe("cancelled");
    expect(body.data.task.completedAt).toBe(fixedNow);
    expect(body.data.approval.decision).toBe("rejected");
    expect(harness.runner.notifyApprovalDecision).toHaveBeenCalledWith(
      taskId,
      false,
    );
    expect(harness.events.list().at(-1)?.event).toEqual({
      type: "task.cancelled",
      taskId,
      reason: "Nomor tujuan salah.",
      at: fixedNow,
    });
  });

  it("closes the pending approval when a waiting task is cancelled", async () => {
    const harness = createHarness();
    const { taskId, approvalId } = await waitingTask(harness);
    await harness.app.request(`/v1/tasks/${taskId}/cancel`, withAuth({ method: "POST" }));

    expect(harness.tasks.getApproval(approvalId)).toMatchObject({
      decision: "rejected",
      decidedAt: fixedNow,
    });
  });

  it.each([
    { approve: false },
    { approve: false, reason: "" },
    { approve: true, reason: "Tidak perlu." },
    { approve: "yes" },
    {},
  ])("rejects an invalid approval body %j with 400", async (body) => {
    const harness = createHarness();
    const { taskId } = await waitingTask(harness);
    const response = await harness.app.request(
      `/v1/tasks/${taskId}/approval`,
      answerRequest(taskId, body),
    );

    expect(response.status).toBe(400);
    expect(harness.tasks.getTask(taskId)?.status).toBe("waiting_approval");
  });

  it("rejects an approval when the task is not waiting", async () => {
    const harness = createHarness();
    const created = await harness.app.request(
      `/v1/sessions/${readySessionId}/tasks`,
      taskRequest(readySessionId, { goal: "Buka" }, { "Idempotency-Key": "key-not-waiting" }),
    );
    const task = (await json<{ data: Task }>(created)).data;
    harness.tasks.startTask(task.id);
    const response = await harness.app.request(
      `/v1/tasks/${task.id}/approval`,
      answerRequest(task.id, { approve: true }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      type: "about:blank",
      title: "Conflict",
      status: 409,
      detail: "Task tidak sedang menunggu persetujuan.",
    });
  });

  it("returns 404 for an unknown task", async () => {
    const { app } = createHarness();
    const response = await app.request(
      "/v1/tasks/t_ffffffffffffffff/approval",
      answerRequest("t_ffffffffffffffff", { approve: true }),
    );

    expect(response.status).toBe(404);
  });
});
