import { describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import type { ChromeInstallerState } from "../shared/chrome-installer";
import type { DomainEvent } from "../shared/event";
import type { Session } from "../shared/session";
import type { Task } from "../shared/task";
import { createApp } from "./app";
import { createAgentStepStore, type AgentStepVerification } from "./agent-steps";
import type { BrowserPage, BrowserSessionContext } from "./browser-launcher";
import { createEventBus, type EventBus } from "./event-bus";
import { createEventStreamRegistry } from "./event-stream";
import type { ProviderRegistry } from "./provider-registry";
import type { ProviderService } from "./provider-service";
import {
  AgentError,
  type StagehandAgent,
} from "./stagehand-agent";
import type {
  AgentActSummary,
  AgentAction,
  StagehandExtractSchema,
} from "./stagehand-runtime";
import { createTaskManager, type TaskService } from "./task-manager";
import {
  createTaskRunner,
  parseVerification,
  verificationSchema,
  type TaskAgentFactory,
  type TaskRunner,
} from "./task-runner";
import { isIrreversibleAction } from "./irreversible-actions";

const token = "test-token";
const allowedOrigin = "http://127.0.0.1:5173";
const authorization = `Bearer ${token}`;
const readySessionId = "s_0000000000000001";
const fixedNow = "2026-10-25T10:00:00.000Z";
const pageUrl = "https://example.test/halaman";

const readyState: ChromeInstallerState = {
  status: "ready",
  source: "managed",
  version: "156.0.8078.47",
  progress: null,
  error: null,
};

const defaultAction: AgentAction = {
  selector: "#lanjut",
  description: "Buka kontak",
};

const activeProvider = {
  provider: "gemini" as const,
  model: "gemini-2.5-flash",
  apiKey: "test-key",
  updatedAt: fixedNow,
};

const providers: ProviderService = {
  getConfig: () => ({
    provider: "gemini",
    model: activeProvider.model,
    configured: true,
    updatedAt: fixedNow,
  }),
  getActive: () => ({ ...activeProvider }),
  setConfig: async () => ({
    provider: "gemini",
    model: activeProvider.model,
    configured: true,
    updatedAt: fixedNow,
  }),
};

const registry: ProviderRegistry = {
  get: () => null,
};

type FakeAgentState = {
  closed: boolean;
  closeCount: number;
  prepareCalls: number;
  observeCalls: number;
  actCalls: number;
  extractCalls: number;
  structuredExtractCalls: number;
  structuredSchemas: StagehandExtractSchema[];
  screenshotCalls: number;
  observeInstructions: string[];
  verifyInstructions: string[];
};

type FakeAgentHooks = {
  readonly snapshot?: () => Promise<{ readonly formattedTree: string }>;
  readonly preparePage?: () => Promise<{ readonly reloaded: boolean }>;
  readonly observe?: (instruction: string) => Promise<readonly AgentAction[]>;
  readonly act?: (input: string | AgentAction) => Promise<AgentActSummary>;
  readonly extractText?: (
    instruction: string,
    options?: { readonly screenshot?: boolean },
  ) => Promise<unknown>;
  readonly extractStructured?: (
    instruction: string,
    schema: StagehandExtractSchema,
  ) => Promise<unknown>;
  readonly close?: () => Promise<void>;
};

function createFakeAgent(hooks: FakeAgentHooks = {}) {
  const state: FakeAgentState = {
    closed: false,
    closeCount: 0,
    prepareCalls: 0,
    observeCalls: 0,
    actCalls: 0,
    extractCalls: 0,
    structuredExtractCalls: 0,
    structuredSchemas: [],
    screenshotCalls: 0,
    observeInstructions: [],
    verifyInstructions: [],
  };
  let snapshotCount = 0;

  const agent: StagehandAgent = {
    snapshot:
      hooks.snapshot ??
      (async () => {
        snapshotCount += 1;
        return { formattedTree: `tree-${snapshotCount}` };
      }),
    preparePage: async () => {
      state.prepareCalls += 1;
      return hooks.preparePage === undefined
        ? { reloaded: false }
        : hooks.preparePage();
    },
    observe: async (instruction) => {
      state.observeCalls += 1;
      state.observeInstructions.push(instruction);
      return hooks.observe === undefined ? [defaultAction] : hooks.observe(instruction);
    },
    act: async (input) => {
      state.actCalls += 1;
      return hooks.act === undefined
        ? { success: true, actionCount: 1 }
        : hooks.act(input);
    },
    extractText: async (instruction, options) => {
      state.extractCalls += 1;
      if (options?.screenshot === true) {
        state.screenshotCalls += 1;
      } else {
        state.verifyInstructions.push(instruction);
      }
      if (hooks.extractText !== undefined) {
        return hooks.extractText(instruction, options);
      }
      return JSON.stringify({
        stepOk: true,
        goalComplete: true,
        reason: "Tujuan tercapai.",
      });
    },
    extractStructured: async (instruction, schema) => {
      state.extractCalls += 1;
      state.structuredExtractCalls += 1;
      state.structuredSchemas.push(schema);
      state.verifyInstructions.push(instruction);
      if (hooks.extractStructured !== undefined) {
        return hooks.extractStructured(instruction, schema);
      }
      if (hooks.extractText !== undefined) {
        return hooks.extractText(instruction);
      }
      return {
        stepOk: true,
        goalComplete: true,
        reason: "Tujuan tercapai.",
      };
    },
    close: async () => {
      state.closed = true;
      state.closeCount += 1;
      if (hooks.close !== undefined) {
        await hooks.close();
      }
    },
  };

  return { agent, state };
}

type FakeSessionsOptions = {
  readonly initialUrl?: string;
  readonly goto?: (url: string) => Promise<void>;
};

function createFakeSessions(options: FakeSessionsOptions = {}) {
  let isReady = true;
  let isContextAvailable = true;
  let currentUrl = options.initialUrl ?? pageUrl;
  let pages: BrowserPage[] = [];
  const gotoCalls: Array<{ readonly url: string; readonly timeout: number }> = [];

  const page: BrowserPage = {
    goto: async (url, gotoOptions) => {
      gotoCalls.push({ url, timeout: gotoOptions.timeout });
      if (options.goto !== undefined) {
        await options.goto(url);
      }
      currentUrl = url;
    },
    url: () => currentUrl,
    locator: () => ({
      click: async () => undefined,
      fill: async () => undefined,
      innerText: async () => "",
    }),
  };
  pages = [page];
  const context: BrowserSessionContext = {
    close: async () => undefined,
    on: () => undefined,
    pages: () => pages,
    newPage: async () => {
      pages = [...pages, page];
      return page;
    },
  };
  const session: Session = {
    id: readySessionId,
    profileId: "p_0000000000000001",
    status: "ready",
    startedAt: "2026-10-25T09:00:00.000Z",
    endedAt: null,
    pid: null,
  };

  return {
    get: (sessionId: string): Session | null => {
      if (sessionId !== readySessionId) {
        return null;
      }
      return { ...session, status: isReady ? "ready" : "closed" };
    },
    getCdpUrl: (sessionId: string): string | null =>
      sessionId === readySessionId && isReady ? "http://127.0.0.1:9222" : null,
    getContext: (sessionId: string): BrowserSessionContext | null =>
      sessionId === readySessionId && isReady && isContextAvailable
        ? context
        : null,
    start: async () => {
      throw new Error("Unused session start.");
    },
    listActive: (): Session[] => (isReady ? [{ ...session }] : []),
    close: async (): Promise<Session> => ({
      ...session,
      status: "closed",
      endedAt: fixedNow,
    }),
    setReady(value: boolean): void {
      isReady = value;
    },
    setContextAvailable(value: boolean): void {
      isContextAvailable = value;
    },
    setUrl(value: string): void {
      currentUrl = value;
    },
    clearPages(): void {
      pages = [];
    },
    gotoCalls,
  };
}

type RunnerHarnessOptions = {
  readonly createAgent?: TaskAgentFactory;
  readonly sessions?: ReturnType<typeof createFakeSessions>;
  readonly maxSteps?: number;
  readonly maxDurationMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly now?: () => Date;
};

function createRunnerHarness(options: RunnerHarnessOptions = {}) {
  const events = createEventBus();
  const sessions = options.sessions ?? createFakeSessions();
  const tasks = createTaskManager({ sessions, events });
  const steps = createAgentStepStore();
  const runner = createTaskRunner({
    sessions,
    tasks,
    providers,
    registry,
    steps,
    events,
    createAgent: options.createAgent ?? (async () => createFakeAgent().agent),
    maxSteps: options.maxSteps,
    maxDurationMs: options.maxDurationMs,
    shutdownTimeoutMs: options.shutdownTimeoutMs,
    now: options.now,
  });

  return { events, sessions, tasks, steps, runner };
}

function createAppHarness(
  runner: TaskRunner,
  tasks: TaskService,
  sessions: ReturnType<typeof createFakeSessions>,
  events: EventBus,
): Hono {
  return createApp({
    token,
    allowedOrigin,
    chromeInstaller: {
      getState: () => readyState,
      start: async () => readyState,
      setLocalBinary: async () => ({
        ok: true,
        path: "/tmp/chrome",
        version: "156.0.8078.47",
      }),
      clearLocalBinary: async () => readyState,
    },
    profilePolicies: {
      get: async () => {
        throw new Error("Unused profile policy lookup.");
      },
      set: async () => {
        throw new Error("Unused profile policy update.");
      },
    },
    profiles: {
      list: async () => [],
      create: async (name: string) => ({
        id: "p_0000000000000001",
        name,
        createdAt: fixedNow,
        lastUsedAt: null,
      }),
      delete: async () => undefined,
    },
    sessions,
    tasks,
    steps: { listByTask: () => [] },
    runner,
    actions: {
      execute: async () => {
        throw new Error("Unused action execution.");
      },
    },
    providers,
    events,
    eventConnections: createEventStreamRegistry(),
  });
}

let taskKeySequence = 0;

function createTask(
  tasks: TaskService,
  goal = "Buka halaman kontak",
  sessionId = readySessionId,
): Task {
  taskKeySequence += 1;
  return tasks.createTask(sessionId, { goal }, `runner-key-${taskKeySequence}`);
}

function waitForTerminal(events: EventBus, taskId: string): Promise<DomainEvent> {
  return new Promise<DomainEvent>((resolve) => {
    const unsubscribe = events.subscribe(({ event }) => {
      if (
        event.taskId === taskId &&
        (event.type === "task.completed" ||
          event.type === "task.failed" ||
          event.type === "task.cancelled")
      ) {
        unsubscribe();
        resolve(event);
      }
    });
  });
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs = 1_000): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out after ${timeoutMs} ms.`));
    }, timeoutMs);
    timer.unref();

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function taskEvents(events: EventBus, taskId: string): DomainEvent[] {
  return events
    .list()
    .map(({ event }) => event)
    .filter((event) => event.taskId === taskId);
}

const AGENT_STEP_KEYS = [
  "action",
  "at",
  "index",
  "status",
  "target",
  "taskId",
  "type",
  "url",
];

const acceptedVerification = {
  stepOk: true,
  goalComplete: false,
  reason: "Tombol menampilkan kode.",
};
const acceptedVerificationJson = JSON.stringify(acceptedVerification);
const escapedReasonVerification = {
  stepOk: true,
  goalComplete: false,
  reason: 'Tombol "kode" menampilkan } dan {.',
};

const acceptedVerificationCases: Array<[string, unknown, AgentStepVerification]> = [
  ["pure JSON", acceptedVerificationJson, acceptedVerification],
  [
    "JSON in a language-tagged fence",
    `\`\`\`json\n${acceptedVerificationJson}\n\`\`\``,
    acceptedVerification,
  ],
  [
    "JSON in a bare fence with surrounding text",
    `Berikut hasil verifikasi:\n\`\`\`\n${acceptedVerificationJson}\n\`\`\`\nSemoga membantu.`,
    acceptedVerification,
  ],
  [
    "an object inside prose",
    `Hasil verifikasi: ${acceptedVerificationJson} Selesai.`,
    acceptedVerification,
  ],
  [
    "an envelope with fenced JSON",
    { extraction: `\`\`\`json\n${acceptedVerificationJson}\n\`\`\`` },
    acceptedVerification,
  ],
  [
    "braces and escaped quotes in the reason",
    JSON.stringify(escapedReasonVerification),
    escapedReasonVerification,
  ],
  [
    "braces and escaped quotes inside prose",
    `Hasil verifikasi: ${JSON.stringify(escapedReasonVerification)} Selesai.`,
    escapedReasonVerification,
  ],
];

const rejectedVerificationCases: Array<[string, unknown]> = [
  ["non-JSON text", "Saya tidak dapat memverifikasi halaman ini."],
  [
    "truncated JSON",
    '{"stepOk": true, "goalComplete": false, "reason": "ok"',
  ],
  [
    "an extra key",
    JSON.stringify({ ...acceptedVerification, extra: true }),
  ],
  [
    "a missing key",
    JSON.stringify({ stepOk: true, goalComplete: false }),
  ],
  [
    "a string boolean",
    JSON.stringify({ ...acceptedVerification, stepOk: "true" }),
  ],
  [
    "an empty reason",
    JSON.stringify({ ...acceptedVerification, reason: "" }),
  ],
  [
    "a reason over 4000 characters",
    JSON.stringify({ ...acceptedVerification, reason: "x".repeat(4_001) }),
  ],
  ["a bare boolean string", "true"],
];

describe("parseVerification", () => {
  it.each(acceptedVerificationCases)("accepts %s", (_label, raw, expected) => {
    expect(parseVerification(raw)).toEqual(expected);
  });

  it.each(rejectedVerificationCases)("rejects %s", (_label, raw) => {
    expect(parseVerification(raw)).toBeNull();
  });
});


describe("isIrreversibleAction", () => {
  it.each([
    ["Kirim pesan ke kontak", "#kirim", "Kirim pesan"],
    ["Buka halaman", "#send-email", "Send email"],
    ["Buka halaman", "button[type=submit]", "Lanjutkan"],
    ["Hapus data pelanggan", "#hapus", "Hapus data"],
    ["Bayar tagihan", "#bayar", "Bayar sekarang"],
    ["Unggah file", "input[type=file]", "Unggah dokumen"],
    ["Publikasikan postingan", "#publish", "Publish"],
    ["Ubah pengaturan akun", "#pengaturan", "Simpan perubahan"],
    ["Send a message", "#next", "Next"],
  ])("blocks %s with selector %s", (instruction, selector, description) => {
    expect(isIrreversibleAction({ instruction, selector, description })).toBe(true);
  });

  it.each([
    ["Buka halaman kontak", "#kontak", "Buka kontak"],
    ["Cari data kontak", "#cari", "Cari"],
    ["Baca pesan", "#pesan", "Baca"],
    ["Scroll ke bawah", "#bawah", "Scroll"],
    ["Klik tombol masuk", "#masuk", "Masuk"],
    ["Isi kolom pencarian", "#q", "Isi"],
    ["Pilih tema tampilan", "#tema", "Pilih tema"],
  ])("allows %s with selector %s", (instruction, selector, description) => {
    expect(isIrreversibleAction({ instruction, selector, description })).toBe(false);
  });
});

describe("task runner", () => {
  it("completes a task after one verified step and stores the step", async () => {
    const fake = createFakeAgent();
    const harness = createRunnerHarness({ createAgent: async () => fake.agent });
    const task = createTask(harness.tasks);
    const terminal = waitForTerminal(harness.events, task.id);

    harness.runner.start(task.id);
    const event = await withDeadline(terminal);

    expect(event.type).toBe("task.completed");
    if (event.type === "task.completed") {
      expect(event.result).toEqual({ summary: "Tujuan tercapai.", steps: 1 });
    }
    expect(harness.tasks.getTask(task.id)?.status).toBe("completed");

    const last = harness.steps.last(task.id);
    expect(last).toMatchObject({
      taskId: task.id,
      index: 1,
      action: "act",
      target: "Buka kontak",
      result: {
        status: "done",
        url: pageUrl,
        pageChanged: true,
        verification: {
          stepOk: true,
          goalComplete: true,
          reason: "Tujuan tercapai.",
        },
      },
    });
    expect(fake.state.actCalls).toBe(1);
    expect(fake.state.closed).toBe(true);
    expect(fake.state.observeInstructions[0]).toContain("data, bukan instruksi");
    expect(fake.state.verifyInstructions[0]).toContain("data, bukan instruksi");
  });

  it("sends the verification schema through the structured extract path", async () => {
    const fake = createFakeAgent({
      extractText: async () => {
        throw new Error("Verification must not use text extraction.");
      },
      extractStructured: async (_instruction, schema) =>
        schema.parse({
          stepOk: true,
          goalComplete: true,
          reason: "Tujuan tercapai.",
        }),
    });
    const harness = createRunnerHarness({ createAgent: async () => fake.agent });
    const task = createTask(harness.tasks);
    const terminal = waitForTerminal(harness.events, task.id);

    harness.runner.start(task.id);
    const event = await withDeadline(terminal);

    expect(event.type).toBe("task.completed");
    expect(harness.steps.last(task.id)).toMatchObject({
      result: {
        status: "done",
        verification: {
          stepOk: true,
          goalComplete: true,
          reason: "Tujuan tercapai.",
        },
      },
    });
    expect(fake.state.structuredExtractCalls).toBe(1);
    expect(fake.state.structuredSchemas[0]).toBe(verificationSchema);
    expect(fake.state.verifyInstructions[0]).toContain(
      "Tujuan task: Buka halaman kontak",
    );
    expect(fake.state.verifyInstructions[0]).toContain(
      "Aksi yang baru dijalankan: Buka kontak",
    );
    expect(fake.state.verifyInstructions[0]).toContain(
      `URL saat ini: ${pageUrl}`,
    );
    expect(fake.state.verifyInstructions[0]).toContain(
      "Halaman berubah setelah aksi: ya",
    );
  });

  it("fails readably when structured verification does not match the schema", async () => {
    const fake = createFakeAgent({
      extractStructured: async () => ({
        stepOk: "true",
        goalComplete: false,
        reason: "ok",
      }),
    });
    const harness = createRunnerHarness({ createAgent: async () => fake.agent });
    const task = createTask(harness.tasks);
    const terminal = waitForTerminal(harness.events, task.id);

    harness.runner.start(task.id);
    const event = await withDeadline(terminal);

    expect(event.type).toBe("task.failed");
    if (event.type === "task.failed") {
      expect(event.reason).toBe("Verifikasi tidak dapat dibaca.");
    }
    expect(harness.steps.last(task.id)).toMatchObject({
      result: { status: "failed", verification: null },
    });
  });

  it("does not start the same task twice", async () => {
    const created: ReturnType<typeof createFakeAgent>[] = [];
    const harness = createRunnerHarness({
      createAgent: async () => {
        const fake = createFakeAgent();
        created.push(fake);
        return fake.agent;
      },
    });
    const task = createTask(harness.tasks);
    const terminal = waitForTerminal(harness.events, task.id);

    harness.runner.start(task.id);
    harness.runner.start(task.id);
    await withDeadline(terminal);

    expect(created).toHaveLength(1);
    expect(harness.steps.list(task.id)).toHaveLength(1);
  });

  it("records a failed step when verification says the step failed", async () => {
    const fake = createFakeAgent({
      extractText: async () =>
        JSON.stringify({
          stepOk: false,
          goalComplete: false,
          reason: "Tombol belum berubah.",
        }),
    });
    const harness = createRunnerHarness({ createAgent: async () => fake.agent });
    const task = createTask(harness.tasks);
    const terminal = waitForTerminal(harness.events, task.id);

    harness.runner.start(task.id);
    const event = await withDeadline(terminal);

    expect(event.type).toBe("task.failed");
    if (event.type === "task.failed") {
      expect(event.reason).toBe("Langkah gagal: Tombol belum berubah.");
    }
    expect(harness.tasks.getTask(task.id)?.status).toBe("failed");
    expect(harness.steps.last(task.id)).toMatchObject({
      result: {
        status: "failed",
        verification: {
          stepOk: false,
          goalComplete: false,
          reason: "Tombol belum berubah.",
        },
      },
    });
    expect(fake.state.closed).toBe(true);
  });

  it("fails readably when verification JSON is not valid", async () => {
    const fake = createFakeAgent({ extractText: async () => "bukan json" });
    const harness = createRunnerHarness({ createAgent: async () => fake.agent });
    const task = createTask(harness.tasks);
    const terminal = waitForTerminal(harness.events, task.id);

    harness.runner.start(task.id);
    const event = await withDeadline(terminal);

    expect(event.type).toBe("task.failed");
    if (event.type === "task.failed") {
      expect(event.reason).toBe("Verifikasi tidak dapat dibaca.");
    }
    expect(harness.steps.last(task.id)).toMatchObject({
      result: { status: "failed", verification: null },
    });
  });

  it.each([
    [
      "truncated JSON",
      '{"stepOk": true, "goalComplete": false, "reason": "ok"',
    ],
    [
      "an extra key",
      JSON.stringify({
        stepOk: true,
        goalComplete: false,
        reason: "ok",
        extra: true,
      }),
    ],
    [
      "a missing key",
      JSON.stringify({ stepOk: true, goalComplete: false }),
    ],
    [
      "a wrong type",
      JSON.stringify({
        stepOk: "true",
        goalComplete: false,
        reason: "ok",
      }),
    ],
  ])("fails readably when verification JSON has %s", async (_label, raw) => {
    const fake = createFakeAgent({ extractText: async () => raw });
    const harness = createRunnerHarness({ createAgent: async () => fake.agent });
    const task = createTask(harness.tasks);
    const terminal = waitForTerminal(harness.events, task.id);

    harness.runner.start(task.id);
    const event = await withDeadline(terminal);

    expect(event.type).toBe("task.failed");
    if (event.type === "task.failed") {
      expect(event.reason).toBe("Verifikasi tidak dapat dibaca.");
    }
    expect(harness.steps.last(task.id)).toMatchObject({
      result: { status: "failed", verification: null },
    });
  });

  it("completes a task when the fake agent returns fenced verification JSON", async () => {
    const fake = createFakeAgent({
      extractText: async () =>
        `\`\`\`json\n${JSON.stringify({
          stepOk: true,
          goalComplete: true,
          reason: "Tujuan tercapai.",
        })}\n\`\`\``,
    });
    const harness = createRunnerHarness({ createAgent: async () => fake.agent });
    const task = createTask(harness.tasks);
    const terminal = waitForTerminal(harness.events, task.id);

    harness.runner.start(task.id);
    const event = await withDeadline(terminal);

    expect(event.type).toBe("task.completed");
    if (event.type === "task.completed") {
      expect(event.result).toEqual({ summary: "Tujuan tercapai.", steps: 1 });
    }
    expect(harness.steps.last(task.id)).toMatchObject({
      result: {
        status: "done",
        verification: {
          stepOk: true,
          goalComplete: true,
          reason: "Tujuan tercapai.",
        },
      },
    });
  });

  it("warns with shape diagnostics and no raw content when verification fails", async () => {
    const raw = "bukan json rahasia-halaman";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const fake = createFakeAgent({ extractText: async () => raw });
      const harness = createRunnerHarness({
        createAgent: async () => fake.agent,
      });
      const task = createTask(harness.tasks);
      const terminal = waitForTerminal(harness.events, task.id);

      harness.runner.start(task.id);
      await withDeadline(terminal);

      const line = warn.mock.calls
        .map((call) => String(call[0]))
        .find((value) => value.includes("Verification parse failed"));

      expect(line).toBeDefined();
      expect(line).toContain(`task=${task.id}`);
      expect(line).toContain("type=string");
      expect(line).toContain(`length=${raw.length}`);
      expect(line).toContain("fence=false");
      expect(line).toContain("outsideText=true");
      expect(line).toContain("firstChar=letter");
      expect(line).toContain("candidates=0");
      expect(line).toContain("error=SyntaxError");
      expect(line).not.toContain("rahasia-halaman");
      expect(line).not.toContain("\n");
    } finally {
      warn.mockRestore();
    }
  });

  it("warns with fence diagnostics when fenced verification fails schema validation", async () => {
    const raw = '```json\n{"stepOk": true}\n```';
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const fake = createFakeAgent({ extractText: async () => raw });
      const harness = createRunnerHarness({
        createAgent: async () => fake.agent,
      });
      const task = createTask(harness.tasks);
      const terminal = waitForTerminal(harness.events, task.id);

      harness.runner.start(task.id);
      await withDeadline(terminal);

      const line = warn.mock.calls
        .map((call) => String(call[0]))
        .find((value) => value.includes("Verification parse failed"));

      expect(line).toBeDefined();
      expect(line).toContain("fence=true");
      expect(line).toContain("outsideText=false");
      expect(line).toContain("firstChar=backtick");
      expect(line).toContain("candidates=1");
      expect(line).toContain("error=ZodError");
    } finally {
      warn.mockRestore();
    }
  });

  it("accepts the default extract envelope", async () => {
    const fake = createFakeAgent({
      extractText: async () => ({
        extraction: JSON.stringify({
          stepOk: true,
          goalComplete: true,
          reason: "Tujuan tercapai.",
        }),
      }),
    });
    const harness = createRunnerHarness({ createAgent: async () => fake.agent });
    const task = createTask(harness.tasks);
    const terminal = waitForTerminal(harness.events, task.id);

    harness.runner.start(task.id);
    const event = await withDeadline(terminal);

    expect(event.type).toBe("task.completed");
    if (event.type === "task.completed") {
      expect(event.result).toEqual({ summary: "Tujuan tercapai.", steps: 1 });
    }
  });

  it.each([
    ["broken inner JSON", { extraction: "bukan json" }],
    [
      "missing verification key",
      { extraction: JSON.stringify({ stepOk: true, goalComplete: true }) },
    ],
  ])("fails readably when the extract envelope has %s", async (_label, envelope) => {
    const fake = createFakeAgent({ extractText: async () => envelope });
    const harness = createRunnerHarness({ createAgent: async () => fake.agent });
    const task = createTask(harness.tasks);
    const terminal = waitForTerminal(harness.events, task.id);

    harness.runner.start(task.id);
    const event = await withDeadline(terminal);

    expect(event.type).toBe("task.failed");
    if (event.type === "task.failed") {
      expect(event.reason).toBe("Verifikasi tidak dapat dibaca.");
    }
    expect(harness.steps.last(task.id)).toMatchObject({
      result: { status: "failed", verification: null },
    });
  });

  it("caps the verification reason in the failure message at 200 characters", async () => {
    const longReason = "x".repeat(300);
    const fake = createFakeAgent({
      extractText: async () =>
        JSON.stringify({
          stepOk: false,
          goalComplete: false,
          reason: longReason,
        }),
    });
    const harness = createRunnerHarness({ createAgent: async () => fake.agent });
    const task = createTask(harness.tasks);
    const terminal = waitForTerminal(harness.events, task.id);

    harness.runner.start(task.id);
    const event = await withDeadline(terminal);

    expect(event.type).toBe("task.failed");
    if (event.type === "task.failed") {
      expect(event.reason).toBe(`Langkah gagal: ${longReason.slice(0, 200)}`);
    }
  });

  it("blocks an irreversible action without calling act", async () => {
    const fake = createFakeAgent({
      observe: async () => [{ selector: "#kirim", description: "Kirim pesan" }],
    });
    const harness = createRunnerHarness({ createAgent: async () => fake.agent });
    const task = createTask(harness.tasks, "Kirim pesan ke kontak");
    const terminal = waitForTerminal(harness.events, task.id);

    harness.runner.start(task.id);
    const event = await withDeadline(terminal);

    expect(event.type).toBe("task.failed");
    if (event.type === "task.failed") {
      expect(event.reason).toBe("Aksi membutuhkan persetujuan manusia.");
    }
    expect(fake.state.actCalls).toBe(0);
    expect(harness.steps.last(task.id)).toMatchObject({
      action: "act",
      target: "Kirim pesan",
      result: {
        status: "blocked",
        pageChanged: false,
        verification: null,
      },
    });
    expect(fake.state.closed).toBe(true);
  });

  it("fails when observation returns no action", async () => {
    const fake = createFakeAgent({ observe: async () => [] });
    const harness = createRunnerHarness({ createAgent: async () => fake.agent });
    const task = createTask(harness.tasks);
    const terminal = waitForTerminal(harness.events, task.id);

    harness.runner.start(task.id);
    const event = await withDeadline(terminal);

    expect(event.type).toBe("task.failed");
    if (event.type === "task.failed") {
      expect(event.reason).toBe("Agent tidak menemukan aksi untuk langkah ini.");
    }
    expect(fake.state.actCalls).toBe(0);
    expect(harness.steps.last(task.id)).toMatchObject({
      action: "observe",
      result: { status: "failed" },
    });
  });

  it("maps a missing provider configuration to a stable reason", async () => {
    const harness = createRunnerHarness({
      createAgent: async () => {
        throw new AgentError("agent_provider_not_configured");
      },
    });
    const task = createTask(harness.tasks);
    const terminal = waitForTerminal(harness.events, task.id);

    harness.runner.start(task.id);
    const event = await withDeadline(terminal);

    expect(event.type).toBe("task.failed");
    if (event.type === "task.failed") {
      expect(event.reason).toBe("Provider model belum dikonfigurasi.");
    }
    expect(harness.steps.list(task.id)).toHaveLength(0);
  });

  it("fails when the step limit is reached before the goal", async () => {
    const fake = createFakeAgent({
      extractText: async () =>
        JSON.stringify({
          stepOk: true,
          goalComplete: false,
          reason: "Lanjut ke langkah berikutnya.",
        }),
    });
    const harness = createRunnerHarness({
      createAgent: async () => fake.agent,
      maxSteps: 2,
    });
    const task = createTask(harness.tasks);
    const terminal = waitForTerminal(harness.events, task.id);

    harness.runner.start(task.id);
    const event = await withDeadline(terminal);

    expect(event.type).toBe("task.failed");
    if (event.type === "task.failed") {
      expect(event.reason).toBe("Batas maksimal 2 langkah terlampaui.");
    }
    expect(harness.steps.list(task.id)).toHaveLength(2);
    expect(harness.steps.list(task.id).every((step) => step.result.status === "done")).toBe(
      true,
    );
  });

  it("fails when the task deadline is reached", async () => {
    vi.useFakeTimers();
    try {
      let announceObserve: () => void = () => undefined;
      const observeStarted = new Promise<void>((resolve) => {
        announceObserve = resolve;
      });
      const fake = createFakeAgent({
        observe: async () => {
          announceObserve();
          return await new Promise<readonly AgentAction[]>(() => undefined);
        },
      });
      const harness = createRunnerHarness({
        createAgent: async () => fake.agent,
        maxDurationMs: 100,
      });
      const task = createTask(harness.tasks);
      const terminal = waitForTerminal(harness.events, task.id);

      harness.runner.start(task.id);
      await observeStarted;
      await vi.advanceTimersByTimeAsync(100);
      const event = await terminal;

      expect(event.type).toBe("task.failed");
      if (event.type === "task.failed") {
        expect(event.reason).toBe("Batas waktu task terlampaui.");
      }
      expect(fake.state.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs tasks on the same session one at a time in FIFO order", async () => {
    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let announceFirst: () => void = () => undefined;
    const firstObserveStarted = new Promise<void>((resolve) => {
      announceFirst = resolve;
    });
    const created: ReturnType<typeof createFakeAgent>[] = [];

    const harness = createRunnerHarness({
      createAgent: async () => {
        const fake =
          created.length === 0
            ? createFakeAgent({
                observe: async () => {
                  announceFirst();
                  await firstGate;
                  return [defaultAction];
                },
              })
            : createFakeAgent();
        created.push(fake);
        return fake.agent;
      },
    });
    const firstTask = createTask(harness.tasks);
    const secondTask = createTask(harness.tasks);
    const firstTerminal = waitForTerminal(harness.events, firstTask.id);
    const secondTerminal = waitForTerminal(harness.events, secondTask.id);

    harness.runner.start(firstTask.id);
    await withDeadline(firstObserveStarted);
    harness.runner.start(secondTask.id);

    expect(created).toHaveLength(1);
    expect(harness.tasks.getTask(secondTask.id)?.status).toBe("queued");

    releaseFirst();
    await withDeadline(Promise.all([firstTerminal, secondTerminal]));

    expect(created).toHaveLength(2);
    expect(harness.tasks.getTask(firstTask.id)?.status).toBe("completed");
    expect(harness.tasks.getTask(secondTask.id)?.status).toBe("completed");
    expect(harness.steps.list(firstTask.id)).toHaveLength(1);
    expect(harness.steps.list(secondTask.id)).toHaveLength(1);
  });

  it("never runs a task cancelled while queued", async () => {
    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let announceFirst: () => void = () => undefined;
    const firstObserveStarted = new Promise<void>((resolve) => {
      announceFirst = resolve;
    });
    const created: ReturnType<typeof createFakeAgent>[] = [];

    const harness = createRunnerHarness({
      createAgent: async () => {
        const fake =
          created.length === 0
            ? createFakeAgent({
                observe: async () => {
                  announceFirst();
                  await firstGate;
                  return [defaultAction];
                },
              })
            : createFakeAgent();
        created.push(fake);
        return fake.agent;
      },
    });
    const firstTask = createTask(harness.tasks);
    const secondTask = createTask(harness.tasks);
    const firstTerminal = waitForTerminal(harness.events, firstTask.id);
    const secondTerminal = waitForTerminal(harness.events, secondTask.id);

    harness.runner.start(firstTask.id);
    await withDeadline(firstObserveStarted);
    harness.runner.start(secondTask.id);
    harness.tasks.cancelTask(secondTask.id);
    harness.runner.cancel(secondTask.id);

    await withDeadline(secondTerminal);
    releaseFirst();
    await withDeadline(firstTerminal);

    expect(created).toHaveLength(1);
    expect(harness.tasks.getTask(secondTask.id)?.status).toBe("cancelled");
    expect(harness.steps.list(secondTask.id)).toHaveLength(0);
  });

  it("uses one screenshot fallback per step when snapshots fail", async () => {
    const fake = createFakeAgent({
      snapshot: async () => {
        throw new AgentError("agent_snapshot_failed", "snapshot");
      },
      extractText: async (_instruction, options) => {
        if (options?.screenshot === true) {
          return "Ringkasan halaman.";
        }
        return JSON.stringify({
          stepOk: true,
          goalComplete: true,
          reason: "Selesai.",
        });
      },
    });
    const harness = createRunnerHarness({ createAgent: async () => fake.agent });
    const task = createTask(harness.tasks);
    const terminal = waitForTerminal(harness.events, task.id);

    harness.runner.start(task.id);
    const event = await withDeadline(terminal);

    expect(event.type).toBe("task.completed");
    expect(fake.state.screenshotCalls).toBe(1);
    expect(fake.state.extractCalls).toBe(2);
    expect(harness.steps.last(task.id)?.result.pageChanged).toBe(false);
  });

  it("fails when the session ends between steps", async () => {
    const sessions = createFakeSessions();
    const fake = createFakeAgent({
      extractText: async () => {
        sessions.setReady(false);
        return JSON.stringify({
          stepOk: true,
          goalComplete: false,
          reason: "Lanjut.",
        });
      },
    });
    const harness = createRunnerHarness({
      sessions,
      createAgent: async () => fake.agent,
    });
    const task = createTask(harness.tasks);
    const terminal = waitForTerminal(harness.events, task.id);

    harness.runner.start(task.id);
    const event = await withDeadline(terminal);

    expect(event.type).toBe("task.failed");
    if (event.type === "task.failed") {
      expect(event.reason).toBe("Sesi berakhir saat task berjalan.");
    }
    expect(harness.steps.list(task.id)).toHaveLength(1);
    expect(harness.steps.last(task.id)?.result.status).toBe("done");
    expect(fake.state.closed).toBe(true);
  });

  it("fails with a session-ended reason when the session closes during a call", async () => {
    const sessions = createFakeSessions();
    const fake = createFakeAgent({
      observe: async () => {
        sessions.setReady(false);
        throw new AgentError("agent_observe_failed", "observe");
      },
    });
    const harness = createRunnerHarness({
      sessions,
      createAgent: async () => fake.agent,
    });
    const task = createTask(harness.tasks);
    const terminal = waitForTerminal(harness.events, task.id);

    harness.runner.start(task.id);
    const event = await withDeadline(terminal);

    expect(event.type).toBe("task.failed");
    if (event.type === "task.failed") {
      expect(event.reason).toBe("Sesi berakhir saat task berjalan.");
    }
    expect(harness.steps.list(task.id)).toHaveLength(1);
    expect(harness.steps.last(task.id)?.result.status).toBe("failed");
    expect(fake.state.closed).toBe(true);
  });

  it("stops an HTTP cancel in under two seconds without completing the task", async () => {
    let announceObserve: () => void = () => undefined;
    const observeStarted = new Promise<void>((resolve) => {
      announceObserve = resolve;
    });
    let announceClose: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => {
      announceClose = resolve;
    });
    const fake = createFakeAgent({
      observe: async () => {
        announceObserve();
        return await new Promise<readonly AgentAction[]>(() => undefined);
      },
      close: async () => {
        announceClose();
      },
    });
    const harness = createRunnerHarness({
      createAgent: async () => fake.agent,
      shutdownTimeoutMs: 500,
    });
    const app = createAppHarness(
      harness.runner,
      harness.tasks,
      harness.sessions,
      harness.events,
    );

    const created = await app.request(`/v1/sessions/${readySessionId}/tasks`, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
        "Idempotency-Key": "http-cancel-key",
      },
      body: JSON.stringify({ goal: "Buka halaman kontak" }),
    });
    expect(created.status).toBe(202);
    const createdBody = (await created.json()) as { data: Task };

    await withDeadline(observeStarted);

    const cancelStartedAt = Date.now();
    const cancelled = await app.request(`/v1/tasks/${createdBody.data.id}/cancel`, {
      method: "POST",
      headers: { Authorization: authorization },
    });
    expect(cancelled.status).toBe(202);
    const cancelledBody = (await cancelled.json()) as { data: Task };
    expect(cancelledBody.data.status).toBe("cancelled");

    await withDeadline(closed, 2_000);
    const elapsedMs = Date.now() - cancelStartedAt;
    console.info(`HTTP cancel closed the loop in ${elapsedMs} ms.`);

    expect(elapsedMs).toBeLessThan(2_000);
    expect(harness.tasks.getTask(createdBody.data.id)?.status).toBe("cancelled");
    expect(harness.steps.list(createdBody.data.id)).toHaveLength(0);
    expect(
      harness.events.list().some(({ event }) => event.type === "task.completed"),
    ).toBe(false);
  });

  it("cancels active tasks and closes agents on shutdown", async () => {
    let announceObserve: () => void = () => undefined;
    const observeStarted = new Promise<void>((resolve) => {
      announceObserve = resolve;
    });
    const fake = createFakeAgent({
      observe: async () => {
        announceObserve();
        return await new Promise<readonly AgentAction[]>(() => undefined);
      },
    });
    const harness = createRunnerHarness({
      createAgent: async () => fake.agent,
      shutdownTimeoutMs: 500,
    });
    const task = createTask(harness.tasks);

    harness.runner.start(task.id);
    await withDeadline(observeStarted);

    const startedAt = Date.now();
    await harness.runner.shutdown();
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(5_000);
    expect(harness.tasks.getTask(task.id)?.status).toBe("cancelled");
    expect(fake.state.closed).toBe(true);
    expect(
      harness.events.list().some(({ event }) => event.type === "task.completed"),
    ).toBe(false);

    await harness.runner.shutdown();
    expect(fake.state.closeCount).toBe(1);
  });
});

describe("task runner pre-navigation", () => {
  const goalUrl = "https://contoh.test/halaman";

  it("creates the agent before navigating to the first goal URL", async () => {
    const sessions = createFakeSessions({ initialUrl: "about:blank" });
    let gotoCallsAtAgentCreation = -1;
    let observedUrl = "";
    const fake = createFakeAgent({
      observe: async () => {
        observedUrl =
          sessions.getContext(readySessionId)?.pages().at(-1)?.url() ?? "";
        return [defaultAction];
      },
    });
    const harness = createRunnerHarness({
      sessions,
      createAgent: async () => {
        gotoCallsAtAgentCreation = sessions.gotoCalls.length;
        return fake.agent;
      },
    });
    const task = createTask(harness.tasks, `Buka ${goalUrl}`);
    const terminal = waitForTerminal(harness.events, task.id);

    harness.runner.start(task.id);
    const event = await withDeadline(terminal);

    expect(event.type).toBe("task.completed");
    if (event.type === "task.completed") {
      expect(event.result).toEqual({ summary: "Tujuan tercapai.", steps: 2 });
    }
    expect(sessions.gotoCalls).toEqual([{ url: goalUrl, timeout: 30_000 }]);
    expect(gotoCallsAtAgentCreation).toBe(0);
    expect(observedUrl).toBe(goalUrl);

    const recorded = harness.steps.list(task.id);
    expect(recorded).toHaveLength(2);
    expect(recorded[0]).toMatchObject({
      index: 1,
      action: "navigate",
      target: goalUrl,
      result: {
        status: "done",
        url: goalUrl,
        pageChanged: true,
        verification: {
          stepOk: true,
          goalComplete: false,
          reason: "Halaman berhasil dibuka.",
        },
      },
    });
    expect(recorded[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(recorded[1]).toMatchObject({
      index: 2,
      action: "act",
      target: "Buka kontak",
    });

    const published = taskEvents(harness.events, task.id);
    expect(published.map((item) => item.type)).toEqual([
      "agent.step",
      "agent.step",
      "task.completed",
    ]);
    const navigationEvent = published[0];
    if (navigationEvent?.type !== "agent.step") {
      throw new Error("Expected a navigation agent.step event.");
    }
    expect(navigationEvent).toMatchObject({
      index: 1,
      action: "navigate",
      target: goalUrl,
      status: "done",
      url: goalUrl,
    });
    expect(Object.keys(navigationEvent).sort()).toEqual(AGENT_STEP_KEYS);
  });

  it("does not navigate when the active page is already open", async () => {
    const sessions = createFakeSessions();
    const fake = createFakeAgent();
    const harness = createRunnerHarness({
      sessions,
      createAgent: async () => fake.agent,
    });
    const task = createTask(harness.tasks, `Buka ${goalUrl}`);
    const terminal = waitForTerminal(harness.events, task.id);

    harness.runner.start(task.id);
    const event = await withDeadline(terminal);

    expect(event.type).toBe("task.completed");
    expect(sessions.gotoCalls).toHaveLength(0);
    expect(harness.steps.list(task.id)).toHaveLength(1);
    expect(harness.steps.last(task.id)).toMatchObject({
      index: 1,
      action: "act",
    });
  });

  it("fails when the active page is empty and the goal has no URL", async () => {
    const sessions = createFakeSessions({ initialUrl: "about:blank" });
    let isAgentCreated = false;
    const fake = createFakeAgent();
    const harness = createRunnerHarness({
      sessions,
      createAgent: async () => {
        isAgentCreated = true;
        return fake.agent;
      },
    });
    const task = createTask(harness.tasks, "Buka halaman kontak");
    const terminal = waitForTerminal(harness.events, task.id);

    harness.runner.start(task.id);
    const event = await withDeadline(terminal);

    expect(event.type).toBe("task.failed");
    if (event.type === "task.failed") {
      expect(event.reason).toBe(
        "Halaman awal kosong dan tujuan tidak menyebut URL.",
      );
    }
    expect(isAgentCreated).toBe(true);
    expect(fake.state.closed).toBe(true);
    expect(sessions.gotoCalls).toHaveLength(0);
    expect(harness.steps.list(task.id)).toHaveLength(0);
  });

  it("records a failed navigation step and closes the created agent", async () => {
    const sessions = createFakeSessions({
      initialUrl: "about:blank",
      goto: async () => {
        throw new Error("Navigation timeout");
      },
    });
    let isAgentCreated = false;
    const fake = createFakeAgent();
    const harness = createRunnerHarness({
      sessions,
      createAgent: async () => {
        isAgentCreated = true;
        return fake.agent;
      },
    });
    const task = createTask(harness.tasks, `Buka ${goalUrl}`);
    const terminal = waitForTerminal(harness.events, task.id);

    harness.runner.start(task.id);
    const event = await withDeadline(terminal);

    expect(event.type).toBe("task.failed");
    if (event.type === "task.failed") {
      expect(event.reason).toBe(
        "Halaman tidak dapat dibuka dari URL pada tujuan task.",
      );
    }
    expect(isAgentCreated).toBe(true);
    expect(fake.state.closed).toBe(true);
    expect(sessions.gotoCalls).toEqual([{ url: goalUrl, timeout: 30_000 }]);

    const recorded = harness.steps.list(task.id);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      index: 1,
      action: "navigate",
      target: goalUrl,
      result: {
        status: "failed",
        pageChanged: false,
        verification: null,
      },
    });
  });

  it("extracts the first URL without trailing punctuation", async () => {
    const sessions = createFakeSessions({ initialUrl: "about:blank" });
    const fake = createFakeAgent();
    const harness = createRunnerHarness({
      sessions,
      createAgent: async () => fake.agent,
    });
    const task = createTask(
      harness.tasks,
      "Buka https://satu.test/halaman., lalu https://dua.test/halaman)",
    );
    const terminal = waitForTerminal(harness.events, task.id);

    harness.runner.start(task.id);
    const event = await withDeadline(terminal);

    expect(event.type).toBe("task.completed");
    expect(sessions.gotoCalls).toEqual([
      { url: "https://satu.test/halaman", timeout: 30_000 },
    ]);
    expect(harness.steps.list(task.id)[0]).toMatchObject({
      action: "navigate",
      target: "https://satu.test/halaman",
    });
  });

  it("creates a page when the session context has none", async () => {
    const sessions = createFakeSessions({ initialUrl: "about:blank" });
    sessions.clearPages();
    const fake = createFakeAgent();
    const harness = createRunnerHarness({
      sessions,
      createAgent: async () => fake.agent,
    });
    const task = createTask(harness.tasks, `Buka ${goalUrl}`);
    const terminal = waitForTerminal(harness.events, task.id);

    harness.runner.start(task.id);
    const event = await withDeadline(terminal);

    expect(event.type).toBe("task.completed");
    expect(sessions.gotoCalls).toEqual([{ url: goalUrl, timeout: 30_000 }]);
    expect(harness.steps.list(task.id)).toHaveLength(2);
  });

  it("keeps the previous behavior when the session context is unavailable", async () => {
    const sessions = createFakeSessions({ initialUrl: "about:blank" });
    sessions.setContextAvailable(false);
    const fake = createFakeAgent();
    const harness = createRunnerHarness({
      sessions,
      createAgent: async () => fake.agent,
    });
    const task = createTask(harness.tasks, `Buka ${goalUrl}`);
    const terminal = waitForTerminal(harness.events, task.id);

    harness.runner.start(task.id);
    const event = await withDeadline(terminal);

    expect(event.type).toBe("task.completed");
    expect(sessions.gotoCalls).toHaveLength(0);
    expect(harness.steps.list(task.id)).toHaveLength(1);
    expect(harness.steps.last(task.id)).toMatchObject({
      index: 1,
      action: "act",
    });
  });
});

describe("task runner page preparation", () => {
  it("records a done reload step before the first agent step", async () => {
    const fake = createFakeAgent({
      preparePage: async () => ({ reloaded: true }),
    });
    const harness = createRunnerHarness({ createAgent: async () => fake.agent });
    const task = createTask(harness.tasks);
    const terminal = waitForTerminal(harness.events, task.id);

    harness.runner.start(task.id);
    const event = await withDeadline(terminal);

    expect(event.type).toBe("task.completed");
    if (event.type === "task.completed") {
      expect(event.result).toEqual({ summary: "Tujuan tercapai.", steps: 2 });
    }
    expect(fake.state.prepareCalls).toBe(1);

    const recorded = harness.steps.list(task.id);
    expect(recorded).toHaveLength(2);
    expect(recorded[0]).toMatchObject({
      index: 1,
      action: "reload",
      target: "Muat ulang halaman",
      result: {
        status: "done",
        url: pageUrl,
        pageChanged: true,
        verification: {
          stepOk: true,
          goalComplete: false,
          reason: "Halaman dimuat ulang agar agent siap.",
        },
      },
    });
    expect(recorded[1]).toMatchObject({ index: 2, action: "act" });
    expect(fake.state.closed).toBe(true);
  });

  it("does not record a reload step when the page is ready", async () => {
    const fake = createFakeAgent();
    const harness = createRunnerHarness({ createAgent: async () => fake.agent });
    const task = createTask(harness.tasks);
    const terminal = waitForTerminal(harness.events, task.id);

    harness.runner.start(task.id);
    const event = await withDeadline(terminal);

    expect(event.type).toBe("task.completed");
    expect(fake.state.prepareCalls).toBe(1);
    expect(harness.steps.list(task.id)).toHaveLength(1);
    expect(harness.steps.last(task.id)).toMatchObject({
      index: 1,
      action: "act",
    });
  });

  it("fails and records a failed reload step when the page stays unready", async () => {
    const fake = createFakeAgent({
      preparePage: async () => {
        throw new AgentError("agent_page_not_ready", "prepare", true);
      },
    });
    const harness = createRunnerHarness({ createAgent: async () => fake.agent });
    const task = createTask(harness.tasks);
    const terminal = waitForTerminal(harness.events, task.id);

    harness.runner.start(task.id);
    const event = await withDeadline(terminal);

    expect(event.type).toBe("task.failed");
    if (event.type === "task.failed") {
      expect(event.reason).toBe(
        "Halaman belum siap untuk agent setelah dimuat ulang.",
      );
    }
    expect(fake.state.observeCalls).toBe(0);
    expect(fake.state.closed).toBe(true);
    expect(harness.steps.list(task.id)).toHaveLength(1);
    expect(harness.steps.last(task.id)).toMatchObject({
      index: 1,
      action: "reload",
      target: "Muat ulang halaman",
      result: {
        status: "failed",
        pageChanged: true,
        verification: null,
      },
    });
  });

  it("does not record a reload step when preparation fails before a reload", async () => {
    const fake = createFakeAgent({
      preparePage: async () => {
        throw new AgentError("agent_page_not_ready", "prepare");
      },
    });
    const harness = createRunnerHarness({ createAgent: async () => fake.agent });
    const task = createTask(harness.tasks);
    const terminal = waitForTerminal(harness.events, task.id);

    harness.runner.start(task.id);
    const event = await withDeadline(terminal);

    expect(event.type).toBe("task.failed");
    expect(fake.state.observeCalls).toBe(0);
    expect(harness.steps.list(task.id)).toHaveLength(0);
  });
});

describe("agent.step events", () => {
  it("publishes one agent.step before task.completed without verification fields", async () => {
    const fake = createFakeAgent();
    const harness = createRunnerHarness({ createAgent: async () => fake.agent });
    const task = createTask(harness.tasks);
    const terminal = waitForTerminal(harness.events, task.id);

    harness.runner.start(task.id);
    await withDeadline(terminal);

    const published = taskEvents(harness.events, task.id);
    expect(published.map((event) => event.type)).toEqual([
      "agent.step",
      "task.completed",
    ]);

    const stepEvent = published[0];
    if (stepEvent?.type !== "agent.step") {
      throw new Error("Expected an agent.step event.");
    }

    expect(stepEvent).toEqual({
      type: "agent.step",
      taskId: task.id,
      index: 1,
      action: "act",
      target: "Buka kontak",
      status: "done",
      url: pageUrl,
      at: expect.any(String),
    });
    expect(Object.keys(stepEvent).sort()).toEqual(AGENT_STEP_KEYS);
    expect(stepEvent.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("publishes a failed agent.step before task.failed without the reason", async () => {
    const fake = createFakeAgent({
      extractText: async () =>
        JSON.stringify({
          stepOk: false,
          goalComplete: false,
          reason: "Tombol belum berubah.",
        }),
    });
    const harness = createRunnerHarness({ createAgent: async () => fake.agent });
    const task = createTask(harness.tasks);
    const terminal = waitForTerminal(harness.events, task.id);

    harness.runner.start(task.id);
    await withDeadline(terminal);

    const published = taskEvents(harness.events, task.id);
    expect(published.map((event) => event.type)).toEqual([
      "agent.step",
      "task.failed",
    ]);

    const stepEvent = published[0];
    if (stepEvent?.type !== "agent.step") {
      throw new Error("Expected an agent.step event.");
    }

    expect(stepEvent.status).toBe("failed");
    expect(Object.keys(stepEvent).sort()).toEqual(AGENT_STEP_KEYS);
    expect(JSON.stringify(stepEvent)).not.toContain("Tombol belum berubah.");
  });

  it("publishes a blocked agent.step before task.failed", async () => {
    const fake = createFakeAgent({
      observe: async () => [{ selector: "#kirim", description: "Kirim pesan" }],
    });
    const harness = createRunnerHarness({ createAgent: async () => fake.agent });
    const task = createTask(harness.tasks, "Kirim pesan ke kontak");
    const terminal = waitForTerminal(harness.events, task.id);

    harness.runner.start(task.id);
    await withDeadline(terminal);

    const published = taskEvents(harness.events, task.id);
    expect(published.map((event) => event.type)).toEqual([
      "agent.step",
      "task.failed",
    ]);

    const stepEvent = published[0];
    if (stepEvent?.type !== "agent.step") {
      throw new Error("Expected an agent.step event.");
    }

    expect(stepEvent).toMatchObject({
      index: 1,
      action: "act",
      target: "Kirim pesan",
      status: "blocked",
    });
    expect(Object.keys(stepEvent).sort()).toEqual(AGENT_STEP_KEYS);
  });

  it("publishes exactly one agent.step per recorded step", async () => {
    const fake = createFakeAgent({
      extractText: async () =>
        JSON.stringify({
          stepOk: true,
          goalComplete: false,
          reason: "Lanjut ke langkah berikutnya.",
        }),
    });
    const harness = createRunnerHarness({
      createAgent: async () => fake.agent,
      maxSteps: 2,
    });
    const task = createTask(harness.tasks);
    const terminal = waitForTerminal(harness.events, task.id);

    harness.runner.start(task.id);
    await withDeadline(terminal);

    const published = taskEvents(harness.events, task.id);
    expect(published.map((event) => event.type)).toEqual([
      "agent.step",
      "agent.step",
      "task.failed",
    ]);
    expect(
      published.flatMap((event) =>
        event.type === "agent.step" ? [event.index] : [],
      ),
    ).toEqual([1, 2]);
  });
});
