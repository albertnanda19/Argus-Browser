import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { messageSchema } from "../shared/conversation";
import { createConversationStore, type ConversationStore } from "./conversation-store";

const testRoot = resolve(
  process.cwd(),
  "..",
  "tmp",
  "testing",
  `conversation-store-${randomBytes(4).toString("hex")}`,
);

const profileId = "p_0000000000000001";
const otherProfileId = "p_0000000000000002";

let appDataSequence = 0;

function newAppDataDir(): string {
  appDataSequence += 1;
  return join(testRoot, `appdata-${appDataSequence}`);
}

function createStore(appDataDir: string, now?: () => Date): ConversationStore {
  return createConversationStore({ appDataDir, now });
}

function conversationDir(appDataDir: string, id: string, owner = profileId): string {
  return join(appDataDir, "profiles", owner, "conversations", id);
}

function messagesFile(appDataDir: string, id: string, owner = profileId): string {
  return join(conversationDir(appDataDir, id, owner), "messages.jsonl");
}

async function seedMessage(
  appDataDir: string,
  conversationId: string,
  taskId: string,
  role: "operator" | "agent",
  text: string,
  createdAt: string,
  owner = profileId,
): Promise<void> {
  const id = `m_${randomBytes(8).toString("hex")}`;
  await appendFile(
    messagesFile(appDataDir, conversationId, owner),
    `${JSON.stringify(
      messageSchema.parse({ id, conversationId, role, text, taskId, createdAt }),
    )}\n`,
  );
}

beforeAll(async () => {
  await mkdir(testRoot, { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

describe("conversation store", () => {
  it("creates metadata and an empty message log with restrictive modes", async () => {
    const appDataDir = newAppDataDir();
    const store = createStore(appDataDir);

    const conversation = await store.create(profileId, "Rencana mingguan");

    expect(conversation.id).toMatch(/^cv_[0-9a-f]{16}$/);
    expect(conversation.title).toBe("Rencana mingguan");
    expect(conversation.createdAt.endsWith("Z")).toBe(true);
    expect(conversation.updatedAt.endsWith("Z")).toBe(true);

    const dir = conversationDir(appDataDir, conversation.id);
    expect((await stat(join(appDataDir, "profiles", profileId, "conversations"))).mode & 0o777).toBe(
      0o700,
    );
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, "conversation.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "messages.jsonl"))).mode & 0o777).toBe(0o600);
    expect((await readFile(join(dir, "messages.jsonl"), "utf8"))).toBe("");

    const stored: unknown = JSON.parse(await readFile(join(dir, "conversation.json"), "utf8"));
    expect(stored).toEqual({
      id: conversation.id,
      profileId,
      title: "Rencana mingguan",
      createdAt: conversation.createdAt,
    });
  });

  it("appends messages in order and separates a missing trailing newline", async () => {
    const appDataDir = newAppDataDir();
    const store = createStore(appDataDir);
    const conversation = await store.create(profileId, null);

    await seedMessage(
      appDataDir,
      conversation.id,
      "t_0000000000000001",
      "operator",
      "Pesan pertama",
      "2026-10-28T01:00:00.000Z",
    );

    const file = messagesFile(appDataDir, conversation.id);
    const contents = await readFile(file, "utf8");
    await writeFile(file, contents.trimEnd(), { mode: 0o600 });

    const second = await store.appendOperatorMessage(
      profileId,
      conversation.id,
      "Pesan kedua",
      "t_0000000000000002",
    );

    expect(second.id).toMatch(/^m_[0-9a-f]{16}$/);
    expect(second.role).toBe("operator");
    expect(second.taskId).toBe("t_0000000000000002");
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    const messages = await store.listMessages(profileId, conversation.id);
    expect(messages.map((message) => message.text)).toEqual([
      "Pesan pertama",
      "Pesan kedua",
    ]);
    expect((await readFile(file, "utf8")).split("\n").filter(Boolean)).toHaveLength(2);
  });

  it("skips invalid lines but keeps valid messages", async () => {
    const appDataDir = newAppDataDir();
    const store = createStore(appDataDir);
    const conversation = await store.create(profileId, null);

    await seedMessage(
      appDataDir,
      conversation.id,
      "t_0000000000000001",
      "operator",
      "Pesan valid",
      "2026-10-28T01:00:00.000Z",
    );
    await appendFile(messagesFile(appDataDir, conversation.id), "{not json}\n");
    await appendFile(messagesFile(appDataDir, conversation.id), '{"id":"m_broken"}\n');

    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const messages = await store.listMessages(profileId, conversation.id);

    expect(messages.map((message) => message.text)).toEqual(["Pesan valid"]);
    expect(warning).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warning.mock.calls)).not.toContain("Pesan valid");
  });

  it("skips conversations with invalid metadata and keeps the file intact", async () => {
    const appDataDir = newAppDataDir();
    const store = createStore(appDataDir);
    const valid = await store.create(profileId, "Valid");
    const broken = await store.create(profileId, "Rusak");

    await writeFile(join(conversationDir(appDataDir, broken.id), "conversation.json"), "{", {
      mode: 0o600,
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const conversations = await store.list(profileId);

    expect(conversations.map((conversation) => conversation.id)).toEqual([valid.id]);
    expect(await readFile(join(conversationDir(appDataDir, broken.id), "conversation.json"), "utf8")).toBe(
      "{",
    );
  });

  it("treats a missing message log as empty and falls back to createdAt", async () => {
    const appDataDir = newAppDataDir();
    const store = createStore(appDataDir);
    const conversation = await store.create(profileId, null);

    await rm(messagesFile(appDataDir, conversation.id));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(await store.listMessages(profileId, conversation.id)).toEqual([]);
    expect(warning).toHaveBeenCalledTimes(1);

    const [listed] = await store.list(profileId);
    expect(listed?.updatedAt).toBe(conversation.createdAt);
  });

  it("updates updatedAt from the message log mtime and sorts by it", async () => {
    const appDataDir = newAppDataDir();
    const store = createStore(appDataDir);
    const first = await store.create(profileId, "Pertama");
    const second = await store.create(profileId, "Kedua");

    const newer = new Date("2026-10-28T05:00:00.000Z");
    const older = new Date("2026-10-28T04:00:00.000Z");
    await utimes(messagesFile(appDataDir, first.id), older, older);
    await utimes(messagesFile(appDataDir, second.id), newer, newer);

    const conversations = await store.list(profileId);

    expect(conversations.map((conversation) => conversation.id)).toEqual([
      second.id,
      first.id,
    ]);
    expect(conversations[0]?.updatedAt).toBe(newer.toISOString());
    expect(conversations[1]?.updatedAt).toBe(older.toISOString());
  });

  it("breaks updatedAt ties by id ascending", async () => {
    const appDataDir = newAppDataDir();
    const store = createStore(appDataDir);
    const first = await store.create(profileId, null);
    const second = await store.create(profileId, null);

    const same = new Date("2026-10-28T05:00:00.000Z");
    await utimes(messagesFile(appDataDir, first.id), same, same);
    await utimes(messagesFile(appDataDir, second.id), same, same);

    const ids = (await store.list(profileId)).map((conversation) => conversation.id);
    expect(ids).toEqual([first.id, second.id].sort());
  });

  it("writes titles atomically without leaving temporary files", async () => {
    const appDataDir = newAppDataDir();
    const store = createStore(appDataDir);
    const conversation = await store.create(profileId, null);

    const updated = await store.setTitle(profileId, conversation.id, "Judul baru");

    expect(updated.title).toBe("Judul baru");
    expect((await store.get(profileId, conversation.id))?.title).toBe("Judul baru");
    expect((await readdir(conversationDir(appDataDir, conversation.id))).sort()).toEqual([
      "conversation.json",
      "messages.jsonl",
    ]);
    expect((await store.list(profileId))[0]?.title).toBe("Judul baru");
  });

  it("isolates conversations per profile", async () => {
    const appDataDir = newAppDataDir();
    const store = createStore(appDataDir);
    const first = await store.create(profileId, "Satu");
    await store.create(otherProfileId, "Dua");

    expect((await store.list(profileId)).map((conversation) => conversation.id)).toEqual([
      first.id,
    ]);
    expect(await store.get(otherProfileId, first.id)).toBeNull();
    expect(await store.listMessages(otherProfileId, first.id)).toEqual([]);
  });

  it("returns recent operator messages excluding the current task", async () => {
    const appDataDir = newAppDataDir();
    const store = createStore(appDataDir);
    const conversation = await store.create(profileId, null);

    await seedMessage(
      appDataDir,
      conversation.id,
      "t_0000000000000001",
      "operator",
      "satu",
      "2026-10-28T01:00:00.000Z",
    );
    await seedMessage(
      appDataDir,
      conversation.id,
      "t_0000000000000001",
      "agent",
      "balasan",
      "2026-10-28T01:01:00.000Z",
    );
    await seedMessage(
      appDataDir,
      conversation.id,
      "t_0000000000000002",
      "operator",
      "dua",
      "2026-10-28T01:02:00.000Z",
    );
    await seedMessage(
      appDataDir,
      conversation.id,
      "t_0000000000000003",
      "operator",
      "tiga",
      "2026-10-28T01:03:00.000Z",
    );
    await seedMessage(
      appDataDir,
      conversation.id,
      "t_0000000000000004",
      "operator",
      "empat",
      "2026-10-28T01:04:00.000Z",
    );

    const recent = await store.listRecentOperatorMessages(
      conversation.id,
      "t_0000000000000004",
      3,
    );

    expect(recent.map((message) => message.text)).toEqual(["satu", "dua", "tiga"]);
  });

  it("appends one agent reply per task", async () => {
    const appDataDir = newAppDataDir();
    const store = createStore(appDataDir);
    const conversation = await store.create(profileId, null);

    const first = await store.appendAgentMessage(
      conversation.id,
      "Tugas selesai.",
      "t_0000000000000001",
    );
    const duplicate = await store.appendAgentMessage(
      conversation.id,
      "Tugas selesai.",
      "t_0000000000000001",
    );

    expect(first?.role).toBe("agent");
    expect(duplicate).toBeNull();
    expect(await store.hasAgentMessage(conversation.id, "t_0000000000000001")).toBe(true);
    expect(await store.listMessages(profileId, conversation.id)).toHaveLength(1);
  });

  it("finds messages after a service restart", async () => {
    const appDataDir = newAppDataDir();
    const conversation = await createStore(appDataDir).create(profileId, "Persisten");
    await createStore(appDataDir).appendOperatorMessage(
      profileId,
      conversation.id,
      "Tetap ada",
      "t_0000000000000001",
    );

    const restarted = createStore(appDataDir);
    const messages = await restarted.listMessages(profileId, conversation.id);

    expect(messages.map((message) => message.text)).toEqual(["Tetap ada"]);
    expect((await restarted.list(profileId))[0]?.updatedAt.endsWith("Z")).toBe(true);
  });

  it("rejects a message beyond the conversation cap", async () => {
    const appDataDir = newAppDataDir();
    const store = createStore(appDataDir);
    const conversation = await store.create(profileId, null);

    const lines: string[] = [];
    for (let index = 0; index < 2_000; index += 1) {
      lines.push(
        JSON.stringify(
          messageSchema.parse({
            id: `m_${index.toString(16).padStart(16, "0")}`,
            conversationId: conversation.id,
            role: index % 2 === 0 ? "operator" : "agent",
            text: `pesan ${index}`,
            taskId: null,
            createdAt: "2026-10-28T01:00:00.000Z",
          }),
        ),
      );
    }
    await writeFile(messagesFile(appDataDir, conversation.id), `${lines.join("\n")}\n`, {
      mode: 0o600,
    });

    await expect(
      store.appendOperatorMessage(
        profileId,
        conversation.id,
        "melewati batas",
        "t_0000000000000001",
      ),
    ).rejects.toMatchObject({ code: "conversation_full" });

    expect(await store.countMessages(profileId, conversation.id)).toBe(2_000);
  });
});
