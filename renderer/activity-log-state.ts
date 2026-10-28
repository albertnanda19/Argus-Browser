import type { ArgusEvent } from "../shared/client";
import type { DomainEvent } from "../shared/event";
import {
  formatApprovalAction,
  formatApprovalCategory,
  shortTaskId,
} from "./approval-queue-state";
import { formatStepAction } from "./task-chat-state";
import { sanitizePageUrl } from "./task-panel-state";
import { texts } from "./texts";

export const MAX_ACTIVITY_ENTRIES = 500;
export const MAX_ACTIVITY_TARGET_LENGTH = 80;
export const MAX_ACTIVITY_REASON_LENGTH = 160;

export type ActivityKind =
  | "step"
  | "approval"
  | "completed"
  | "failed"
  | "cancelled";

export type ActivityFilter = "all" | ActivityKind;

export type ActivityEntry = {
  readonly id: string;
  readonly kind: ActivityKind;
  readonly at: string;
  readonly text: string;
  readonly taskId?: string;
};

export const ACTIVITY_FILTERS: readonly ActivityFilter[] = [
  "all",
  "step",
  "approval",
  "completed",
  "failed",
  "cancelled",
];

const activityTimeFormat = new Intl.DateTimeFormat("id-ID", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function truncate(value: string, limit: number): string {
  const trimmed = value.trim();

  return trimmed.length <= limit
    ? trimmed
    : `${trimmed.slice(0, limit - 1)}…`;
}

function buildEntry(
  id: string,
  kind: ActivityKind,
  event: DomainEvent,
  text: string,
): ActivityEntry {
  const taskId = event.taskId === null ? undefined : shortTaskId(event.taskId);

  return {
    id,
    kind,
    at: event.at,
    text,
    ...(taskId === undefined ? {} : { taskId }),
  };
}

function stepText(event: DomainEvent & { readonly type: "step" }): string {
  const page = event.url === undefined ? null : sanitizePageUrl(event.url);
  return texts.activity.line.manualStep(formatStepAction(event.action), page);
}

export function createActivityEntry(entry: ArgusEvent): ActivityEntry {
  const event = entry.event;

  switch (event.type) {
    case "agent.step":
      return buildEntry(
        entry.id,
        "step",
        event,
        texts.activity.line.agentStep(
          event.index,
          formatStepAction(event.action),
          texts.taskChat.step.status[event.status],
          truncate(event.target, MAX_ACTIVITY_TARGET_LENGTH),
        ),
      );
    case "step":
      return buildEntry(entry.id, "step", event, stepText(event));
    case "approval.requested":
      return buildEntry(
        entry.id,
        "approval",
        event,
        texts.activity.line.approval(
          formatApprovalAction(event.action),
          formatApprovalCategory(event.category),
          truncate(event.target, MAX_ACTIVITY_TARGET_LENGTH),
        ),
      );
    case "task.completed": {
      const summary =
        typeof event.result.summary === "string"
          ? event.result.summary.trim()
          : "";

      return buildEntry(
        entry.id,
        "completed",
        event,
        summary === ""
          ? texts.activity.line.completed
          : texts.activity.line.completedWithSummary(summary),
      );
    }
    case "task.failed":
      return buildEntry(
        entry.id,
        "failed",
        event,
        texts.activity.line.failed(
          truncate(event.reason, MAX_ACTIVITY_REASON_LENGTH),
        ),
      );
    case "task.cancelled":
      return buildEntry(
        entry.id,
        "cancelled",
        event,
        texts.activity.line.cancelled(
          truncate(event.reason, MAX_ACTIVITY_REASON_LENGTH),
        ),
      );
  }
}

export function appendActivityEntry(
  entries: readonly ActivityEntry[],
  entry: ActivityEntry,
): readonly ActivityEntry[] {
  if (entries.some((current) => current.id === entry.id)) {
    return entries;
  }

  return [entry, ...entries].slice(0, MAX_ACTIVITY_ENTRIES);
}

export function filterActivityEntries(
  entries: readonly ActivityEntry[],
  filter: ActivityFilter,
  query: string,
): readonly ActivityEntry[] {
  const needle = query.trim().toLowerCase();

  return entries.filter((entry) => {
    if (filter !== "all" && entry.kind !== filter) {
      return false;
    }

    if (needle === "") {
      return true;
    }

    return (
      entry.text.toLowerCase().includes(needle) ||
      (entry.taskId?.toLowerCase().includes(needle) ?? false)
    );
  });
}

export function activityFilterLabel(filter: ActivityFilter): string {
  return filter === "all"
    ? texts.activity.filter.all
    : activityKindLabel(filter);
}

export function activityKindLabel(kind: ActivityKind): string {
  return texts.activity.kind[kind];
}

export function formatActivityTime(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return activityTimeFormat
    .formatToParts(date)
    .filter(
      (part) =>
        part.type === "hour" ||
        part.type === "minute" ||
        part.type === "second",
    )
    .map((part) => part.value)
    .join(":");
}
