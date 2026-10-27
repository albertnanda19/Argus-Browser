import { describe, expect, it, vi } from "vitest";
import type { ChromeInstallerState } from "../shared/chrome-installer";
import type { Profile } from "../shared/profile";
import type { Session } from "../shared/session";
import type { Task } from "../shared/task";
import { createApp, type ProfileService, type SessionService } from "./app";
import { createEventBus } from "./event-bus";
import { createEventStreamRegistry } from "./event-stream";
import { createTaskManager } from "./task-manager";

const token = "test-token";
const allowedOrigin = "http://127.0.0.1:5173";
const authorization = `Bearer ${token}`;
const readySessionId = "s_0000000000000001";
const startingSessionId = "s_0000000000000002";
const fixedNow = "2026-10-25T10:00:00.000Z";

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

function createHarness() {
  let currentTime = new Date(fixedNow);
  const events = createEventBus();
  const sessions = new Map<string, Session>([
    [readySessionId, makeSession(readySessionId, "ready")],
    [startingSessionId, makeSession(startingSessionId, "starting")],
  ]);

  const sessionsService: SessionService = {
    start: async (profileId: string) => makeSession(readySessionId, "ready"),
    listActive: () => [],
    get: (sessionId) => sessions.get(sessionId) ?? null,
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
    const body = await json<{ data: Task }>(response);
    expect(body.data.id).toMatch(/^t_[0-9a-f]{16}$/);
    expect(body.data.sessionId).toBe(readySessionId);
    expect(body.data.goal).toBe("Buka halaman kontak");
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
    const body = await json<{ data: { task: Task; approval: { id: string; decision: string; decidedAt: string } } }>(
      response,
    );
    expect(body.data.task.status).toBe("running");
    expect(body.data.approval.id).toBe(approvalId);
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
