import { randomBytes } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  appendFile,
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { z } from "zod";
import {
  MAX_CONVERSATION_MESSAGES,
  conversationSchema,
  conversationTitleSchema,
  messageSchema,
  type Conversation,
  type Message,
} from "../shared/conversation";
import { profileIdSchema } from "../shared/profile";
import { conversationIdSchema } from "../shared/task";
import { ConversationError } from "./conversation-errors";
import { createProfileLock } from "./profile-lock";

const PROFILES_DIR = "profiles";
const CONVERSATIONS_DIR = "conversations";
const METADATA_FILE = "conversation.json";
const MESSAGES_FILE = "messages.jsonl";

const conversationMetadataSchema = z.strictObject({
  id: conversationIdSchema,
  profileId: profileIdSchema,
  title: conversationTitleSchema.nullable(),
  createdAt: z.iso.datetime({ offset: false }),
});

type ConversationMetadata = z.infer<typeof conversationMetadataSchema>;

export type ConversationStore = {
  list(profileId: string): Promise<Conversation[]>;
  create(profileId: string, title: string | null): Promise<Conversation>;
  get(profileId: string, conversationId: string): Promise<Conversation | null>;
  setTitle(profileId: string, conversationId: string, title: string): Promise<Conversation>;
  listMessages(profileId: string, conversationId: string): Promise<Message[]>;
  countMessages(profileId: string, conversationId: string): Promise<number>;
  appendOperatorMessage(
    profileId: string,
    conversationId: string,
    text: string,
    taskId: string,
  ): Promise<Message>;
  appendAgentMessage(
    conversationId: string,
    text: string,
    taskId: string,
  ): Promise<Message | null>;
  hasAgentMessage(conversationId: string, taskId: string): Promise<boolean>;
  listRecentOperatorMessages(
    conversationId: string,
    excludeTaskId: string,
    limit: number,
  ): Promise<Message[]>;
  invalidateProfile(profileId: string): void;
};

export type ConversationStoreOptions = {
  readonly appDataDir: string;
  readonly now?: () => Date;
};

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function createConversationId(): string {
  return `cv_${randomBytes(8).toString("hex")}`;
}

function createMessageId(): string {
  return `m_${randomBytes(8).toString("hex")}`;
}

function conversationsRoot(appDataDir: string, profileId: string): string {
  const profilesRoot = resolve(appDataDir, PROFILES_DIR);
  const profileDir = resolve(profilesRoot, profileId);
  if (!profileDir.startsWith(`${profilesRoot}${sep}`)) {
    throw new ConversationError("conversation_profile_not_found");
  }
  return join(profileDir, CONVERSATIONS_DIR);
}

function conversationDir(
  appDataDir: string,
  profileId: string,
  conversationId: string,
): string {
  const root = conversationsRoot(appDataDir, profileId);
  const dir = resolve(root, conversationId);
  if (!dir.startsWith(`${root}${sep}`)) {
    throw new ConversationError("conversation_not_found");
  }
  return dir;
}

class ConversationStoreImpl implements ConversationStore {
  private readonly appDataDir: string;
  private readonly now: () => Date;
  private readonly indexes = new Map<string, ConversationMetadata[]>();
  private readonly conversationProfiles = new Map<string, string>();
  private readonly writeQueue = createProfileLock();

  constructor(options: ConversationStoreOptions) {
    this.appDataDir = options.appDataDir;
    this.now = options.now ?? (() => new Date());
  }

  async list(profileId: string): Promise<Conversation[]> {
    const entries = await this.loadIndex(profileId);
    const conversations = await Promise.all(
      entries.map((entry) => this.toConversation(entry)),
    );

    return conversations.sort((left, right) => {
      const updatedOrder = right.updatedAt.localeCompare(left.updatedAt);
      return updatedOrder !== 0 ? updatedOrder : left.id.localeCompare(right.id);
    });
  }

  async create(profileId: string, title: string | null): Promise<Conversation> {
    const parsedTitle = conversationTitleSchema.nullable().parse(title);
    const id = createConversationId();
    const root = conversationsRoot(this.appDataDir, profileId);
    const dir = conversationDir(this.appDataDir, profileId, id);

    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    await mkdir(dir, { mode: 0o700 });
    await chmod(dir, 0o700);

    const metadata = conversationMetadataSchema.parse({
      id,
      profileId,
      title: parsedTitle,
      createdAt: this.now().toISOString(),
    });

    try {
      await this.writeMetadata(dir, metadata);
      const messagesFile = join(dir, MESSAGES_FILE);
      await writeFile(messagesFile, "", { mode: 0o600, flag: "wx" });
      await chmod(messagesFile, 0o600);
    } catch (error) {
      await rm(dir, { recursive: true, force: true }).catch(() => {
        console.warn(`Failed to remove conversation directory after create failure: ${id}`);
      });
      throw error;
    }

    this.indexes.delete(profileId);
    this.conversationProfiles.set(id, profileId);
    return this.toConversation(metadata);
  }

  async get(profileId: string, conversationId: string): Promise<Conversation | null> {
    const metadata = await this.readMetadata(
      conversationDir(this.appDataDir, profileId, conversationId),
      conversationId,
    );

    if (metadata === null || metadata.profileId !== profileId) {
      return null;
    }

    this.conversationProfiles.set(conversationId, profileId);
    return this.toConversation(metadata);
  }

  async setTitle(
    profileId: string,
    conversationId: string,
    title: string,
  ): Promise<Conversation> {
    const dir = conversationDir(this.appDataDir, profileId, conversationId);
    const metadata = await this.readMetadata(dir, conversationId);
    if (metadata === null || metadata.profileId !== profileId) {
      throw new ConversationError("conversation_not_found");
    }

    const updated = conversationMetadataSchema.parse({
      ...metadata,
      title: conversationTitleSchema.parse(title),
    });
    await this.writeMetadata(dir, updated);
    this.indexes.delete(profileId);
    return this.toConversation(updated);
  }

  async listMessages(profileId: string, conversationId: string): Promise<Message[]> {
    return await this.readMessages(
      conversationDir(this.appDataDir, profileId, conversationId),
      conversationId,
    );
  }

  async countMessages(profileId: string, conversationId: string): Promise<number> {
    const messages = await this.listMessages(profileId, conversationId);
    return messages.length;
  }

  async appendOperatorMessage(
    profileId: string,
    conversationId: string,
    text: string,
    taskId: string,
  ): Promise<Message> {
    return await this.writeQueue.run(`${profileId}:${conversationId}`, async () =>
      this.appendMessage(profileId, conversationId, "operator", text, taskId),
    );
  }

  async appendAgentMessage(
    conversationId: string,
    text: string,
    taskId: string,
  ): Promise<Message | null> {
    const profileId = await this.resolveProfileId(conversationId);
    if (profileId === null) {
      throw new ConversationError("conversation_not_found");
    }

    return await this.writeQueue.run(`${profileId}:${conversationId}`, async () => {
      const dir = conversationDir(this.appDataDir, profileId, conversationId);
      const messages = await this.readMessages(dir, conversationId);
      const existing = messages.find(
        (message) => message.role === "agent" && message.taskId === taskId,
      );
      if (existing !== undefined) {
        return null;
      }
      if (messages.length >= MAX_CONVERSATION_MESSAGES) {
        throw new ConversationError("conversation_full");
      }
      return await this.appendMessage(
        profileId,
        conversationId,
        "agent",
        text,
        taskId,
        messages.length,
      );
    });
  }

  async hasAgentMessage(conversationId: string, taskId: string): Promise<boolean> {
    const profileId = await this.resolveProfileId(conversationId);
    if (profileId === null) {
      return false;
    }
    const messages = await this.listMessages(profileId, conversationId);
    return messages.some(
      (message) => message.role === "agent" && message.taskId === taskId,
    );
  }

  async listRecentOperatorMessages(
    conversationId: string,
    excludeTaskId: string,
    limit: number,
  ): Promise<Message[]> {
    const profileId = await this.resolveProfileId(conversationId);
    if (profileId === null) {
      return [];
    }

    const messages = await this.listMessages(profileId, conversationId);
    const operatorMessages = messages.filter(
      (message) => message.role === "operator" && message.taskId !== excludeTaskId,
    );
    return operatorMessages.slice(-limit);
  }

  invalidateProfile(profileId: string): void {
    this.indexes.delete(profileId);
  }

  private async appendMessage(
    profileId: string,
    conversationId: string,
    role: Message["role"],
    text: string,
    taskId: string,
    knownCount?: number,
  ): Promise<Message> {
    const dir = conversationDir(this.appDataDir, profileId, conversationId);
    const metadata = await this.readMetadata(dir, conversationId);
    if (metadata === null || metadata.profileId !== profileId) {
      throw new ConversationError("conversation_not_found");
    }

    const count =
      knownCount ?? (await this.readMessages(dir, conversationId)).length;
    if (count >= MAX_CONVERSATION_MESSAGES) {
      throw new ConversationError("conversation_full");
    }

    const message = messageSchema.parse({
      id: createMessageId(),
      conversationId,
      role,
      text,
      taskId,
      createdAt: this.now().toISOString(),
    });

    await this.appendJsonLine(join(dir, MESSAGES_FILE), message);
    return message;
  }

  private async appendJsonLine(file: string, message: Message): Promise<void> {
    let needsNewline = false;

    try {
      const handle = await open(file, "r");
      try {
        const info = await handle.stat();
        if (info.size > 0) {
          const buffer = Buffer.alloc(1);
          await handle.read(buffer, 0, 1, info.size - 1);
          needsNewline = buffer[0] !== 0x0a;
        }
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
      await writeFile(file, "", { mode: 0o600 });
    }

    const line = `${needsNewline ? "\n" : ""}${JSON.stringify(message)}\n`;
    await appendFile(file, line, { mode: 0o600 });
    await chmod(file, 0o600);
  }

  private async loadIndex(profileId: string): Promise<ConversationMetadata[]> {
    const cached = this.indexes.get(profileId);
    if (cached !== undefined) {
      return cached;
    }

    const root = conversationsRoot(this.appDataDir, profileId);
    let entries: Dirent[];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) {
        this.indexes.set(profileId, []);
        return [];
      }
      throw error;
    }

    const conversations: ConversationMetadata[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !conversationIdSchema.safeParse(entry.name).success) {
        continue;
      }

      const metadata = await this.readMetadata(join(root, entry.name), entry.name);
      if (metadata === null || metadata.profileId !== profileId) {
        console.warn(`Skipping conversation with invalid metadata: ${entry.name}`);
        continue;
      }

      conversations.push(metadata);
      this.conversationProfiles.set(entry.name, profileId);
    }

    this.indexes.set(profileId, conversations);
    return conversations;
  }

  private async toConversation(metadata: ConversationMetadata): Promise<Conversation> {
    const dir = conversationDir(this.appDataDir, metadata.profileId, metadata.id);
    let updatedAt = metadata.createdAt;

    try {
      updatedAt = (await stat(join(dir, MESSAGES_FILE))).mtime.toISOString();
    } catch (error) {
      if (!isMissing(error)) {
        console.warn(`Conversation messages stat failed: ${metadata.id}`);
      }
    }

    return conversationSchema.parse({ ...metadata, updatedAt });
  }

  private async readMetadata(
    dir: string,
    conversationId: string,
  ): Promise<ConversationMetadata | null> {
    let contents: string;
    try {
      contents = await readFile(join(dir, METADATA_FILE), "utf8");
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    }

    let value: unknown;
    try {
      value = JSON.parse(contents);
    } catch {
      return null;
    }

    const parsed = conversationMetadataSchema.safeParse(value);
    if (!parsed.success || parsed.data.id !== conversationId) {
      return null;
    }

    return parsed.data;
  }

  private async writeMetadata(
    dir: string,
    metadata: ConversationMetadata,
  ): Promise<void> {
    const file = join(dir, METADATA_FILE);
    const tempFile = join(
      dir,
      `.${METADATA_FILE}-${randomBytes(4).toString("hex")}.tmp`,
    );
    const contents = JSON.stringify(conversationMetadataSchema.parse(metadata));

    try {
      await writeFile(tempFile, contents, { mode: 0o600 });
      await chmod(tempFile, 0o600);
      await rename(tempFile, file);
    } catch (error) {
      await rm(tempFile, { force: true }).catch(() => {
        console.warn(`Failed to remove temporary conversation metadata: ${metadata.id}`);
      });
      throw error;
    }
  }

  private async readMessages(dir: string, conversationId: string): Promise<Message[]> {
    let contents: string;
    try {
      contents = await readFile(join(dir, MESSAGES_FILE), "utf8");
    } catch (error) {
      if (isMissing(error)) {
        console.warn(`Conversation messages file missing: ${conversationId}`);
        return [];
      }
      throw error;
    }

    const messages: Message[] = [];
    const lines = contents.split("\n");

    for (const [index, line] of lines.entries()) {
      if (line.trim().length === 0) {
        continue;
      }

      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        console.warn(
          `Skipping invalid conversation message: ${conversationId} line ${index + 1}`,
        );
        continue;
      }

      const parsed = messageSchema.safeParse(value);
      if (!parsed.success || parsed.data.conversationId !== conversationId) {
        console.warn(
          `Skipping invalid conversation message: ${conversationId} line ${index + 1}`,
        );
        continue;
      }

      messages.push(parsed.data);
    }

    return messages;
  }

  private async resolveProfileId(conversationId: string): Promise<string | null> {
    if (!conversationIdSchema.safeParse(conversationId).success) {
      return null;
    }

    const cached = this.conversationProfiles.get(conversationId);
    if (cached !== undefined) {
      return cached;
    }

    let profiles: Dirent[];
    try {
      profiles = await readdir(resolve(this.appDataDir, PROFILES_DIR), {
        withFileTypes: true,
      });
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    }

    for (const profile of profiles) {
      if (!profile.isDirectory() || !profileIdSchema.safeParse(profile.name).success) {
        continue;
      }

      const dir = join(conversationsRoot(this.appDataDir, profile.name), conversationId);
      const metadata = await this.readMetadata(dir, conversationId);
      if (metadata !== null && metadata.profileId === profile.name) {
        this.conversationProfiles.set(conversationId, profile.name);
        return profile.name;
      }
    }

    return null;
  }
}

export function createConversationStore(
  options: ConversationStoreOptions,
): ConversationStore {
  return new ConversationStoreImpl(options);
}
