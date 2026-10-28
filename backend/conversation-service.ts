import { createHash } from "node:crypto";
import type {
  Conversation,
  Message,
} from "../shared/conversation";
import { MAX_CONVERSATION_MESSAGES } from "../shared/conversation";
import type { TaskCompletedEvent, TaskFailedEvent, TaskCancelledEvent } from "../shared/event";
import type { Session } from "../shared/session";
import type { TaskEntity } from "../shared/task";
import { ConversationError } from "./conversation-errors";
import type { ConversationStore } from "./conversation-store";
import type { EventBus, StoredEvent } from "./event-bus";
import { createProfileLock } from "./profile-lock";
import { ProfileStoreError } from "./profile-store";
import { SessionError } from "./session-errors";
import { TaskError } from "./task-errors";
import type { TaskService } from "./task-manager";

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_SESSION_READY_TIMEOUT_MS = 30_000;
const DEFAULT_SESSION_POLL_INTERVAL_MS = 100;
const AGENT_REPLY_MAX_LENGTH = 600;
const TITLE_MAX_LENGTH = 60;

type TerminalEvent = TaskCompletedEvent | TaskFailedEvent | TaskCancelledEvent;

export type ConversationProfileSource = {
  get(profileId: string): Promise<unknown>;
};

export type ConversationSessionSource = {
  listActive(): Session[];
  start(profileId: string): Promise<Session>;
};

export type ConversationRunnerSource = {
  start(taskId: string): void;
};

export type SendConversationMessageResult = {
  readonly conversation: Conversation;
  readonly message: Message;
  readonly task: TaskEntity;
};

export type CreateConversationInput = {
  readonly title?: string;
};

export type ConversationServiceOptions = {
  readonly store: ConversationStore;
  readonly profiles: ConversationProfileSource;
  readonly sessions: ConversationSessionSource;
  readonly tasks: TaskService;
  readonly runner: ConversationRunnerSource;
  readonly events: EventBus;
  readonly now?: () => Date;
  readonly idempotencyTtlMs?: number;
  readonly sessionReadyTimeoutMs?: number;
  readonly sessionPollIntervalMs?: number;
};

export type ConversationService = {
  list(profileId: string): Promise<Conversation[]>;
  create(profileId: string, input: CreateConversationInput): Promise<Conversation>;
  listMessages(profileId: string, conversationId: string): Promise<Message[]>;
  sendMessage(
    profileId: string,
    conversationId: string,
    text: string,
    idempotencyKey: string,
  ): Promise<SendConversationMessageResult>;
  invalidateProfile(profileId: string): void;
  shutdown(): void;
};

type IdempotencyEntry = {
  readonly fingerprint: string;
  readonly snapshot: SendConversationMessageResult;
  readonly createdAtMs: number;
};

export function titleFromOperatorMessage(text: string): string | null {
  const singleLine = text
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .trim();
  const title = singleLine.slice(0, TITLE_MAX_LENGTH).trim();
  return title.length === 0 ? null : title;
}

function replyText(event: TerminalEvent): string {
  switch (event.type) {
    case "task.completed": {
      const summary = event.result.summary;
      return typeof summary === "string" && summary.trim().length > 0
        ? summary
        : "Tugas selesai.";
    }
    case "task.failed":
      return event.reason.trim().length > 0 ? event.reason : "Tugas gagal.";
    case "task.cancelled":
      return event.reason.trim().length > 0 ? event.reason : "Tugas dibatalkan.";
  }
}

function isTerminalEvent(event: StoredEvent["event"]): event is TerminalEvent {
  return (
    event.type === "task.completed" ||
    event.type === "task.failed" ||
    event.type === "task.cancelled"
  );
}

class ConversationServiceImpl implements ConversationService {
  private readonly store: ConversationStore;
  private readonly profiles: ConversationProfileSource;
  private readonly sessions: ConversationSessionSource;
  private readonly tasks: TaskService;
  private readonly runner: ConversationRunnerSource;
  private readonly now: () => Date;
  private readonly idempotencyTtlMs: number;
  private readonly sessionReadyTimeoutMs: number;
  private readonly sessionPollIntervalMs: number;
  private readonly lock = createProfileLock();
  private readonly idempotency = new Map<string, IdempotencyEntry>();
  private readonly unsubscribe: () => void;

  constructor(options: ConversationServiceOptions) {
    this.store = options.store;
    this.profiles = options.profiles;
    this.sessions = options.sessions;
    this.tasks = options.tasks;
    this.runner = options.runner;
    this.now = options.now ?? (() => new Date());
    this.idempotencyTtlMs = options.idempotencyTtlMs ?? IDEMPOTENCY_TTL_MS;
    this.sessionReadyTimeoutMs =
      options.sessionReadyTimeoutMs ?? DEFAULT_SESSION_READY_TIMEOUT_MS;
    this.sessionPollIntervalMs =
      options.sessionPollIntervalMs ?? DEFAULT_SESSION_POLL_INTERVAL_MS;
    this.unsubscribe = options.events.subscribe((stored) => {
      if (!isTerminalEvent(stored.event)) {
        return;
      }
      void this.appendAgentReply(stored.event).catch((error: unknown) => {
        console.warn(
          `Conversation agent reply failed: ${stored.event.taskId}: ${
            error instanceof ConversationError
              ? error.code
              : error instanceof Error
                ? error.name
                : "unknown"
          }`,
        );
      });
    });
  }

  async list(profileId: string): Promise<Conversation[]> {
    await this.requireProfile(profileId);
    return await this.store.list(profileId);
  }

  async create(
    profileId: string,
    input: CreateConversationInput,
  ): Promise<Conversation> {
    await this.requireProfile(profileId);
    return await this.store.create(profileId, input.title ?? null);
  }

  async listMessages(
    profileId: string,
    conversationId: string,
  ): Promise<Message[]> {
    const conversation = await this.store.get(profileId, conversationId);
    if (conversation === null) {
      throw new ConversationError("conversation_not_found");
    }
    const messages = await this.store.listMessages(profileId, conversationId);
    return messages.slice().reverse();
  }

  async sendMessage(
    profileId: string,
    conversationId: string,
    text: string,
    idempotencyKey: string,
  ): Promise<SendConversationMessageResult> {
    await this.requireProfile(profileId);
    const conversation = await this.store.get(profileId, conversationId);
    if (conversation === null) {
      throw new ConversationError("conversation_not_found");
    }

    return await this.lock.run(`${profileId}:${conversationId}`, async () =>
      this.sendLocked(profileId, conversationId, text, idempotencyKey),
    );
  }

  invalidateProfile(profileId: string): void {
    this.store.invalidateProfile(profileId);
  }

  shutdown(): void {
    this.unsubscribe();
  }

  private async sendLocked(
    profileId: string,
    conversationId: string,
    text: string,
    idempotencyKey: string,
  ): Promise<SendConversationMessageResult> {
    const idempotencyId = `${conversationId}:${idempotencyKey}`;
    const fingerprint = `${conversationId}\u0000${text}`;
    const existing = this.idempotency.get(idempotencyId);

    if (existing !== undefined) {
      if (this.now().getTime() - existing.createdAtMs >= this.idempotencyTtlMs) {
        this.idempotency.delete(idempotencyId);
      } else if (existing.fingerprint !== fingerprint) {
        throw new ConversationError("conversation_idempotency_conflict");
      } else {
        return existing.snapshot;
      }
    }

    const count = await this.store.countMessages(profileId, conversationId);
    if (count + 2 > MAX_CONVERSATION_MESSAGES) {
      throw new ConversationError("conversation_full");
    }

    const session = await this.resolveSession(profileId);
    const conversation = await this.store.get(profileId, conversationId);
    if (conversation === null) {
      throw new ConversationError("conversation_not_found");
    }

    const derivedKey = createHash("sha256")
      .update(`conversation:${conversationId}:${idempotencyKey}`)
      .digest("hex");

    let task: TaskEntity;
    try {
      task = this.tasks.createTask(
        session.id,
        { goal: text },
        derivedKey,
        conversationId,
      );
    } catch (error) {
      if (error instanceof TaskError) {
        if (error.code === "task_idempotency_conflict") {
          throw new ConversationError("conversation_idempotency_conflict");
        }
        if (
          error.code === "task_session_not_found" ||
          error.code === "task_session_not_ready"
        ) {
          throw new ConversationError("conversation_session_not_ready");
        }
      }
      throw error;
    }

    let message: Message;
    try {
      message = await this.store.appendOperatorMessage(
        profileId,
        conversationId,
        text,
        task.id,
      );
    } catch (error) {
      console.warn(
        `Conversation operator message save failed: ${task.id}: ${
          error instanceof ConversationError
            ? error.code
            : error instanceof Error
              ? error.name
              : "unknown"
        }`,
      );
      throw new ConversationError("conversation_save_failed");
    }

    let currentConversation = conversation;
    if (currentConversation.title === null) {
      const title = titleFromOperatorMessage(text);
      if (title !== null) {
        try {
          currentConversation = await this.store.setTitle(
            profileId,
            conversationId,
            title,
          );
        } catch {
          console.warn(`Conversation title update failed: ${conversationId}`);
        }
      }
    }

    try {
      currentConversation =
        (await this.store.get(profileId, conversationId)) ?? currentConversation;
    } catch {
      console.warn(`Conversation refresh failed: ${conversationId}`);
    }

    const result: SendConversationMessageResult = {
      conversation: currentConversation,
      message,
      task,
    };
    this.idempotency.set(idempotencyId, {
      fingerprint,
      snapshot: result,
      createdAtMs: this.now().getTime(),
    });

    try {
      this.runner.start(task.id);
    } catch (error) {
      console.warn(
        `Conversation task start failed: ${task.id}: ${
          error instanceof Error ? error.name : "unknown"
        }`,
      );
    }

    return result;
  }

  private async requireProfile(profileId: string): Promise<void> {
    try {
      await this.profiles.get(profileId);
    } catch (error) {
      if (
        error instanceof ProfileStoreError &&
        error.code === "profile_not_found"
      ) {
        throw new ConversationError("conversation_profile_not_found");
      }
      throw error;
    }
  }

  private async resolveSession(profileId: string): Promise<Session> {
    const ready = this.findReadySession(profileId);
    if (ready !== null) {
      return ready;
    }

    try {
      const started = await this.sessions.start(profileId);
      if (started.status === "ready") {
        return started;
      }
    } catch (error) {
      if (!(error instanceof SessionError && error.code === "session_conflict")) {
        console.warn(
          `Conversation session start failed: ${profileId}: ${
            error instanceof SessionError ? error.code : "unknown"
          }`,
        );
        throw new ConversationError("conversation_session_not_ready");
      }
    }

    const deadline = Date.now() + this.sessionReadyTimeoutMs;
    while (Date.now() < deadline) {
      await new Promise<void>((resolvePromise) => {
        setTimeout(resolvePromise, this.sessionPollIntervalMs);
      });
      const session = this.findReadySession(profileId);
      if (session !== null) {
        return session;
      }
    }

    throw new ConversationError("conversation_session_not_ready");
  }

  private findReadySession(profileId: string): Session | null {
    return (
      this.sessions
        .listActive()
        .find(
          (session) =>
            session.profileId === profileId && session.status === "ready",
        ) ?? null
    );
  }

  private async appendAgentReply(event: TerminalEvent): Promise<void> {
    const task = this.tasks.getTask(event.taskId);
    if (task === null || task.conversationId === null) {
      return;
    }

    const text = replyText(event).slice(0, AGENT_REPLY_MAX_LENGTH);
    await this.store.appendAgentMessage(task.conversationId, text, task.id);
  }
}

export function createConversationService(
  options: ConversationServiceOptions,
): ConversationService {
  return new ConversationServiceImpl(options);
}
