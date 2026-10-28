import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import type { ApprovalDecisionRequest } from "../shared/api";
import { ArgusApiError } from "../shared/client";
import type { Approval } from "../shared/task";
import type { ArgusRuntime } from "./api-runtime";
import {
  APPROVAL_PAGE_SIZE,
  MAX_APPROVAL_PAGES,
  MAX_REJECT_REASON_LENGTH,
  MAX_TASK_DETAIL_CONCURRENCY,
  countWaitingApprovalOverlays,
  filterPendingApprovalsByOverlay,
  formatApprovalAction,
  formatApprovalCategory,
  formatApprovalRequestedAt,
  formatApprovalRequestedAtFull,
  mapWithConcurrency,
  parseApprovalPayload,
  shortTaskId,
  shouldRefetchForWaitingCount,
  sortPendingApprovals,
  validateRejectReason,
  type ApprovalTaskDetail,
} from "./approval-queue-state";
import { isAbortError, toDisplayError } from "./cockpit-state";
import { ConfirmDialog } from "./ConfirmDialog";
import type { TaskEventOverlay } from "./task-chat-state";
import { texts } from "./texts";

const APPROVALS_TIMEOUT_MS = 5000;
const TASK_DETAIL_TIMEOUT_MS = 5000;
const DECISION_TIMEOUT_MS = 10000;
const VISIBILITY_DEBOUNCE_MS = 300;

type ApprovalQueueProps = {
  readonly runtime: ArgusRuntime;
  readonly taskEvents: ReadonlyMap<string, TaskEventOverlay>;
  readonly reconnectVersion: number;
};

type DecisionDialog =
  | { readonly kind: "approve"; readonly approval: Approval }
  | { readonly kind: "reject"; readonly approval: Approval; readonly reason: string };

type QueueNotice = {
  readonly tone: "success" | "error";
  readonly message: string;
};

export function ApprovalQueue({
  runtime,
  taskEvents,
  reconnectVersion,
}: ApprovalQueueProps) {
  const [approvals, setApprovals] = useState<readonly Approval[]>([]);
  const [taskDetails, setTaskDetails] = useState<
    Readonly<Record<string, ApprovalTaskDetail>>
  >({});
  const [isTruncated, setIsTruncated] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [dialog, setDialog] = useState<DecisionDialog | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [pendingApprovalId, setPendingApprovalId] = useState<string | null>(
    null,
  );
  const [notice, setNotice] = useState<QueueNotice | null>(null);
  const panelId = useId();
  const headingId = `${panelId}-heading`;
  const isMountedRef = useRef(true);
  const requestSequenceRef = useRef(0);
  const taskCacheRef = useRef<Map<string, ApprovalTaskDetail>>(new Map());
  const taskInFlightRef = useRef<Set<string>>(new Set());
  const decidedApprovalIdsRef = useRef<Set<string>>(new Set());
  const decisionPendingRef = useRef(false);
  const triggerRef = useRef<HTMLElement | null>(null);
  const queueRef = useRef<HTMLDivElement>(null);
  const rejectTextareaRef = useRef<HTMLTextAreaElement>(null);
  const wasDialogOpenRef = useRef(false);
  const previousWaitingCountRef = useRef<number | null>(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    requestSequenceRef.current += 1;
    taskCacheRef.current = new Map();
    taskInFlightRef.current = new Set();
    decidedApprovalIdsRef.current = new Set();
    previousWaitingCountRef.current = null;
    setApprovals([]);
    setTaskDetails({});
    setIsTruncated(false);
    setLoadError(null);
    setExpandedIds(new Set());
    setDialog(null);
    setDialogError(null);
    setPendingApprovalId(null);
    setNotice(null);
  }, [runtime]);

  const loadTaskDetails = useCallback(
    async (items: readonly Approval[]): Promise<void> => {
      const taskIds = Array.from(new Set(items.map((item) => item.taskId)));
      const missing = taskIds.filter(
        (taskId) =>
          !taskCacheRef.current.has(taskId) &&
          !taskInFlightRef.current.has(taskId),
      );

      if (missing.length === 0) {
        return;
      }

      for (const taskId of missing) {
        taskInFlightRef.current.add(taskId);
      }

      await mapWithConcurrency(
        missing,
        MAX_TASK_DETAIL_CONCURRENCY,
        async (taskId) => {
          try {
            const response = await runtime.run(TASK_DETAIL_TIMEOUT_MS, (client) =>
              client.tasks.get(taskId),
            );

            if (!isMountedRef.current) {
              return;
            }

            const detail: ApprovalTaskDetail = {
              kind: "ready",
              goal: response.data.goal,
            };
            taskCacheRef.current.set(taskId, detail);
            setTaskDetails((current) => ({ ...current, [taskId]: detail }));
          } catch (error: unknown) {
            if (!isMountedRef.current || isAbortError(error)) {
              return;
            }

            if (error instanceof ArgusApiError && error.status === 404) {
              const detail: ApprovalTaskDetail = { kind: "missing" };
              taskCacheRef.current.set(taskId, detail);
              setTaskDetails((current) => ({ ...current, [taskId]: detail }));
              setReloadKey((current) => current + 1);
              return;
            }

            console.error("Task detail load failed:", error);
            const detail: ApprovalTaskDetail = { kind: "unavailable" };
            taskCacheRef.current.set(taskId, detail);
            setTaskDetails((current) => ({ ...current, [taskId]: detail }));
          } finally {
            taskInFlightRef.current.delete(taskId);
          }
        },
      );
    },
    [runtime],
  );

  const loadApprovals = useCallback(async (): Promise<void> => {
    const sequence = requestSequenceRef.current + 1;
    requestSequenceRef.current = sequence;

    try {
      const collected = new Map<string, Approval>();
      let total = 0;

      for (let page = 1; page <= MAX_APPROVAL_PAGES; page += 1) {
        const response = await runtime.run(APPROVALS_TIMEOUT_MS, (client) =>
          client.approvals.list({
            decision: "pending",
            page,
            page_size: APPROVAL_PAGE_SIZE,
          }),
        );

        total = response.total;

        for (const approval of response.data) {
          collected.set(approval.id, approval);
        }

        if (collected.size >= total || response.data.length === 0) {
          break;
        }
      }

      if (!isMountedRef.current || sequence !== requestSequenceRef.current) {
        return;
      }

      const ordered = sortPendingApprovals([...collected.values()]).filter(
        (approval) => !decidedApprovalIdsRef.current.has(approval.id),
      );
      setApprovals(ordered);
      setIsTruncated(total > collected.size);
      setLoadError(null);
      void loadTaskDetails(ordered);
    } catch (error: unknown) {
      if (
        !isMountedRef.current ||
        isAbortError(error) ||
        sequence !== requestSequenceRef.current
      ) {
        return;
      }

      console.error("Approval queue load failed:", error);
      setLoadError(toDisplayError(error));
      setNotice(null);
    }
  }, [runtime, loadTaskDetails]);

  useEffect(() => {
    void loadApprovals();
  }, [loadApprovals, reconnectVersion, reloadKey]);

  useEffect(() => {
    let timer: number | null = null;

    const handleVisibilityChange = (): void => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }

      if (document.visibilityState !== "visible") {
        return;
      }

      timer = window.setTimeout(() => {
        timer = null;
        setReloadKey((current) => current + 1);
      }, VISIBILITY_DEBOUNCE_MS);
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      if (timer !== null) {
        window.clearTimeout(timer);
      }
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  const waitingCount = countWaitingApprovalOverlays(taskEvents);

  useEffect(() => {
    const previous = previousWaitingCountRef.current;
    previousWaitingCountRef.current = waitingCount;

    if (shouldRefetchForWaitingCount(previous, waitingCount)) {
      setReloadKey((current) => current + 1);
    }
  }, [waitingCount]);

  const visibleApprovals = filterPendingApprovalsByOverlay(
    approvals,
    taskEvents,
  ).filter((approval) => taskDetails[approval.taskId]?.kind !== "missing");

  const dialogApprovalId = dialog?.approval.id ?? null;
  const isDialogApprovalVisible =
    dialogApprovalId !== null &&
    visibleApprovals.some((approval) => approval.id === dialogApprovalId);

  useEffect(() => {
    if (dialog !== null) {
      wasDialogOpenRef.current = true;
      return;
    }

    if (!wasDialogOpenRef.current) {
      return;
    }

    wasDialogOpenRef.current = false;
    const trigger = triggerRef.current;

    if (trigger !== null && trigger.isConnected) {
      trigger.focus();
      return;
    }

    queueRef.current?.focus();
  }, [dialog]);

  useEffect(() => {
    if (
      dialog === null ||
      pendingApprovalId !== null ||
      isDialogApprovalVisible
    ) {
      return;
    }

    if (dialogError !== null) {
      setNotice({ tone: "error", message: dialogError });
    }

    setDialog(null);
    setDialogError(null);
  }, [dialog, dialogError, isDialogApprovalVisible, pendingApprovalId]);

  const handleToggleDetail = (approvalId: string): void => {
    setExpandedIds((current) => {
      const next = new Set(current);

      if (next.has(approvalId)) {
        next.delete(approvalId);
      } else {
        next.add(approvalId);
      }

      return next;
    });
  };

  const handleOpenApprove = (
    approval: Approval,
    event: MouseEvent<HTMLButtonElement>,
  ): void => {
    if (pendingApprovalId !== null) {
      return;
    }

    triggerRef.current = event.currentTarget;
    setNotice(null);
    setDialog({ kind: "approve", approval });
    setDialogError(null);
  };

  const handleOpenReject = (
    approval: Approval,
    event: MouseEvent<HTMLButtonElement>,
  ): void => {
    if (pendingApprovalId !== null) {
      return;
    }

    triggerRef.current = event.currentTarget;
    setNotice(null);
    setDialog({ kind: "reject", approval, reason: "" });
    setDialogError(null);
  };

  const resolveDecision = async (
    approval: Approval,
    input: ApprovalDecisionRequest,
    successMessage: string,
  ): Promise<void> => {
    if (decisionPendingRef.current) {
      return;
    }

    decisionPendingRef.current = true;
    setPendingApprovalId(approval.id);
    setDialogError(null);

    try {
      await runtime.run(DECISION_TIMEOUT_MS, (client) =>
        client.tasks.resolveApproval(approval.taskId, input),
      );

      if (!isMountedRef.current) {
        return;
      }

      decidedApprovalIdsRef.current.add(approval.id);
      setApprovals((current) =>
        current.filter((item) => item.id !== approval.id),
      );
      setNotice({ tone: "success", message: successMessage });
      triggerRef.current = null;
      setDialog(null);
      setDialogError(null);
    } catch (error: unknown) {
      if (!isMountedRef.current || isAbortError(error)) {
        return;
      }

      const message = toDisplayError(error);
      requestSequenceRef.current += 1;
      setReloadKey((current) => current + 1);

      if (
        error instanceof ArgusApiError &&
        (error.status === 404 || error.status === 409)
      ) {
        setNotice({ tone: "error", message });
        triggerRef.current = null;
        setDialog(null);
        setDialogError(null);
      } else {
        setDialogError(message);
      }
    } finally {
      decisionPendingRef.current = false;

      if (isMountedRef.current) {
        setPendingApprovalId(null);
      }
    }
  };

  const handleCancelDialog = (): void => {
    if (pendingApprovalId !== null) {
      return;
    }

    setDialog(null);
    setDialogError(null);
  };

  const rejectValidation =
    dialog?.kind === "reject"
      ? validateRejectReason(dialog.reason)
      : null;
  const isDecisionPending = pendingApprovalId !== null;
  const noticeTone = loadError === null ? notice?.tone : "error";
  const noticeMessage = loadError ?? notice?.message ?? "";

  return (
    <div className="approval-queue" ref={queueRef} tabIndex={-1}>
      <p
        className="approval-notice"
        role={noticeTone === "error" ? "alert" : "status"}
        aria-live={noticeTone === "error" ? "assertive" : "polite"}
        aria-atomic="true"
        tabIndex={-1}
      >
        {noticeMessage}
      </p>

      {visibleApprovals.length === 0 ? null : (
        <section
          className="panel approval-panel"
          aria-labelledby={headingId}
        >
          <h2 className="panel-heading" id={headingId}>
            {texts.approval.heading(visibleApprovals.length)}
          </h2>

          {isTruncated ? (
            <p className="panel-note">{texts.approval.truncated}</p>
          ) : null}

          <ol className="approval-list">
            {visibleApprovals.map((approval) => {
              const payload = parseApprovalPayload(approval.payload);
              const detail = taskDetails[approval.taskId];
              const isExpanded = expandedIds.has(approval.id);
              const detailId = `${panelId}-detail-${approval.id}`;
              const isPending = pendingApprovalId === approval.id;
              const actionLabel = formatApprovalAction(approval.action);
              const categoryLabel = formatApprovalCategory(payload.category);
              const hasSelector = payload.selector.trim() !== "";

              return (
                <li className="approval-item" key={approval.id}>
                  <p className="approval-goal">
                    {detail?.kind === "ready"
                      ? detail.goal
                      : detail?.kind === "unavailable"
                        ? texts.approval.taskUnavailable
                        : texts.approval.goalLoading}
                  </p>

                  {detail?.kind === "unavailable" ? (
                    <p className="approval-task-id">
                      {texts.approval.taskIdLabel}:{" "}
                      <code>{shortTaskId(approval.taskId)}</code>
                    </p>
                  ) : null}

                  <dl className="approval-facts">
                    <dt>{texts.approval.actionLabel}</dt>
                    <dd>{actionLabel}</dd>
                    <dt>{texts.approval.targetLabel}</dt>
                    <dd>{approval.target}</dd>
                    <dt>{texts.approval.categoryLabel}</dt>
                    <dd>{categoryLabel}</dd>
                    <dt>{texts.approval.requestedAtLabel}</dt>
                    <dd>
                      <time dateTime={approval.requestedAt}>
                        {formatApprovalRequestedAt(approval.requestedAt)}
                      </time>
                    </dd>
                  </dl>

                  <div className="approval-actions">
                    <button
                      className="button"
                      type="button"
                      onClick={() => handleToggleDetail(approval.id)}
                      aria-expanded={isExpanded}
                      aria-controls={isExpanded ? detailId : undefined}
                    >
                      {isExpanded
                        ? texts.approval.hideDetail
                        : texts.approval.viewDetail}
                    </button>
                    <button
                      className="button"
                      type="button"
                      onClick={(event) => handleOpenReject(approval, event)}
                      disabled={isPending}
                    >
                      {texts.approval.reject}
                    </button>
                    <button
                      className="button button-primary"
                      type="button"
                      onClick={(event) => handleOpenApprove(approval, event)}
                      disabled={isPending}
                    >
                      {texts.approval.approve}
                    </button>
                  </div>

                  {isExpanded ? (
                    <div className="approval-detail" id={detailId}>
                      <dl className="approval-facts">
                        <dt>{texts.approval.selectorLabel}</dt>
                        <dd>
                          <code className="approval-selector">
                            {hasSelector
                              ? payload.selector
                              : texts.approval.noSelector}
                          </code>
                        </dd>
                        <dt>{texts.approval.taskIdLabel}</dt>
                        <dd>
                          <code>{shortTaskId(approval.taskId)}</code>
                        </dd>
                        <dt>{texts.approval.requestedAtLabel}</dt>
                        <dd>
                          <time dateTime={approval.requestedAt}>
                            {formatApprovalRequestedAtFull(approval.requestedAt)}
                          </time>
                        </dd>
                      </dl>
                      <p
                        className={
                          payload.highlighted
                            ? "approval-highlight"
                            : "approval-warning"
                        }
                      >
                        {payload.highlighted
                          ? texts.approval.highlighted
                          : texts.approval.notHighlighted}
                      </p>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </section>
      )}

      {dialog === null ? null : (
        <ConfirmDialog
          title={
            dialog.kind === "approve"
              ? texts.approval.approveTitle
              : texts.approval.rejectTitle
          }
          message={
            dialog.kind === "approve"
              ? texts.approval.approveMessage(
                  formatApprovalAction(dialog.approval.action),
                  dialog.approval.target,
                )
              : texts.approval.rejectMessage(
                  formatApprovalAction(dialog.approval.action),
                  dialog.approval.target,
                )
          }
          confirmLabel={
            isDecisionPending
              ? texts.approval.processing
              : dialog.kind === "approve"
                ? texts.approval.confirmApprove
                : texts.approval.confirmReject
          }
          cancelLabel={texts.approval.cancel}
          isPending={isDecisionPending}
          isConfirmDisabled={
            dialog.kind === "reject" &&
            rejectValidation?.isValid !== true
          }
          initialFocusRef={
            dialog.kind === "reject" ? rejectTextareaRef : undefined
          }
          error={dialogError}
          onConfirm={() => {
            if (dialog.kind === "approve") {
              void resolveDecision(
                dialog.approval,
                { approve: true },
                texts.approval.approved,
              );
              return;
            }

            const validation = validateRejectReason(dialog.reason);

            if (validation.isValid) {
              void resolveDecision(
                dialog.approval,
                { approve: false, reason: validation.reason },
                texts.approval.rejected,
              );
            }
          }}
          onCancel={handleCancelDialog}
        >
          {dialog.kind === "reject" ? (
            <div className="approval-reason">
              <label className="field-label" htmlFor="approval-reject-reason">
                {texts.approval.rejectReasonLabel}
              </label>
              <textarea
                ref={rejectTextareaRef}
                id="approval-reject-reason"
                className="input chat-textarea"
                value={dialog.reason}
                maxLength={MAX_REJECT_REASON_LENGTH}
                rows={3}
                placeholder={texts.approval.rejectReasonPlaceholder}
                disabled={isDecisionPending}
                onChange={(event) =>
                  setDialog((current) =>
                    current !== null && current.kind === "reject"
                      ? { ...current, reason: event.target.value }
                      : current,
                  )
                }
              />
              <span className="chat-counter">
                {texts.approval.rejectReasonCount(dialog.reason.length)}
              </span>
              {rejectValidation?.isValid === false ? (
                <p className="panel-note">{texts.approval.reasonRequired}</p>
              ) : null}
            </div>
          ) : null}
        </ConfirmDialog>
      )}
    </div>
  );
}
