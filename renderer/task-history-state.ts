import type { Task, TaskStatus } from "../shared/task";
import {
  effectiveTaskStatus,
  isTerminalTaskStatus,
  taskStatusLabel,
  type TaskEventOverlay,
} from "./task-chat-state";
import { texts } from "./texts";

export const TASK_HISTORY_PAGE_SIZE = 20;
export const TASK_HISTORY_REFRESH_DEBOUNCE_MS = 300;
export const TASK_HISTORY_TICK_INTERVAL_MS = 1000;

export type TaskHistoryFilter = "all" | TaskStatus;

export const TASK_HISTORY_FILTERS: readonly TaskHistoryFilter[] = [
  "all",
  "queued",
  "running",
  "waiting_approval",
  "completed",
  "failed",
  "cancelled",
];

const decimalFormat = new Intl.NumberFormat("id-ID", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

const createdAtFormat = new Intl.DateTimeFormat("id-ID", {
  dateStyle: "medium",
  timeStyle: "short",
});

function compareNewestFirst(left: Task, right: Task): number {
  return (
    right.createdAt.localeCompare(left.createdAt) ||
    right.id.localeCompare(left.id)
  );
}

export function historyFilterLabel(filter: TaskHistoryFilter): string {
  return filter === "all"
    ? texts.taskHistory.filter.all
    : taskStatusLabel(filter);
}

export function formatHistoryDuration(durationMs: number): string {
  const safeMs = Math.max(0, durationMs);

  if (safeMs < 60000) {
    return `${decimalFormat.format(safeMs / 1000)} dtk`;
  }

  const totalSeconds = Math.floor(safeMs / 1000);

  if (safeMs < 3600000) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes} mnt ${seconds} dtk`;
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return `${hours} j ${minutes} mnt`;
}

export function formatHistoryCreatedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : createdAtFormat.format(date);
}

export function historyDurationMs(
  task: Task,
  status: TaskStatus,
  nowMs: number,
): number {
  const createdAtMs = Date.parse(task.createdAt);

  if (Number.isNaN(createdAtMs)) {
    return 0;
  }

  const completedAtMs =
    task.completedAt === null ? null : Date.parse(task.completedAt);
  const endMs =
    isTerminalTaskStatus(status) &&
    completedAtMs !== null &&
    !Number.isNaN(completedAtMs)
      ? completedAtMs
      : nowMs;

  if (Number.isNaN(endMs)) {
    return 0;
  }

  return Math.max(0, endMs - createdAtMs);
}

export function mergeHistoryPages(
  existing: readonly Task[],
  incoming: readonly Task[],
): readonly Task[] {
  const merged = new Map<string, Task>();

  for (const task of existing) {
    merged.set(task.id, task);
  }

  for (const task of incoming) {
    merged.set(task.id, task);
  }

  return [...merged.values()].sort(compareNewestFirst);
}

export function filterHistoryTasks(
  tasks: readonly Task[],
  overlays: ReadonlyMap<string, TaskEventOverlay>,
  filter: TaskHistoryFilter,
): readonly Task[] {
  if (filter === "all") {
    return tasks;
  }

  return tasks.filter(
    (task) =>
      effectiveTaskStatus(task.status, overlays.get(task.id)?.status) ===
      filter,
  );
}

export function findNewHistoryTaskIds(
  tasks: readonly Task[],
  overlays: ReadonlyMap<string, TaskEventOverlay>,
): readonly string[] {
  const knownIds = new Set(tasks.map((task) => task.id));
  const newIds: string[] = [];

  for (const taskId of overlays.keys()) {
    if (!knownIds.has(taskId)) {
      newIds.push(taskId);
    }
  }

  return newIds;
}

export function hasHistoryRefreshTrigger(
  previous: ReadonlyMap<string, TaskEventOverlay>,
  next: ReadonlyMap<string, TaskEventOverlay>,
  tasks: readonly Task[],
): boolean {
  for (const [taskId, overlay] of next) {
    if (
      overlay.status !== undefined &&
      isTerminalTaskStatus(overlay.status) &&
      previous.get(taskId)?.status !== overlay.status
    ) {
      return true;
    }
  }

  return findNewHistoryTaskIds(tasks, next).some(
    (taskId) => previous.get(taskId) === undefined,
  );
}
