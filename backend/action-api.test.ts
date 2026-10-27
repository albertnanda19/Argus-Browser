import { afterEach, describe, expect, it, vi } from "vitest";
import { actionResponseSchema } from "../shared/action";
import type { ChromeInstallerState } from "../shared/chrome-installer";
import { problemSchema } from "../shared/contracts";
import type { Profile } from "../shared/profile";
import type { Session } from "../shared/session";
import { createActionManager, type ActionSessionSource } from "./action-manager";
import { createApp, type ProfileService, type SessionService } from "./app";
import type { BrowserLocator, BrowserPage, BrowserSessionContext } from "./browser-launcher";
import { createEventBus } from "./event-bus";
import { createEventStreamRegistry } from "./event-stream";
import { createTaskManager } from "./task-manager";

const token = "test-token";
const allowedOrigin = "http://127.0.0.1:5173";
const authorization = `Bearer ${token}`;
const readySessionId = "s_0000000000000001";
const startingSessionId = "s_0000000000000002";
const otherSessionId = "s_0000000000000003";
const fixedNow = "2026-10-25T10:00:00.000Z";

const readyState: ChromeInstallerState = {
  status: "ready",
  source: "managed",
  version: "156.0.8078.47",
  progress: null,
  error: null,
};

type PageOptions = {
  readonly finalUrl?: string;
  readonly text?: string;
  readonly goto?: () => Promise<void>;
  readonly click?: () => Promise<void>;
  readonly fill?: () => Promise<void>;
  readonly innerText?: () => Promise<string>;
};

type FakePage = BrowserPage & { readonly calls: string[] };

function createFakePage(options: PageOptions = {}): FakePage {
  const calls: string[] = [];
  const page: FakePage = {
    calls,
    async goto(url, { timeout }) {
      calls.push(`goto ${url} ${timeout}`);
      if (options.goto !== undefined) {
        await options.goto();
      }
    },
    url: () => options.finalUrl ?? "about:blank",
    locator(selector): BrowserLocator {
      return {
        async click({ timeout }) {
          calls.push(`click ${selector} ${timeout}`);
          if (options.click !== undefined) {
            await options.click();
          }
        },
        async fill(_text, { timeout }) {
          calls.push(`fill ${selector} ${timeout}`);
          if (options.fill !== undefined) {
            await options.fill();
          }
        },
        async innerText({ timeout }) {
          calls.push(`innerText ${selector} ${timeout}`);
          if (options.innerText !== undefined) {
            return options.innerText();
          }
          return options.text ?? "";
        },
      };
    },
  };
  return page;
}

function createContext(page: BrowserPage): BrowserSessionContext {
  return {
    async close() {},
    on() {},
    pages: () => [page],
    async newPage() {
      return page;
    },
  };
}

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

function timeoutError(): Error {
  const error = new Error("Timeout 10000ms exceeded.");
  error.name = "TimeoutError";
  return error;
}

type HarnessOptions = {
  readonly page?: PageOptions;
};

function createHarness(options: HarnessOptions = {}) {
  const events = createEventBus();
  const page = createFakePage(options.page);
  const otherPage = createFakePage({ finalUrl: "https://other.example/" });
  const sessions = new Map<string, Session>([
    [readySessionId, makeSession(readySessionId, "ready")],
    [startingSessionId, makeSession(startingSessionId, "starting")],
    [otherSessionId, makeSession(otherSessionId, "ready")],
  ]);
  const contexts = new Map<string, BrowserSessionContext>([
    [readySessionId, createContext(page)],
    [otherSessionId, createContext(otherPage)],
  ]);

  const sessionsService: SessionService = {
    start: async (profileId: string) => makeSession(readySessionId, "ready"),
    listActive: () => [],
    get: (sessionId) => sessions.get(sessionId) ?? null,
    close: async (sessionId) => makeSession(sessionId, "closed"),
  };

  const actionSessions: ActionSessionSource = {
    get: (sessionId) => sessions.get(sessionId) ?? null,
    getContext: (sessionId) => {
      const session = sessions.get(sessionId);
      if (session === undefined || session.status !== "ready") {
        return null;
      }
      return contexts.get(sessionId) ?? null;
    },
  };

  const tasks = createTaskManager({
    sessions: sessionsService,
    events,
    now: () => new Date(fixedNow),
  });

  const actions = createActionManager({
    sessions: actionSessions,
    tasks,
    events,
    now: () => new Date(fixedNow),
  });

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
    runner: {
      start: () => undefined,
      cancel: () => undefined,
    },
    actions,
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

  return { app, tasks, events, page, otherPage };
}

function actionRequest(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { Authorization: authorization, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function readAction(response: Response) {
  const body: unknown = await response.json();
  return actionResponseSchema.parse(body);
}

async function readProblem(response: Response) {
  const body: unknown = await response.json();
  return problemSchema.parse(body);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /v1/sessions/:id/actions", () => {
  it("navigates and returns the final url", async () => {
    const harness = createHarness({ page: { finalUrl: "https://example.com/" } });

    const response = await harness.app.request(
      `/v1/sessions/${readySessionId}/actions`,
      actionRequest({ action: "navigate", url: "https://example.com" }),
    );

    expect(response.status).toBe(200);
    expect(await readAction(response)).toEqual({
      data: { action: "navigate", url: "https://example.com/" },
    });
    expect(harness.page.calls).toEqual(["goto https://example.com 30000"]);
    expect(harness.events.list().map((stored) => stored.event)).toEqual([
      {
        type: "step",
        taskId: null,
        action: "navigate",
        url: "https://example.com/",
        at: fixedNow,
      },
    ]);
  });

  it("clicks and returns the selector", async () => {
    const harness = createHarness();

    const response = await harness.app.request(
      `/v1/sessions/${readySessionId}/actions`,
      actionRequest({ action: "click", selector: "#submit" }),
    );

    expect(response.status).toBe(200);
    expect(await readAction(response)).toEqual({
      data: { action: "click", selector: "#submit" },
    });
    expect(harness.page.calls).toEqual(["click #submit 10000"]);
  });

  it("types without exposing the text in the response or event", async () => {
    const harness = createHarness();

    const response = await harness.app.request(
      `/v1/sessions/${readySessionId}/actions`,
      actionRequest({ action: "type", selector: "input[name=q]", text: "argus" }),
    );

    expect(response.status).toBe(200);
    expect(await readAction(response)).toEqual({
      data: { action: "type", selector: "input[name=q]" },
    });
    expect(harness.page.calls).toEqual(["fill input[name=q] 10000"]);
    expect(JSON.stringify(harness.events.list())).not.toContain("argus");
  });

  it("extracts and returns the value", async () => {
    const harness = createHarness({ page: { text: "Judul" } });

    const response = await harness.app.request(
      `/v1/sessions/${readySessionId}/actions`,
      actionRequest({ action: "extract", selector: "h1" }),
    );

    expect(response.status).toBe(200);
    expect(await readAction(response)).toEqual({
      data: { action: "extract", selector: "h1", value: "Judul" },
    });
  });

  it("attributes the step to a running task", async () => {
    const harness = createHarness();
    const task = harness.tasks.createTask(readySessionId, { goal: "Buka halaman" }, "key");
    harness.tasks.startTask(task.id);

    const response = await harness.app.request(
      `/v1/sessions/${readySessionId}/actions`,
      actionRequest({ action: "click", selector: "#submit", taskId: task.id }),
    );

    expect(response.status).toBe(200);
    expect(harness.events.list().map((stored) => stored.event)).toEqual([
      {
        type: "step",
        taskId: task.id,
        action: "click",
        selector: "#submit",
        at: fixedNow,
      },
    ]);
  });

  it("rejects an invalid session id", async () => {
    const harness = createHarness();

    const response = await harness.app.request(
      "/v1/sessions/not-a-session/actions",
      actionRequest({ action: "click", selector: "#submit" }),
    );

    expect(response.status).toBe(400);
    expect(await readProblem(response)).toMatchObject({ detail: "Id sesi tidak valid." });
  });

  it.each([
    ["an unknown action", { action: "scroll", selector: "#submit" }],
    ["an empty selector", { action: "click", selector: "" }],
    ["an oversized selector", { action: "click", selector: "x".repeat(1001) }],
    ["an oversized text", { action: "type", selector: "#x", text: "x".repeat(10_001) }],
    ["an invalid url", { action: "navigate", url: "bukan-url" }],
    ["an invalid task id", { action: "click", selector: "#x", taskId: "t_xyz" }],
    ["an extra field", { action: "click", selector: "#x", extra: true }],
  ])("rejects %s in the body", async (_label, body) => {
    const harness = createHarness();

    const response = await harness.app.request(
      `/v1/sessions/${readySessionId}/actions`,
      actionRequest(body),
    );

    expect(response.status).toBe(400);
    expect(await readProblem(response)).toMatchObject({ detail: "Body permintaan tidak valid." });
  });

  it("returns 404 for an unknown session", async () => {
    const harness = createHarness();

    const response = await harness.app.request(
      "/v1/sessions/s_ffffffffffffffff/actions",
      actionRequest({ action: "click", selector: "#submit" }),
    );

    expect(response.status).toBe(404);
    expect(await readProblem(response)).toMatchObject({ detail: "Sesi tidak ditemukan." });
  });

  it("returns 409 for a session that is not ready", async () => {
    const harness = createHarness();

    const response = await harness.app.request(
      `/v1/sessions/${startingSessionId}/actions`,
      actionRequest({ action: "click", selector: "#submit" }),
    );

    expect(response.status).toBe(409);
    expect(await readProblem(response)).toMatchObject({
      detail: "Sesi belum siap menerima aksi.",
    });
  });

  it("returns 404 for an unknown task", async () => {
    const harness = createHarness();

    const response = await harness.app.request(
      `/v1/sessions/${readySessionId}/actions`,
      actionRequest({
        action: "click",
        selector: "#submit",
        taskId: "t_ffffffffffffffff",
      }),
    );

    expect(response.status).toBe(404);
    expect(await readProblem(response)).toMatchObject({ detail: "Task tidak ditemukan." });
  });

  it("returns 404 for a task that belongs to another session", async () => {
    const harness = createHarness();
    const task = harness.tasks.createTask(otherSessionId, { goal: "Buka halaman" }, "other");
    harness.tasks.startTask(task.id);

    const response = await harness.app.request(
      `/v1/sessions/${readySessionId}/actions`,
      actionRequest({ action: "click", selector: "#submit", taskId: task.id }),
    );

    expect(response.status).toBe(404);
    expect(await readProblem(response)).toMatchObject({ detail: "Task tidak ditemukan." });
  });

  it("returns 409 for a task that is not running", async () => {
    const harness = createHarness();
    const task = harness.tasks.createTask(readySessionId, { goal: "Buka halaman" }, "queued");

    const response = await harness.app.request(
      `/v1/sessions/${readySessionId}/actions`,
      actionRequest({ action: "click", selector: "#submit", taskId: task.id }),
    );

    expect(response.status).toBe(409);
    expect(await readProblem(response)).toMatchObject({
      detail: "Task tidak dapat menerima aksi pada status ini.",
    });
  });

  it("returns 422 when the element times out", async () => {
    const harness = createHarness({
      page: {
        click: async () => {
          throw timeoutError();
        },
      },
    });

    const response = await harness.app.request(
      `/v1/sessions/${readySessionId}/actions`,
      actionRequest({ action: "click", selector: "#missing" }),
    );

    expect(response.status).toBe(422);
    expect(await readProblem(response)).toMatchObject({
      detail: "Elemen tidak ditemukan atau aksi melewati batas waktu.",
    });
  });

  it("returns 422 when navigation fails", async () => {
    const harness = createHarness({
      page: {
        goto: async () => {
          throw new Error("net::ERR_CONNECTION_REFUSED");
        },
      },
    });

    const response = await harness.app.request(
      `/v1/sessions/${readySessionId}/actions`,
      actionRequest({ action: "navigate", url: "https://example.com" }),
    );

    expect(response.status).toBe(422);
    expect(await readProblem(response)).toMatchObject({ detail: "Halaman gagal dibuka." });
  });

  it("returns 422 when another action fails", async () => {
    const harness = createHarness({
      page: {
        fill: async () => {
          throw new Error("Element is not editable");
        },
      },
    });

    const response = await harness.app.request(
      `/v1/sessions/${readySessionId}/actions`,
      actionRequest({ action: "type", selector: "input[name=q]", text: "argus" }),
    );

    expect(response.status).toBe(422);
    expect(await readProblem(response)).toMatchObject({ detail: "Aksi gagal dijalankan." });
  });

  it("requires a token", async () => {
    const harness = createHarness();

    const response = await harness.app.request(`/v1/sessions/${readySessionId}/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "click", selector: "#submit" }),
    });

    expect(response.status).toBe(401);
    expect(harness.page.calls).toEqual([]);
  });
});
