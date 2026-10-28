import type { AgentStep, AgentStepStatus } from "../shared/agent-step";
import type { DomainEvent } from "../shared/event";
import type { Task, TaskStatus } from "../shared/task";
import { texts } from "./texts";

export const MAX_REMEMBERED_EVENT_IDS = 500;
export const INITIAL_RECONNECT_DELAY_MS = 1000;
export const MAX_RECONNECT_DELAY_MS = 10000;

export type TaskLastStep = {
  readonly index: number;
  readonly action: string;
  readonly status: AgentStepStatus;
};

export type TaskEventOverlay = {
  readonly status?: TaskStatus;
  readonly summary?: string;
  readonly reason?: string;
  readonly lastStep?: TaskLastStep;
};

export type EventIdDeduplicator = {
  readonly size: number;
  remember(id: string): boolean;
};

export type AgentReplyInput = {
  readonly status: TaskStatus;
  readonly overlay: TaskEventOverlay | undefined;
  readonly steps: readonly AgentStep[];
};

const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

export function sortTasksChronologically(
  tasks: readonly Task[],
): readonly Task[] {
  return [...tasks].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.id.localeCompare(right.id),
  );
}

export function upsertTask(tasks: readonly Task[], task: Task): readonly Task[] {
  const index = tasks.findIndex((current) => current.id === task.id);

  if (index === -1) {
    return [...tasks, task];
  }

  const next = [...tasks];
  next[index] = task;
  return next;
}

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.has(status);
}

export function effectiveTaskStatus(
  taskStatus: TaskStatus,
  overlayStatus: TaskStatus | undefined,
): TaskStatus {
  if (overlayStatus === undefined) {
    return taskStatus;
  }
  if (isTerminalTaskStatus(overlayStatus)) {
    return overlayStatus;
  }
  if (isTerminalTaskStatus(taskStatus)) {
    return taskStatus;
  }
  return overlayStatus;
}

export function hasNonTerminalTask(
  tasks: readonly Task[],
  overlays: ReadonlyMap<string, TaskEventOverlay>,
): boolean {
  return tasks.some(
    (task) =>
      !isTerminalTaskStatus(
        effectiveTaskStatus(task.status, overlays.get(task.id)?.status),
      ),
  );
}

function updateOverlay(
  overlays: ReadonlyMap<string, TaskEventOverlay>,
  taskId: string,
  update: (current: TaskEventOverlay) => TaskEventOverlay,
): ReadonlyMap<string, TaskEventOverlay> {
  const next = new Map(overlays);
  next.set(taskId, update(next.get(taskId) ?? {}));
  return next;
}

export function applyTaskEvent(
  overlays: ReadonlyMap<string, TaskEventOverlay>,
  event: DomainEvent,
): ReadonlyMap<string, TaskEventOverlay> {
  switch (event.type) {
    case "agent.step":
      return updateOverlay(overlays, event.taskId, (current) => ({
        ...current,
        status: "running",
        lastStep: {
          index: event.index,
          action: event.action,
          status: event.status,
        },
      }));
    case "approval.requested":
      return updateOverlay(overlays, event.taskId, (current) => ({
        ...current,
        status: "waiting_approval",
      }));
    case "task.completed":
      return updateOverlay(overlays, event.taskId, (current) => ({
        ...current,
        status: "completed",
        ...(typeof event.result.summary === "string"
          ? { summary: event.result.summary }
          : {}),
      }));
    case "task.failed":
      return updateOverlay(overlays, event.taskId, (current) => ({
        ...current,
        status: "failed",
        reason: event.reason,
      }));
    case "task.cancelled":
      return updateOverlay(overlays, event.taskId, (current) => ({
        ...current,
        status: "cancelled",
        reason: event.reason,
      }));
    case "step":
      return overlays;
  }
}

export function clearOverlayStatuses(
  overlays: ReadonlyMap<string, TaskEventOverlay>,
): ReadonlyMap<string, TaskEventOverlay> {
  const next = new Map<string, TaskEventOverlay>();

  for (const [taskId, overlay] of overlays) {
    next.set(taskId, {
      ...(overlay.summary === undefined ? {} : { summary: overlay.summary }),
      ...(overlay.reason === undefined ? {} : { reason: overlay.reason }),
      ...(overlay.lastStep === undefined
        ? {}
        : { lastStep: overlay.lastStep }),
    });
  }

  return next;
}

export function formatStepAction(action: string): string {
  const labels: Readonly<Record<string, string>> = texts.taskChat.step.action;
  return labels[action] ?? texts.taskChat.step.actionUnknown;
}

export function formatStepLine(
  index: number,
  action: string,
  status: AgentStepStatus,
): string {
  return texts.taskChat.step.line(
    index,
    formatStepAction(action),
    texts.taskChat.step.status[status],
  );
}

function lastStepFromSteps(steps: readonly AgentStep[]): TaskLastStep | null {
  let last: AgentStep | undefined;

  for (const step of steps) {
    if (last === undefined || step.index > last.index) {
      last = step;
    }
  }

  return last === undefined
    ? null
    : { index: last.index, action: last.action, status: last.result.status };
}

function lastVerificationReason(steps: readonly AgentStep[]): string | null {
  let last: AgentStep | undefined;

  for (const step of steps) {
    if (last === undefined || step.index > last.index) {
      last = step;
    }
  }

  const reason = last?.result.verification?.reason;
  return reason === undefined || reason.trim() === "" ? null : reason;
}

function present(value: string | undefined): string | null {
  return value === undefined || value.trim() === "" ? null : value;
}

export function selectAgentReply(input: AgentReplyInput): string {
  switch (input.status) {
    case "queued":
      return texts.taskChat.reply.queued;
    case "running": {
      const step = input.overlay?.lastStep ?? lastStepFromSteps(input.steps);
      return step === null || step === undefined
        ? texts.taskChat.reply.running
        : texts.taskChat.reply.runningWithStep(
            formatStepLine(step.index, step.action, step.status),
          );
    }
    case "waiting_approval":
      return texts.taskChat.reply.waitingApproval;
    case "completed": {
      const summary = present(input.overlay?.summary);
      if (summary !== null) {
        return summary;
      }
      return (
        lastVerificationReason(input.steps) ?? texts.taskChat.reply.completed
      );
    }
    case "failed": {
      const reason = present(input.overlay?.reason);
      return reason ?? texts.taskChat.reply.failed;
    }
    case "cancelled": {
      const reason = present(input.overlay?.reason);
      return reason ?? texts.taskChat.reply.cancelled;
    }
  }
}

export function taskStatusLabel(status: TaskStatus): string {
  return texts.taskChat.status[status];
}

export function createEventIdDeduplicator(
  limit: number = MAX_REMEMBERED_EVENT_IDS,
): EventIdDeduplicator {
  const seen = new Set<string>();
  const order: string[] = [];

  return {
    get size() {
      return seen.size;
    },
    remember(id: string): boolean {
      if (seen.has(id)) {
        return false;
      }

      seen.add(id);
      order.push(id);

      while (order.length > limit) {
        const oldest = order.shift();
        if (oldest !== undefined) {
          seen.delete(oldest);
        }
      }

      return true;
    },
  };
}

export function nextReconnectDelay(previousMs: number): number {
  return Math.min(previousMs * 2, MAX_RECONNECT_DELAY_MS);
}

export function createIdempotencyKey(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
}
