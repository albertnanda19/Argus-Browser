import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../shared/session";
import { taskSchema, type Task } from "../shared/task";
import { createActionManager, type ActionSessionSource } from "./action-manager";
import type { BrowserLocator, BrowserPage, BrowserSessionContext } from "./browser-launcher";
import { createEventBus } from "./event-bus";

const fixedNow = new Date("2026-10-25T10:00:00.000Z");
const sessionA = "s_0000000000000001";
const sessionB = "s_0000000000000002";
const taskA = "t_0000000000000001";
const taskB = "t_0000000000000002";

type TimeoutOptions = { readonly timeout: number };

type FakePageOptions = {
  readonly initialUrl?: string;
  readonly finalUrl?: string;
  readonly text?: string;
  readonly goto?: (url: string, options: TimeoutOptions) => Promise<void>;
  readonly click?: (selector: string, options: TimeoutOptions) => Promise<void>;
  readonly fill?: (selector: string, text: string, options: TimeoutOptions) => Promise<void>;
  readonly innerText?: (selector: string, options: TimeoutOptions) => Promise<string>;
};

type FakePage = BrowserPage & {
  readonly gotoCalls: Array<{ readonly url: string; readonly timeout: number }>;
  readonly clickCalls: Array<{ readonly selector: string; readonly timeout: number }>;
  readonly fillCalls: Array<{
    readonly selector: string;
    readonly text: string;
    readonly timeout: number;
  }>;
  readonly innerTextCalls: Array<{ readonly selector: string; readonly timeout: number }>;
};

function createFakePage(options: FakePageOptions = {}): FakePage {
  const gotoCalls: Array<{ url: string; timeout: number }> = [];
  const clickCalls: Array<{ selector: string; timeout: number }> = [];
  const fillCalls: Array<{ selector: string; text: string; timeout: number }> = [];
  const innerTextCalls: Array<{ selector: string; timeout: number }> = [];
  let currentUrl = options.initialUrl ?? "about:blank";

  const page: FakePage = {
    gotoCalls,
    clickCalls,
    fillCalls,
    innerTextCalls,
    async goto(url, { timeout }) {
      gotoCalls.push({ url, timeout });
      if (options.goto !== undefined) {
        await options.goto(url, { timeout });
      }
      currentUrl = options.finalUrl ?? url;
    },
    url: () => currentUrl,
    locator(selector): BrowserLocator {
      return {
        async click({ timeout }) {
          clickCalls.push({ selector, timeout });
          if (options.click !== undefined) {
            await options.click(selector, { timeout });
          }
        },
        async fill(text, { timeout }) {
          fillCalls.push({ selector, text, timeout });
          if (options.fill !== undefined) {
            await options.fill(selector, text, { timeout });
          }
        },
        async innerText({ timeout }) {
          innerTextCalls.push({ selector, timeout });
          if (options.innerText !== undefined) {
            return options.innerText(selector, { timeout });
          }
          return options.text ?? "";
        },
      };
    },
  };

  return page;
}

type FakeContext = BrowserSessionContext & {
  readonly newPageCalls: number;
  readonly createdPages: FakePage[];
};

function createFakeContext(initialPages: BrowserPage[] = []): FakeContext {
  let pages = [...initialPages];
  let newPageCalls = 0;
  const createdPages: FakePage[] = [];

  const context: FakeContext = {
    get newPageCalls() {
      return newPageCalls;
    },
    createdPages,
    async close() {},
    on() {},
    pages: () => [...pages],
    async newPage() {
      newPageCalls += 1;
      const page = createFakePage();
      createdPages.push(page);
      pages = [...pages, page];
      return page;
    },
  };

  return context;
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

function makeTask(taskId: string, sessionId: string, status: Task["status"]): Task {
  return taskSchema.parse({
    id: taskId,
    sessionId,
    goal: "Buka halaman kontak",
    outputSchema: null,
    status,
    createdAt: "2026-10-25T09:00:00.000Z",
    completedAt: status === "completed" ? fixedNow.toISOString() : null,
  });
}

function timeoutError(): Error {
  const error = new Error("Timeout 10000ms exceeded.");
  error.name = "TimeoutError";
  return error;
}

type HarnessOptions = {
  readonly pages?: BrowserPage[];
  readonly otherPages?: BrowserPage[];
  readonly status?: Session["status"];
  readonly hasContext?: boolean;
  readonly tasks?: Task[];
};

function createHarness(options: HarnessOptions = {}) {
  const events = createEventBus();
  const contextA = createFakeContext(options.pages ?? []);
  const contextB = createFakeContext(options.otherPages ?? []);
  const sessions = new Map<string, Session>([
    [sessionA, makeSession(sessionA, options.status ?? "ready")],
    [sessionB, makeSession(sessionB, "ready")],
  ]);
  const contexts = new Map<string, BrowserSessionContext | null>([
    [sessionA, options.hasContext === false ? null : contextA],
    [sessionB, contextB],
  ]);
  const taskMap = new Map<string, Task>(
    (options.tasks ?? []).map((task) => [task.id, task]),
  );

  const sessionSource: ActionSessionSource = {
    get: (sessionId) => sessions.get(sessionId) ?? null,
    getContext: (sessionId) => {
      const session = sessions.get(sessionId);
      if (session === undefined || session.status !== "ready") {
        return null;
      }
      return contexts.get(sessionId) ?? null;
    },
  };

  const actions = createActionManager({
    sessions: sessionSource,
    tasks: { getTask: (taskId) => taskMap.get(taskId) ?? null },
    events,
    now: () => fixedNow,
  });

  return { actions, events, contextA, contextB, taskMap };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("execute", () => {
  it("navigates the last page with a 30 second timeout and publishes the final url", async () => {
    const first = createFakePage();
    const last = createFakePage({ finalUrl: "https://example.com/" });
    const harness = createHarness({ pages: [first, last] });

    const result = await harness.actions.execute(sessionA, {
      action: "navigate",
      url: "https://example.com",
    });

    expect(result).toEqual({ action: "navigate", url: "https://example.com/" });
    expect(first.gotoCalls).toEqual([]);
    expect(last.gotoCalls).toEqual([{ url: "https://example.com", timeout: 30_000 }]);
    expect(harness.events.list().map((stored) => stored.event)).toEqual([
      {
        type: "step",
        taskId: null,
        action: "navigate",
        url: "https://example.com/",
        at: fixedNow.toISOString(),
      },
    ]);
  });

  it("opens a page when the context has none and clicks with a 10 second timeout", async () => {
    const harness = createHarness();

    const result = await harness.actions.execute(sessionA, {
      action: "click",
      selector: "#submit",
    });

    expect(result).toEqual({ action: "click", selector: "#submit" });
    expect(harness.contextA.newPageCalls).toBe(1);
    expect(harness.contextA.createdPages[0]?.clickCalls).toEqual([
      { selector: "#submit", timeout: 10_000 },
    ]);
    expect(harness.events.list().map((stored) => stored.event)).toEqual([
      {
        type: "step",
        taskId: null,
        action: "click",
        selector: "#submit",
        at: fixedNow.toISOString(),
      },
    ]);
  });

  it("fills text without exposing it in the event or log", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const page = createFakePage();
    const harness = createHarness({ pages: [page] });

    const result = await harness.actions.execute(sessionA, {
      action: "type",
      selector: "input[name=q]",
      text: "argus",
    });

    expect(result).toEqual({ action: "type", selector: "input[name=q]" });
    expect(page.fillCalls).toEqual([
      { selector: "input[name=q]", text: "argus", timeout: 10_000 },
    ]);
    expect(JSON.stringify(harness.events.list())).not.toContain("argus");
    expect(warn).not.toHaveBeenCalled();
  });

  it("extracts inner text without exposing the value in the event", async () => {
    const page = createFakePage({ text: "Judul" });
    const harness = createHarness({ pages: [page] });

    const result = await harness.actions.execute(sessionA, {
      action: "extract",
      selector: "h1",
    });

    expect(result).toEqual({ action: "extract", selector: "h1", value: "Judul" });
    expect(page.innerTextCalls).toEqual([{ selector: "h1", timeout: 10_000 }]);
    expect(JSON.stringify(harness.events.list())).not.toContain("Judul");
    expect(harness.events.list().map((stored) => stored.event)).toEqual([
      {
        type: "step",
        taskId: null,
        action: "extract",
        selector: "h1",
        at: fixedNow.toISOString(),
      },
    ]);
  });

  it("returns an empty extract value when the element is empty", async () => {
    const page = createFakePage({ text: "" });
    const harness = createHarness({ pages: [page] });

    await expect(
      harness.actions.execute(sessionA, { action: "extract", selector: "h1" }),
    ).resolves.toEqual({ action: "extract", selector: "h1", value: "" });
  });
});

describe("validate", () => {
  it("rejects an unknown session without calling the page", async () => {
    const page = createFakePage();
    const harness = createHarness({ pages: [page] });

    await expect(
      harness.actions.execute("s_ffffffffffffffff", { action: "click", selector: "#x" }),
    ).rejects.toMatchObject({
      name: "ActionError",
      code: "action_session_not_found",
      message: "Sesi tidak ditemukan.",
    });
    expect(page.clickCalls).toEqual([]);
    expect(harness.contextA.newPageCalls).toBe(0);
    expect(harness.events.list()).toEqual([]);
  });

  it("rejects a session that is not ready", async () => {
    const harness = createHarness({ status: "starting" });

    await expect(
      harness.actions.execute(sessionA, { action: "click", selector: "#x" }),
    ).rejects.toMatchObject({
      name: "ActionError",
      code: "action_session_not_ready",
      message: "Sesi belum siap menerima aksi.",
    });
    expect(harness.contextA.newPageCalls).toBe(0);
  });

  it("rejects a ready session without a context", async () => {
    const harness = createHarness({ hasContext: false });

    await expect(
      harness.actions.execute(sessionA, { action: "click", selector: "#x" }),
    ).rejects.toMatchObject({
      code: "action_session_not_ready",
    });
  });

  it("rejects an unknown task without calling the page", async () => {
    const page = createFakePage();
    const harness = createHarness({ pages: [page] });

    await expect(
      harness.actions.execute(sessionA, {
        action: "click",
        selector: "#x",
        taskId: taskA,
      }),
    ).rejects.toMatchObject({
      name: "ActionError",
      code: "action_task_not_found",
      message: "Task tidak ditemukan.",
    });
    expect(page.clickCalls).toEqual([]);
    expect(harness.events.list()).toEqual([]);
  });

  it("rejects a task that belongs to another session", async () => {
    const page = createFakePage();
    const harness = createHarness({
      pages: [page],
      tasks: [makeTask(taskB, sessionB, "running")],
    });

    await expect(
      harness.actions.execute(sessionA, {
        action: "click",
        selector: "#x",
        taskId: taskB,
      }),
    ).rejects.toMatchObject({
      code: "action_task_not_found",
    });
    expect(page.clickCalls).toEqual([]);
  });

  it("rejects a task that is not running", async () => {
    const page = createFakePage();
    const harness = createHarness({
      pages: [page],
      tasks: [makeTask(taskA, sessionA, "queued")],
    });

    await expect(
      harness.actions.execute(sessionA, {
        action: "click",
        selector: "#x",
        taskId: taskA,
      }),
    ).rejects.toMatchObject({
      name: "ActionError",
      code: "action_task_not_running",
      message: "Task tidak dapat menerima aksi pada status ini.",
    });
    expect(page.clickCalls).toEqual([]);
    expect(harness.events.list()).toEqual([]);
  });

  it("publishes the provided task id for a running task", async () => {
    const page = createFakePage();
    const harness = createHarness({
      pages: [page],
      tasks: [makeTask(taskA, sessionA, "running")],
    });

    await harness.actions.execute(sessionA, {
      action: "click",
      selector: "#submit",
      taskId: taskA,
    });

    expect(harness.events.list().map((stored) => stored.event)).toEqual([
      {
        type: "step",
        taskId: taskA,
        action: "click",
        selector: "#submit",
        at: fixedNow.toISOString(),
      },
    ]);
  });
});

describe("failures", () => {
  it("maps a navigation error to action_navigation_failed without publishing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const page = createFakePage({
      goto: async () => {
        throw new Error("net::ERR_NAME_NOT_RESOLVED at https://example.com");
      },
    });
    const harness = createHarness({ pages: [page] });

    await expect(
      harness.actions.execute(sessionA, { action: "navigate", url: "https://example.com" }),
    ).rejects.toMatchObject({
      name: "ActionError",
      code: "action_navigation_failed",
      message: "Halaman gagal dibuka.",
    });
    expect(harness.events.list()).toEqual([]);
    expect(String(warn.mock.calls[0]?.[0])).toContain(sessionA);
    expect(String(warn.mock.calls[0]?.[0])).not.toContain("ERR_NAME_NOT_RESOLVED");
  });

  it("maps a click timeout to action_target_not_found", async () => {
    const page = createFakePage({
      click: async () => {
        throw timeoutError();
      },
    });
    const harness = createHarness({ pages: [page] });

    await expect(
      harness.actions.execute(sessionA, { action: "click", selector: "#missing" }),
    ).rejects.toMatchObject({
      code: "action_target_not_found",
      message: "Elemen tidak ditemukan atau aksi melewati batas waktu.",
    });
    expect(harness.events.list()).toEqual([]);
  });

  it("maps another click error to action_failed", async () => {
    const page = createFakePage({
      click: async () => {
        throw new Error("Element is not attached to the DOM");
      },
    });
    const harness = createHarness({ pages: [page] });

    await expect(
      harness.actions.execute(sessionA, { action: "click", selector: "#gone" }),
    ).rejects.toMatchObject({
      code: "action_failed",
      message: "Aksi gagal dijalankan.",
    });
  });

  it("maps an extract timeout to action_target_not_found", async () => {
    const page = createFakePage({
      innerText: async () => {
        throw timeoutError();
      },
    });
    const harness = createHarness({ pages: [page] });

    await expect(
      harness.actions.execute(sessionA, { action: "extract", selector: "h1" }),
    ).rejects.toMatchObject({ code: "action_target_not_found" });
  });

  it("does not leak typed text when filling fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const page = createFakePage({
      fill: async () => {
        throw new Error("fill failed for argus");
      },
    });
    const harness = createHarness({ pages: [page] });

    await expect(
      harness.actions.execute(sessionA, {
        action: "type",
        selector: "input[name=q]",
        text: "argus",
      }),
    ).rejects.toMatchObject({ code: "action_failed" });

    expect(JSON.stringify(warn.mock.calls)).not.toContain("argus");
    expect(JSON.stringify(harness.events.list())).not.toContain("argus");
  });
});

describe("serialization", () => {
  it("runs actions for the same session in order", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const page = createFakePage({
      goto: async () => {
        await gate;
      },
    });
    const harness = createHarness({ pages: [page] });

    const first = harness.actions.execute(sessionA, {
      action: "navigate",
      url: "https://example.com",
    });
    await vi.waitFor(() => {
      expect(page.gotoCalls).toHaveLength(1);
    });

    const second = harness.actions.execute(sessionA, {
      action: "click",
      selector: "#submit",
    });
    await Promise.resolve();
    expect(page.clickCalls).toHaveLength(0);

    release();
    await Promise.all([first, second]);
    expect(page.clickCalls).toEqual([{ selector: "#submit", timeout: 10_000 }]);
  });

  it("does not block an action on another session", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blockedPage = createFakePage({
      goto: async () => {
        await gate;
      },
    });
    const freePage = createFakePage();
    const harness = createHarness({ pages: [blockedPage], otherPages: [freePage] });

    const first = harness.actions.execute(sessionA, {
      action: "navigate",
      url: "https://example.com",
    });
    await vi.waitFor(() => {
      expect(blockedPage.gotoCalls).toHaveLength(1);
    });

    await expect(
      harness.actions.execute(sessionB, { action: "click", selector: "#other" }),
    ).resolves.toEqual({ action: "click", selector: "#other" });
    expect(freePage.clickCalls).toEqual([{ selector: "#other", timeout: 10_000 }]);

    release();
    await first;
  });
});
