import { randomBytes } from "node:crypto";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChromeInstallerState } from "../shared/chrome-installer";
import type { Conversation } from "../shared/conversation";
import type { Problem } from "../shared/contracts";
import type { Session } from "../shared/session";
import {
  createApp,
  type ConversationServiceApi,
  type ProfileService,
} from "./app";
import { ConversationError } from "./conversation-errors";
import {
  createConversationService,
  type ConversationService,
} from "./conversation-service";
import { createConversationStore } from "./conversation-store";
import { createEventBus } from "./event-bus";
import { createEventStreamRegistry } from "./event-stream";
import { ProfileStoreError } from "./profile-store";
import { createTaskManager } from "./task-manager";

const token = "test-token";
const authorization = `Bearer ${token}`;
const allowedOrigin = "http://127.0.0.1:5173";
const profileId = "p_0000000000000001";
const otherProfileId = "p_0000000000000002";
const missingProfileId = "p_00000000000000ff";
const fixedNow = "2026-10-28T10:00:00.000Z";

const testRoot = resolve(
  process.cwd(),
  "..",
  "tmp",
  "testing",
  `conversation-api-${randomBytes(4).toString("hex")}`,
);

const readyState: ChromeInstallerState = {
  status: "ready",
  source: "managed",
  version: "156.0.8078.47",
  progress: null,
  error: null,
};

let appDataSequence = 0;

function newAppDataDir(): string {
  appDataSequence += 1;
  return join(testRoot, `appdata-${appDataSequence}`);
}

function makeSession(id: string): Session {
  return {
    id,
    profileId,
    status: "ready",
    startedAt: fixedNow,
    endedAt: null,
    pid: null,
  };
}

type HarnessOptions = {
  readonly conversations?: ConversationServiceApi;
};

function createHarness(options: HarnessOptions = {}) {
  const appDataDir = newAppDataDir();
  const events = createEventBus();
  const readySession = makeSession("s_0000000000000001");
  const sessions = {
    start: async () => readySession,
    listActive: () => [readySession],
    get: (sessionId: string): Session | null =>
      sessionId === readySession.id ? readySession : null,
    close: async () => readySession,
  };
  const tasks = createTaskManager({
    sessions: { get: (sessionId) => sessions.get(sessionId) },
    events,
  });
  const runner = {
    start: vi.fn(),
    cancel: vi.fn(),
    notifyApprovalDecision: vi.fn(),
  };
  const profiles: ProfileService = {
    list: async () => [],
    create: async (name: string) => ({
      id: profileId,
      name,
      createdAt: fixedNow,
      lastUsedAt: null,
    }),
    delete: async () => undefined,
  };
  const store = createConversationStore({ appDataDir });
  const realService = createConversationService({
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
    sessionPollIntervalMs: 5,
    sessionReadyTimeoutMs: 200,
  });
  const conversations = options.conversations ?? realService;

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
    profilePolicies: {
      get: async () => {
        throw new Error("Unused profile policy lookup.");
      },
      set: async () => {
        throw new Error("Unused profile policy update.");
      },
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
    conversations,
  });

  return {
    app,
    appDataDir,
    service: realService,
    tasks,
    messagesFile(conversationId: string): string {
      return join(
        appDataDir,
        "profiles",
        profileId,
        "conversations",
        conversationId,
        "messages.jsonl",
      );
    },
  };
}

function withAuth(init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: { ...init.headers, Authorization: authorization },
  };
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function createConversation(
  app: ReturnType<typeof createHarness>["app"],
  title?: string,
): Promise<Conversation> {
  const response = await app.request(
    `/v1/profiles/${profileId}/conversations`,
    withAuth({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(title === undefined ? {} : { title }),
    }),
  );
  return (await json<{ data: Conversation }>(response)).data;
}

function sendRequest(text: unknown, key?: string): RequestInit {
  return withAuth({
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(key === undefined ? {} : { "Idempotency-Key": key }),
    },
    body: JSON.stringify({ text }),
  });
}

beforeAll(async () => {
  await mkdir(testRoot, { recursive: true });
});

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

describe("conversation API", () => {
  it("requires a bearer token", async () => {
    const harness = createHarness();
    const response = await harness.app.request(
      `/v1/profiles/${profileId}/conversations`,
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("Content-Type")).toBe("application/problem+json");
  });

  it("creates a conversation with an empty body or a title", async () => {
    const harness = createHarness();

    const empty = await createConversation(harness.app);
    const titled = await createConversation(harness.app, "Rencana kontak");

    expect(empty.title).toBeNull();
    expect(titled.title).toBe("Rencana kontak");
    expect(empty.id).toMatch(/^cv_[0-9a-f]{16}$/);
    expect(empty.profileId).toBe(profileId);
    expect(empty.updatedAt.endsWith("Z")).toBe(true);
  });

  it("rejects an invalid conversation body and missing profile", async () => {
    const harness = createHarness();
    const invalid = await harness.app.request(
      `/v1/profiles/${profileId}/conversations`,
      withAuth({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "x".repeat(81) }),
      }),
    );
    const missing = await harness.app.request(
      `/v1/profiles/${missingProfileId}/conversations`,
      withAuth({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );

    expect(invalid.status).toBe(400);
    expect(missing.status).toBe(404);
    expect((await json<Problem>(missing)).detail).toBe("Profil tidak ditemukan.");
  });

  it("lists conversations by updatedAt descending with pagination", async () => {
    const harness = createHarness();
    const first = await createConversation(harness.app, "Pertama");
    const second = await createConversation(harness.app, "Kedua");

    const older = new Date("2026-10-28T04:00:00.000Z");
    const newer = new Date("2026-10-28T05:00:00.000Z");
    await utimes(harness.messagesFile(first.id), older, older);
    await utimes(harness.messagesFile(second.id), newer, newer);

    const response = await harness.app.request(
      `/v1/profiles/${profileId}/conversations?page=1&page_size=1`,
      withAuth(),
    );
    const body = await json<{
      data: Conversation[];
      total: number;
      page: number;
      page_size: number;
    }>(response);

    expect(response.status).toBe(200);
    expect(body.total).toBe(2);
    expect(body.page).toBe(1);
    expect(body.page_size).toBe(1);
    expect(body.data.map((conversation) => conversation.id)).toEqual([second.id]);

    const invalid = await harness.app.request(
      `/v1/profiles/${profileId}/conversations?page_size=101`,
      withAuth(),
    );
    expect(invalid.status).toBe(400);
    expect((await json<Problem>(invalid)).detail).toBe(
      "Parameter pagination tidak valid.",
    );

    const missing = await harness.app.request(
      `/v1/profiles/${missingProfileId}/conversations`,
      withAuth(),
    );
    expect(missing.status).toBe(404);
    expect((await json<Problem>(missing)).detail).toBe("Profil tidak ditemukan.");
  });

  it("lists messages newest first with pagination", async () => {
    const harness = createHarness();
    const conversation = await createConversation(harness.app);

    await harness.app.request(
      `/v1/profiles/${profileId}/conversations/${conversation.id}/messages`,
      sendRequest("Pesan pertama", "key-1"),
    );
    await harness.app.request(
      `/v1/profiles/${profileId}/conversations/${conversation.id}/messages`,
      sendRequest("Pesan kedua", "key-2"),
    );

    const response = await harness.app.request(
      `/v1/profiles/${profileId}/conversations/${conversation.id}/messages`,
      withAuth(),
    );
    const body = await json<{
      data: { text: string }[];
      total: number;
      page: number;
      page_size: number;
    }>(response);

    expect(response.status).toBe(200);
    expect(body.total).toBe(2);
    expect(body.data.map((message) => message.text)).toEqual([
      "Pesan kedua",
      "Pesan pertama",
    ]);

    const paged = await harness.app.request(
      `/v1/profiles/${profileId}/conversations/${conversation.id}/messages?page=2&page_size=1`,
      withAuth(),
    );
    expect((await json<{ data: { text: string }[] }>(paged)).data.map((message) => message.text)).toEqual(
      ["Pesan pertama"],
    );
  });

  it("returns 404 for an unknown conversation or another profile", async () => {
    const harness = createHarness();
    const conversation = await createConversation(harness.app);

    const unknown = await harness.app.request(
      `/v1/profiles/${profileId}/conversations/cv_00000000000000ff/messages`,
      withAuth(),
    );
    const other = await harness.app.request(
      `/v1/profiles/${otherProfileId}/conversations/${conversation.id}/messages`,
      withAuth(),
    );

    expect(unknown.status).toBe(404);
    expect(other.status).toBe(404);
    expect((await json<Problem>(unknown)).detail).toBe("Percakapan tidak ditemukan.");
  });

  it("rejects invalid ids, pagination, and bodies", async () => {
    const harness = createHarness();
    const conversation = await createConversation(harness.app);

    const invalidProfile = await harness.app.request(
      "/v1/profiles/not-a-profile/conversations",
      withAuth(),
    );
    const invalidConversation = await harness.app.request(
      `/v1/profiles/${profileId}/conversations/not-a-conversation/messages`,
      withAuth(),
    );
    const invalidPagination = await harness.app.request(
      `/v1/profiles/${profileId}/conversations/${conversation.id}/messages?page=0`,
      withAuth(),
    );
    const invalidBody = await harness.app.request(
      `/v1/profiles/${profileId}/conversations/${conversation.id}/messages`,
      sendRequest("", "key-body"),
    );

    expect(invalidProfile.status).toBe(400);
    expect(invalidConversation.status).toBe(400);
    expect(invalidPagination.status).toBe(400);
    expect(invalidBody.status).toBe(400);
    expect((await json<Problem>(invalidConversation)).detail).toBe(
      "Id percakapan tidak valid.",
    );
    expect((await json<Problem>(invalidBody)).detail).toBe(
      "Body permintaan tidak valid.",
    );
  });

  it("requires an Idempotency-Key header for sending", async () => {
    const harness = createHarness();
    const conversation = await createConversation(harness.app);

    const missing = await harness.app.request(
      `/v1/profiles/${profileId}/conversations/${conversation.id}/messages`,
      sendRequest("Halo"),
    );
    const blank = await harness.app.request(
      `/v1/profiles/${profileId}/conversations/${conversation.id}/messages`,
      sendRequest("Halo", "  ".repeat(2)),
    );

    expect(missing.status).toBe(400);
    expect(blank.status).toBe(400);
    expect((await json<Problem>(missing)).detail).toBe("Idempotency-Key wajib diisi.");
  });

  it("sends a message and returns the conversation, message, and task", async () => {
    const harness = createHarness();
    const conversation = await createConversation(harness.app);

    const response = await harness.app.request(
      `/v1/profiles/${profileId}/conversations/${conversation.id}/messages`,
      sendRequest("Cari kontak divisi penjualan", "key-send"),
    );
    const body = await json<{
      data: {
        conversation: Conversation;
        message: { role: string; text: string; taskId: string };
        task: { id: string; conversationId: string; goal: string; status: string };
      };
    }>(response);

    expect(response.status).toBe(202);
    expect(body.data.message.role).toBe("operator");
    expect(body.data.message.text).toBe("Cari kontak divisi penjualan");
    expect(body.data.task.status).toBe("queued");
    expect(body.data.task.conversationId).toBe(conversation.id);
    expect(body.data.message.taskId).toBe(body.data.task.id);
    expect(body.data.conversation.title).toBe("Cari kontak divisi penjualan");
    expect(harness.tasks.getTask(body.data.task.id)?.conversationId).toBe(
      conversation.id,
    );
  });

  it("rejects a conversation at the message cap with 409", async () => {
    const harness = createHarness();
    const conversation = await createConversation(harness.app);
    const lines: string[] = [];
    for (let index = 0; index < 1_999; index += 1) {
      lines.push(
        JSON.stringify({
          id: `m_${index.toString(16).padStart(16, "0")}`,
          conversationId: conversation.id,
          role: "operator",
          text: `pesan ${index}`,
          taskId: null,
          createdAt: fixedNow,
        }),
      );
    }
    await writeFile(harness.messagesFile(conversation.id), `${lines.join("\n")}\n`, {
      mode: 0o600,
    });

    const response = await harness.app.request(
      `/v1/profiles/${profileId}/conversations/${conversation.id}/messages`,
      sendRequest("Melewati batas", "key-full"),
    );

    expect(response.status).toBe(409);
    expect((await json<Problem>(response)).detail).toBe(
      "Percakapan sudah mencapai batas 2.000 pesan. Buat percakapan baru.",
    );
  });

  it("maps save failures and session failures to problem responses", async () => {
    const saveFailure: ConversationServiceApi = {
      list: async () => [],
      create: async () => {
        throw new ConversationError("conversation_save_failed");
      },
      listMessages: async () => [],
      sendMessage: async () => {
        throw new ConversationError("conversation_save_failed");
      },
      invalidateProfile: () => undefined,
    };
    const saveHarness = createHarness({ conversations: saveFailure });
    const saveConversation: Conversation = {
      id: "cv_0000000000000001",
      profileId,
      title: null,
      createdAt: fixedNow,
      updatedAt: fixedNow,
    };
    const saveResponse = await saveHarness.app.request(
      `/v1/profiles/${profileId}/conversations/${saveConversation.id}/messages`,
      sendRequest("Halo", "key-save"),
    );

    expect(saveResponse.status).toBe(500);
    expect(saveResponse.headers.get("Content-Type")).toBe("application/problem+json");
    expect((await json<Problem>(saveResponse)).detail).toBe("Pesan gagal disimpan.");

    const sessionFailure: ConversationServiceApi = {
      ...saveFailure,
      create: async () => saveConversation,
      sendMessage: async () => {
        throw new ConversationError("conversation_session_not_ready");
      },
    };
    const sessionHarness = createHarness({ conversations: sessionFailure });
    const sessionResponse = await sessionHarness.app.request(
      `/v1/profiles/${profileId}/conversations/${saveConversation.id}/messages`,
      sendRequest("Halo", "key-session"),
    );

    expect(sessionResponse.status).toBe(409);
    expect((await json<Problem>(sessionResponse)).detail).toBe(
      "Sesi browser belum siap menerima pesan.",
    );
  });
});
