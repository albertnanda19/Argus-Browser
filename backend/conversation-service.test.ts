import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Message } from "../shared/conversation";
import { taskCompletedEventSchema } from "../shared/event";
import type { Session } from "../shared/session";
import { ConversationError } from "./conversation-errors";
import {
  createConversationService,
  type ConversationService,
} from "./conversation-service";
import { createConversationStore, type ConversationStore } from "./conversation-store";
import { createEventBus } from "./event-bus";
import { ProfileStoreError } from "./profile-store";
import { SessionError } from "./session-errors";
import { createTaskManager, type TaskService } from "./task-manager";

const testRoot = resolve(
  process.cwd(),
  "..",
  "tmp",
  "testing",
  `conversation-service-${randomBytes(4).toString("hex")}`,
);

const profileId = "p_0000000000000001";
const otherProfileId = "p_0000000000000002";
const fixedNow = new Date("2026-10-28T10:00:00.000Z");

let appDataSequence = 0;

function newAppDataDir(): string {
  appDataSequence += 1;
  return join(testRoot, `appdata-${appDataSequence}`);
}

function makeSession(profileIdValue: string, suffix: string): Session {
  return {
    id: `s_${suffix.padStart(16, "0")}`,
    profileId: profileIdValue,
    status: "ready",
    startedAt: fixedNow.toISOString(),
    endedAt: null,
    pid: null,
  };
}

type HarnessOptions = {
  readonly start?: (profileId: string) => Promise<Session>;
  readonly listActive?: () => Session[];
  readonly sessionReadyTimeoutMs?: number;
  readonly sessionPollIntervalMs?: number;
  readonly idempotencyTtlMs?: number;
};

function createHarness(options: HarnessOptions = {}) {
  const appDataDir = newAppDataDir();
  let currentTime = new Date(fixedNow);
  const now = (): Date => currentTime;
  const events = createEventBus();
  const store: ConversationStore = createConversationStore({ appDataDir, now });
  const active: Session[] = [];
  const sessions = {
    active,
    listActive: options.listActive ?? (() => active),
    start:
      options.start ??
      (async (profileIdValue: string) => {
        const session = makeSession(profileIdValue, "1");
        active.push(session);
        return session;
      }),
    get: (sessionId: string): Session | null =>
      active.find((session) => session.id === sessionId) ?? null,
  };
  const tasks: TaskService = createTaskManager({
    sessions: { get: (sessionId) => sessions.get(sessionId) },
    events,
    now,
  });
  const runner = { start: vi.fn() };
  const serviceOptions = {
    store,
    profiles: {
      get: async (profileIdValue: string) => {
        if (profileIdValue !== profileId && profileIdValue !== otherProfileId) {
          throw new ProfileStoreError("profile_not_found", "Profil tidak ditemukan.");
        }
        return { id: profileIdValue };
      },
    },
    sessions,
    tasks,
    runner,
    events,
    now,
    sessionReadyTimeoutMs: options.sessionReadyTimeoutMs,
    sessionPollIntervalMs: options.sessionPollIntervalMs,
    idempotencyTtlMs: options.idempotencyTtlMs,
  };

  const service: ConversationService = createConversationService(serviceOptions);

  return {
    appDataDir,
    events,
    store,
    sessions,
    tasks,
    runner,
    service,
    now,
    advance(milliseconds: number): void {
      currentTime = new Date(currentTime.getTime() + milliseconds);
    },
    restart(): {
      store: ConversationStore;
      service: ConversationService;
    } {
      const restartedStore = createConversationStore({ appDataDir, now });
      service.shutdown();
      const restartedService = createConversationService({
        ...serviceOptions,
        store: restartedStore,
      });
      return { store: restartedStore, service: restartedService };
    },
  };
}

async function expectConversationError(
  action: () => Promise<unknown>,
  code: ConversationError["code"],
): Promise<void> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(ConversationError);
    expect((error as ConversationError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ConversationError ${code}`);
}

function agentMessages(messages: readonly Message[]): Message[] {
  return messages.filter((message) => message.role === "agent");
}

beforeAll(async () => {
  await mkdir(testRoot, { recursive: true });
});

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

describe("conversation service", () => {
  it("creates a conversation and returns messages newest first", async () => {
    const harness = createHarness();
    const conversation = await harness.service.create(profileId, { title: "Rencana" });

    expect((await harness.service.list(profileId))[0]?.id).toBe(conversation.id);

    await harness.service.sendMessage(profileId, conversation.id, "satu", "key-1");
    harness.advance(1_000);
    await harness.service.sendMessage(profileId, conversation.id, "dua", "key-2");

    const messages = await harness.service.listMessages(profileId, conversation.id);
    expect(messages.map((message) => message.text)).toEqual(["dua", "satu"]);
    expect(messages.map((message) => message.role)).toEqual(["operator", "operator"]);
  });

  it("starts a browser session automatically and creates one task", async () => {
    const harness = createHarness();
    const conversation = await harness.service.create(profileId, {});
    const start = vi.spyOn(harness.sessions, "start");

    const result = await harness.service.sendMessage(
      profileId,
      conversation.id,
      "Cari kontak penjualan",
      "key-auto",
    );

    expect(start).toHaveBeenCalledWith(profileId);
    expect(result.message.taskId).toBe(result.task.id);
    expect(result.task.conversationId).toBe(conversation.id);
    expect(result.task.goal).toBe("Cari kontak penjualan");
    expect(result.conversation.title).toBe("Cari kontak penjualan");
    expect(harness.runner.start).toHaveBeenCalledWith(result.task.id);
    expect(harness.tasks.listTasks()).toHaveLength(1);
  });

  it("uses an existing ready session without starting a new one", async () => {
    const ready = makeSession(profileId, "9");
    const harness = createHarness({ listActive: () => [ready] });
    harness.sessions.active.push(ready);
    const conversation = await harness.service.create(profileId, {});
    const start = vi.spyOn(harness.sessions, "start");

    const result = await harness.service.sendMessage(
      profileId,
      conversation.id,
      "Lanjutkan",
      "key-ready",
    );

    expect(start).not.toHaveBeenCalled();
    expect(result.task.sessionId).toBe(ready.id);
  });

  it("returns session not ready without a message or task when start fails", async () => {
    const harness = createHarness({
      start: async () => {
        throw new SessionError("session_launch_failed");
      },
    });
    const conversation = await harness.service.create(profileId, {});

    await expectConversationError(
      () => harness.service.sendMessage(profileId, conversation.id, "Halo", "key-fail"),
      "conversation_session_not_ready",
    );

    expect(await harness.store.countMessages(profileId, conversation.id)).toBe(0);
    expect(harness.tasks.listTasks()).toHaveLength(0);
    expect(harness.runner.start).not.toHaveBeenCalled();
  });

  it("polls for a ready session after a session conflict", async () => {
    let listCalls = 0;
    const ready = makeSession(profileId, "7");
    const harness = createHarness({
      start: async () => {
        throw new SessionError("session_conflict");
      },
      listActive: () => {
        listCalls += 1;
        return listCalls >= 2 ? [ready] : [];
      },
      sessionPollIntervalMs: 5,
      sessionReadyTimeoutMs: 500,
    });
    harness.sessions.active.push(ready);
    const conversation = await harness.service.create(profileId, {});

    const result = await harness.service.sendMessage(
      profileId,
      conversation.id,
      "Halo",
      "key-conflict",
    );

    expect(result.task.sessionId).toBe(ready.id);
    expect(listCalls).toBeGreaterThanOrEqual(2);
  });

  it("times out waiting for a session without saving a message", async () => {
    const harness = createHarness({
      start: async () => {
        throw new SessionError("session_conflict");
      },
      listActive: () => [],
      sessionPollIntervalMs: 5,
      sessionReadyTimeoutMs: 30,
    });
    const conversation = await harness.service.create(profileId, {});

    await expectConversationError(
      () => harness.service.sendMessage(profileId, conversation.id, "Halo", "key-timeout"),
      "conversation_session_not_ready",
    );

    expect(await harness.store.countMessages(profileId, conversation.id)).toBe(0);
    expect(harness.tasks.listTasks()).toHaveLength(0);
  });

  it("replays the same message for the same key and rejects a different text", async () => {
    const harness = createHarness();
    const conversation = await harness.service.create(profileId, {});

    const first = await harness.service.sendMessage(
      profileId,
      conversation.id,
      "Halo",
      "key-same",
    );
    const replay = await harness.service.sendMessage(
      profileId,
      conversation.id,
      "Halo",
      "key-same",
    );

    expect(replay.message.id).toBe(first.message.id);
    expect(replay.task.id).toBe(first.task.id);
    expect(await harness.store.countMessages(profileId, conversation.id)).toBe(1);

    await expectConversationError(
      () =>
        harness.service.sendMessage(
          profileId,
          conversation.id,
          "Teks berbeda",
          "key-same",
        ),
      "conversation_idempotency_conflict",
    );
  });

  it("creates only one task for two concurrent sends with the same key", async () => {
    const harness = createHarness();
    const conversation = await harness.service.create(profileId, {});

    const [first, second] = await Promise.all([
      harness.service.sendMessage(profileId, conversation.id, "Halo", "key-race"),
      harness.service.sendMessage(profileId, conversation.id, "Halo", "key-race"),
    ]);

    expect(second.message.id).toBe(first.message.id);
    expect(harness.tasks.listTasks()).toHaveLength(1);
    expect(await harness.store.countMessages(profileId, conversation.id)).toBe(1);
  });

  it("expires idempotency after 24 hours", async () => {
    const harness = createHarness();
    const conversation = await harness.service.create(profileId, {});

    const first = await harness.service.sendMessage(
      profileId,
      conversation.id,
      "Halo",
      "key-ttl",
    );
    harness.advance(24 * 60 * 60 * 1_000);
    const second = await harness.service.sendMessage(
      profileId,
      conversation.id,
      "Halo",
      "key-ttl",
    );

    expect(second.task.id).not.toBe(first.task.id);
    expect(second.message.id).not.toBe(first.message.id);
  });

  it("rejects a send that would exceed the conversation cap", async () => {
    const harness = createHarness();
    const conversation = await harness.service.create(profileId, {});
    const lines: string[] = [];
    for (let index = 0; index < 1_999; index += 1) {
      lines.push(
        JSON.stringify({
          id: `m_${index.toString(16).padStart(16, "0")}`,
          conversationId: conversation.id,
          role: index % 2 === 0 ? "operator" : "agent",
          text: `pesan ${index}`,
          taskId: null,
          createdAt: fixedNow.toISOString(),
        }),
      );
    }
    await writeFile(
      join(
        harness.appDataDir,
        "profiles",
        profileId,
        "conversations",
        conversation.id,
        "messages.jsonl",
      ),
      `${lines.join("\n")}\n`,
      { mode: 0o600 },
    );

    await expectConversationError(
      () => harness.service.sendMessage(profileId, conversation.id, "Terakhir", "key-cap"),
      "conversation_full",
    );

    expect(harness.tasks.listTasks()).toHaveLength(0);
    expect(harness.runner.start).not.toHaveBeenCalled();
  });

  it("appends agent replies for completed, failed, and cancelled tasks", async () => {
    const harness = createHarness();
    const conversation = await harness.service.create(profileId, {});

    const completed = await harness.service.sendMessage(
      profileId,
      conversation.id,
      "Satu",
      "key-completed",
    );
    harness.tasks.startTask(completed.task.id);
    harness.tasks.completeTask(completed.task.id, { summary: "Ringkasan verifikasi" });

    await vi.waitFor(async () => {
      const messages = await harness.store.listMessages(profileId, conversation.id);
      expect(agentMessages(messages).map((message) => message.text)).toContain(
        "Ringkasan verifikasi",
      );
    });

    const failed = await harness.service.sendMessage(
      profileId,
      conversation.id,
      "Dua",
      "key-failed",
    );
    harness.tasks.startTask(failed.task.id);
    harness.tasks.failTask(failed.task.id, "Halaman gagal dibuka.");

    const cancelled = await harness.service.sendMessage(
      profileId,
      conversation.id,
      "Tiga",
      "key-cancelled",
    );
    harness.tasks.startTask(cancelled.task.id);
    harness.tasks.cancelTask(cancelled.task.id);

    await vi.waitFor(async () => {
      const texts = agentMessages(
        await harness.store.listMessages(profileId, conversation.id),
      ).map((message) => message.text);
      expect(texts).toContain("Halaman gagal dibuka.");
      expect(texts).toContain("Task dibatalkan.");
    });

    const replies = agentMessages(
      await harness.store.listMessages(profileId, conversation.id),
    );
    expect(replies).toHaveLength(3);
    expect(replies.map((message) => message.taskId)).toEqual([
      completed.task.id,
      failed.task.id,
      cancelled.task.id,
    ]);
  });

  it("uses fallbacks, truncates agent replies, and never doubles a reply", async () => {
    const harness = createHarness();
    const conversation = await harness.service.create(profileId, {});
    const result = await harness.service.sendMessage(
      profileId,
      conversation.id,
      "Satu",
      "key-double",
    );

    harness.tasks.startTask(result.task.id);
    harness.tasks.completeTask(result.task.id, { summary: "x".repeat(1_000) });
    const event = taskCompletedEventSchema.parse({
      type: "task.completed",
      taskId: result.task.id,
      result: { summary: "x".repeat(1_000) },
      at: fixedNow.toISOString(),
    });
    harness.events.publish(event);

    await vi.waitFor(async () => {
      expect(agentMessages(await harness.store.listMessages(profileId, conversation.id))).toHaveLength(1);
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));

    const replies = agentMessages(
      await harness.store.listMessages(profileId, conversation.id),
    );
    expect(replies).toHaveLength(1);
    expect(replies[0]?.text).toHaveLength(600);

    const second = await harness.service.create(profileId, {});
    const failed = await harness.service.sendMessage(
      profileId,
      second.id,
      "Dua",
      "key-fallback",
    );
    harness.tasks.startTask(failed.task.id);
    harness.tasks.failTask(failed.task.id, "Alasan gagal.");
    await vi.waitFor(async () => {
      expect(
        agentMessages(await harness.store.listMessages(profileId, second.id)),
      ).toHaveLength(1);
    });
  });

  it("uses the completed fallback when the summary is missing", async () => {
    const harness = createHarness();
    const conversation = await harness.service.create(profileId, {});
    const result = await harness.service.sendMessage(
      profileId,
      conversation.id,
      "Satu",
      "key-summary-fallback",
    );

    harness.tasks.startTask(result.task.id);
    harness.tasks.completeTask(result.task.id, {});

    await vi.waitFor(async () => {
      const messages = agentMessages(
        await harness.store.listMessages(profileId, conversation.id),
      );
      expect(messages[0]?.text).toBe("Tugas selesai.");
    });
  });

  it("ignores terminal events for tasks without a conversation", async () => {
    const harness = createHarness();
    const conversation = await harness.service.create(profileId, {});
    const session = makeSession(profileId, "5");
    harness.sessions.active.push(session);
    const task = harness.tasks.createTask(
      session.id,
      { goal: "Task lama" },
      "old-task-key",
    );

    harness.tasks.startTask(task.id);
    harness.tasks.cancelTask(task.id);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));

    expect(await harness.store.listMessages(profileId, conversation.id)).toEqual([]);
  });

  it("keeps conversations and messages across a service restart", async () => {
    const harness = createHarness();
    const conversation = await harness.service.create(profileId, { title: "Persisten" });
    await harness.service.sendMessage(
      profileId,
      conversation.id,
      "Tetap tersimpan",
      "key-persist",
    );

    const restarted = harness.restart();
    const conversations = await restarted.service.list(profileId);
    const messages = await restarted.service.listMessages(profileId, conversation.id);

    expect(conversations[0]?.id).toBe(conversation.id);
    expect(conversations[0]?.title).toBe("Persisten");
    expect(messages.map((message) => message.text)).toEqual(["Tetap tersimpan"]);
  });

  it("returns conversation not found for a conversation owned by another profile", async () => {
    const harness = createHarness();
    const conversation = await harness.service.create(profileId, {});

    await expectConversationError(
      () => harness.service.listMessages(otherProfileId, conversation.id),
      "conversation_not_found",
    );
    await expectConversationError(
      () =>
        harness.service.sendMessage(
          otherProfileId,
          conversation.id,
          "Halo",
          "key-other",
        ),
      "conversation_not_found",
    );
  });

  it("returns profile not found before touching conversation storage", async () => {
    const harness = createHarness();
    const conversation = await harness.service.create(profileId, {});

    await expectConversationError(
      () => harness.service.list("p_00000000000000ff"),
      "conversation_profile_not_found",
    );
    await expectConversationError(
      () =>
        harness.service.sendMessage(
          "p_00000000000000ff",
          conversation.id,
          "Halo",
          "key-missing",
        ),
      "conversation_profile_not_found",
    );
  });
});
