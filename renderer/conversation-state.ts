import type { Conversation, Message } from "../shared/conversation";
import type { DomainEvent } from "../shared/event";
import type { Task } from "../shared/task";
import {
  effectiveTaskStatus,
  isTerminalTaskStatus,
  type TaskEventOverlay,
} from "./task-chat-state";
import { texts } from "./texts";

export const CONVERSATION_PAGE_SIZE = 20;
export const MESSAGE_PAGE_SIZE = 20;
export const MAX_TASK_LOOKUP_CONCURRENCY = 4;
export const TERMINAL_REFETCH_DEBOUNCE_MS = 300;

export type ConversationTaskLookup =
  | { readonly kind: "ready"; readonly task: Task }
  | { readonly kind: "unavailable" };

const conversationTimeFormat = new Intl.DateTimeFormat("id-ID", {
  dateStyle: "medium",
  timeStyle: "short",
});

export function mergeMessages(
  existing: readonly Message[],
  incoming: readonly Message[],
): readonly Message[] {
  const byId = new Map<string, Message>();

  for (const message of existing) {
    byId.set(message.id, message);
  }

  for (const message of incoming) {
    byId.set(message.id, message);
  }

  return Array.from(byId.values()).sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.id.localeCompare(right.id),
  );
}

export function sortConversations(
  conversations: readonly Conversation[],
): readonly Conversation[] {
  return [...conversations].sort(
    (left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) ||
      left.id.localeCompare(right.id),
  );
}

export function mergeConversations(
  existing: readonly Conversation[],
  incoming: readonly Conversation[],
): readonly Conversation[] {
  const byId = new Map<string, Conversation>();

  for (const conversation of existing) {
    byId.set(conversation.id, conversation);
  }

  for (const conversation of incoming) {
    byId.set(conversation.id, conversation);
  }

  return sortConversations(Array.from(byId.values()));
}

export function conversationTitle(conversation: Conversation): string {
  return conversation.title ?? texts.conversations.untitled;
}

export function formatConversationTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : conversationTimeFormat.format(date);
}

export function lastTaskIdForConversation(
  messages: readonly Message[],
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const taskId = messages[index]?.taskId;
    if (taskId !== null && taskId !== undefined) {
      return taskId;
    }
  }

  return null;
}

export function buildTaskIdSet(messages: readonly Message[]): ReadonlySet<string> {
  const taskIds = new Set<string>();

  for (const message of messages) {
    if (message.taskId !== null) {
      taskIds.add(message.taskId);
    }
  }

  return taskIds;
}

export function hasNonTerminalTaskForConversation(
  taskIds: ReadonlySet<string>,
  tasks: readonly Task[],
  overlays: ReadonlyMap<string, TaskEventOverlay>,
): boolean {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));

  for (const taskId of taskIds) {
    const task = tasksById.get(taskId);
    if (task === undefined) {
      continue;
    }

    const status = effectiveTaskStatus(task.status, overlays.get(taskId)?.status);
    if (!isTerminalTaskStatus(status)) {
      return true;
    }
  }

  return false;
}

export function shouldRefetchOnTerminal(
  event: DomainEvent,
  knownTaskIds: ReadonlySet<string>,
): boolean {
  if (
    event.type !== "task.completed" &&
    event.type !== "task.failed" &&
    event.type !== "task.cancelled"
  ) {
    return false;
  }

  return knownTaskIds.has(event.taskId);
}

export function terminalTaskIdsFromOverlayChange(
  previous: ReadonlyMap<string, TaskEventOverlay>,
  next: ReadonlyMap<string, TaskEventOverlay>,
  knownTaskIds: ReadonlySet<string>,
): readonly string[] {
  const taskIds: string[] = [];

  for (const taskId of knownTaskIds) {
    const status = next.get(taskId)?.status;
    if (status === undefined || !isTerminalTaskStatus(status)) {
      continue;
    }
    if (previous.get(taskId)?.status === status) {
      continue;
    }

    taskIds.push(taskId);
  }

  return taskIds;
}
