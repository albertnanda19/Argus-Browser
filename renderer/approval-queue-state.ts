import type { Approval, JsonObject } from "../shared/task";
import { isTerminalTaskStatus, type TaskEventOverlay } from "./task-chat-state";
import { texts } from "./texts";

export const APPROVAL_PAGE_SIZE = 100;
export const MAX_APPROVAL_PAGES = 5;
export const MAX_TASK_DETAIL_CONCURRENCY = 4;
export const MAX_REJECT_REASON_LENGTH = 500;

export type ApprovalTaskDetail =
  | { readonly kind: "ready"; readonly goal: string }
  | { readonly kind: "unavailable" }
  | { readonly kind: "missing" };

export type ApprovalPayloadContext = {
  readonly selector: string;
  readonly highlighted: boolean;
  readonly category: string;
};

export type RejectReasonValidation =
  | { readonly isValid: true; readonly reason: string }
  | { readonly isValid: false };

const requestedAtFormat = new Intl.DateTimeFormat("id-ID", {
  dateStyle: "medium",
  timeStyle: "short",
});

const requestedAtFullFormat = new Intl.DateTimeFormat("id-ID", {
  dateStyle: "full",
  timeStyle: "long",
});

export function sortPendingApprovals(
  approvals: readonly Approval[],
): readonly Approval[] {
  return [...approvals].sort(
    (left, right) =>
      left.requestedAt.localeCompare(right.requestedAt) ||
      left.id.localeCompare(right.id),
  );
}

export function filterPendingApprovalsByOverlay(
  approvals: readonly Approval[],
  overlays: ReadonlyMap<string, TaskEventOverlay>,
): readonly Approval[] {
  return approvals.filter((approval) => {
    const status = overlays.get(approval.taskId)?.status;
    return status === undefined || !isTerminalTaskStatus(status);
  });
}

export function countWaitingApprovalOverlays(
  overlays: ReadonlyMap<string, TaskEventOverlay>,
): number {
  let count = 0;

  for (const overlay of overlays.values()) {
    if (overlay.status === "waiting_approval") {
      count += 1;
    }
  }

  return count;
}

export function shouldRefetchForWaitingCount(
  previousCount: number | null,
  nextCount: number,
): boolean {
  return previousCount !== null && nextCount > previousCount;
}

export function formatApprovalAction(action: string): string {
  const labels: Readonly<Record<string, string>> = texts.approval.action;
  return labels[action] ?? texts.approval.actionFallback;
}

export function formatApprovalCategory(category: string): string {
  const labels: Readonly<Record<string, string>> = texts.approval.category;
  return labels[category] ?? texts.approval.categoryFallback;
}

export function parseApprovalPayload(
  payload: JsonObject,
): ApprovalPayloadContext {
  return {
    selector: typeof payload.selector === "string" ? payload.selector : "",
    highlighted: payload.highlighted === true,
    category: typeof payload.category === "string" ? payload.category : "",
  };
}

function formatTime(
  value: string,
  formatter: Intl.DateTimeFormat,
): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : formatter.format(date);
}

export function formatApprovalRequestedAt(value: string): string {
  return formatTime(value, requestedAtFormat);
}

export function formatApprovalRequestedAtFull(value: string): string {
  return formatTime(value, requestedAtFullFormat);
}

export function shortTaskId(taskId: string): string {
  return taskId.slice(0, 10);
}

export function validateRejectReason(value: string): RejectReasonValidation {
  const reason = value.trim();

  if (reason.length < 1 || reason.length > MAX_REJECT_REASON_LENGTH) {
    return { isValid: false };
  }

  return { isValid: true, reason };
}

export async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(limit, 1), items.length);

  const run = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;

      if (item !== undefined) {
        await worker(item);
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, run));
}
