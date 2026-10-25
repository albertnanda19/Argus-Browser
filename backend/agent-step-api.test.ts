import { describe, expect, it } from "vitest";
import type {
  AgentStep,
  AgentStepListResponse,
  AgentStepResult,
} from "../shared/agent-step";
import type { ChromeInstallerState } from "../shared/chrome-installer";
import type { Problem } from "../shared/contracts";
import type { Session } from "../shared/session";
import { createAgentStepStore } from "./agent-steps";
import { createApp, type ProfileService, type SessionService } from "./app";
import { createEventBus } from "./event-bus";
import { createEventStreamRegistry } from "./event-stream";
import { createTaskManager } from "./task-manager";

const token = "test-token";
const allowedOrigin = "http://127.0.0.1:5173";
const authorization = `Bearer ${token}`;
const sessionId = "s_0000000000000001";
const unknownTaskId = "t_00000000000000ff";
const fixedNow = "2026-10-25T10:00:00.000Z";

const readyState: ChromeInstallerState = {
  status: "ready",
  source: "managed",
  version: "156.0.8078.47",
  progress: null,
  error: null,
};

const session: Session = {
  id: sessionId,
  profileId: "p_0000000000000001",
  status: "ready",
  startedAt: "2026-10-25T09:00:00.000Z",
  endedAt: null,
  pid: null,
};

function createHarness() {
  const events = createEventBus();
  const store = createAgentStepStore();
  let taskSequence = 0;

  const sessions: SessionService = {
    start: async () => session,
    listActive: () => [session],
    get: (id) => (id === sessionId ? session : null),
    close: async () => ({ ...session, status: "closed", endedAt: fixedNow }),
  };

  const tasks = createTaskManager({
    sessions,
    events,
    now: () => new Date(fixedNow),
  });

  const profiles: ProfileService = {
    list: async () => [],
    create: async (name) => ({
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
    profiles,
    sessions,
    tasks,
    steps: {
      listByTask: (taskId: string): readonly AgentStep[] =>
        store.list(taskId).reverse(),
    },
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
    store,
    createTask(): string {
      taskSequence += 1;
      return tasks.createTask(sessionId, { goal: "Cari kontak" }, `step-key-${taskSequence}`)
        .id;
    },
  };
}

function addStep(
  store: ReturnType<typeof createAgentStepStore>,
  taskId: string,
  result: Partial<AgentStepResult> = {},
): AgentStep {
  return store.add({
    taskId,
    action: "click",
    target: "Buka kontak",
    result: {
      status: "done",
      url: "https://example.test/kontak",
      pageChanged: true,
      verification: {
        stepOk: true,
        goalComplete: false,
        reason: "Halaman berubah.",
      },
      ...result,
    },
    durationMs: 812,
  });
}

function withAuth(init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: { ...init.headers, Authorization: authorization },
  };
}

async function readList(response: Response): Promise<AgentStepListResponse> {
  return (await response.json()) as AgentStepListResponse;
}

async function readProblem(response: Response): Promise<Problem> {
  return (await response.json()) as Problem;
}

describe("GET /v1/tasks/:id/steps", () => {
  it("returns steps ordered by index with default pagination", async () => {
    const harness = createHarness();
    const taskId = harness.createTask();
    const first = addStep(harness.store, taskId);
    addStep(harness.store, taskId, {
      status: "failed",
      pageChanged: false,
      verification: null,
    });
    addStep(harness.store, taskId, { status: "blocked" });

    const response = await harness.app.request(
      `/v1/tasks/${taskId}/steps`,
      withAuth(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await readList(response);

    expect(body.total).toBe(3);
    expect(body.page).toBe(1);
    expect(body.page_size).toBe(20);
    expect(body.data.map((step) => step.index)).toEqual([1, 2, 3]);
    expect(body.data[0]).toEqual(first);
    expect(body.data[1]?.result).toMatchObject({
      status: "failed",
      pageChanged: false,
      verification: null,
    });
    expect(body.data[2]?.result.status).toBe("blocked");
  });

  it("paginates the list after ordering it by index", async () => {
    const harness = createHarness();
    const taskId = harness.createTask();
    addStep(harness.store, taskId, { status: "done" });
    addStep(harness.store, taskId, { status: "done" });
    addStep(harness.store, taskId, { status: "done" });

    const response = await harness.app.request(
      `/v1/tasks/${taskId}/steps?page=2&page_size=2`,
      withAuth(),
    );

    expect(response.status).toBe(200);
    const body = await readList(response);

    expect(body.total).toBe(3);
    expect(body.page).toBe(2);
    expect(body.page_size).toBe(2);
    expect(body.data.map((step) => step.index)).toEqual([3]);
  });

  it("returns an empty list for a task without steps", async () => {
    const harness = createHarness();
    const taskId = harness.createTask();

    const response = await harness.app.request(
      `/v1/tasks/${taskId}/steps`,
      withAuth(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: [],
      total: 0,
      page: 1,
      page_size: 20,
    });
  });

  it("returns 404 for an unknown task", async () => {
    const harness = createHarness();

    const response = await harness.app.request(
      `/v1/tasks/${unknownTaskId}/steps`,
      withAuth(),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    await expect(readProblem(response)).resolves.toMatchObject({
      status: 404,
      detail: "Task tidak ditemukan.",
    });
  });

  it("rejects an invalid task id with 400", async () => {
    const harness = createHarness();

    const response = await harness.app.request(
      "/v1/tasks/not-a-task/steps",
      withAuth(),
    );

    expect(response.status).toBe(400);
    await expect(readProblem(response)).resolves.toMatchObject({
      status: 400,
      detail: "Id task tidak valid.",
    });
  });

  it("rejects invalid pagination with 400", async () => {
    const harness = createHarness();
    const taskId = harness.createTask();

    const response = await harness.app.request(
      `/v1/tasks/${taskId}/steps?page=0&page_size=101`,
      withAuth(),
    );

    expect(response.status).toBe(400);
    await expect(readProblem(response)).resolves.toMatchObject({
      status: 400,
      detail: "Parameter pagination tidak valid.",
    });
  });

  it("keeps steps readable after the task reaches a terminal state", async () => {
    const harness = createHarness();
    const taskId = harness.createTask();
    addStep(harness.store, taskId);
    harness.tasks.cancelTask(taskId);

    const response = await harness.app.request(
      `/v1/tasks/${taskId}/steps`,
      withAuth(),
    );

    expect(response.status).toBe(200);
    const body = await readList(response);
    expect(harness.tasks.getTask(taskId)?.status).toBe("cancelled");
    expect(body.total).toBe(1);
    expect(body.data[0]?.index).toBe(1);
  });
});
