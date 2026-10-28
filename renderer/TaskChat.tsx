import { useEffect, useRef, useState, type FormEvent } from "react";
import type { AgentStep } from "../shared/agent-step";
import type { Profile } from "../shared/profile";
import type { Session } from "../shared/session";
import type { Task, TaskStatus } from "../shared/task";
import { ArgusApiError } from "../shared/client";
import type { ArgusRuntime } from "./api-runtime";
import { isAbortError, toDisplayError } from "./cockpit-state";
import { TaskStatusPanel } from "./TaskStatusPanel";
import {
  createIdempotencyKey,
  effectiveTaskStatus,
  hasNonTerminalTask,
  isTerminalTaskStatus,
  selectAgentReply,
  sortTasksChronologically,
  taskStatusLabel,
  upsertTask,
  type TaskEventOverlay,
} from "./task-chat-state";
import { texts } from "./texts";

const TASK_LIST_TIMEOUT_MS = 5000;
const TASK_READ_TIMEOUT_MS = 5000;
const TASK_STEPS_TIMEOUT_MS = 5000;
const TASK_CREATE_TIMEOUT_MS = 10000;
const TASK_CANCEL_TIMEOUT_MS = 10000;
const MAX_GOAL_LENGTH = 2000;

type TaskChatProps = {
  readonly runtime: ArgusRuntime;
  readonly profile: Profile | null;
  readonly session: Session | null;
  readonly taskEvents: ReadonlyMap<string, TaskEventOverlay>;
  readonly reconnectVersion: number;
};

type DraftKey = {
  readonly goal: string;
  readonly key: string;
};

type CancelError = {
  readonly taskId: string;
  readonly message: string;
};

export function TaskChat({
  runtime,
  profile,
  session,
  taskEvents,
  reconnectVersion,
}: TaskChatProps) {
  const sessionId = session?.id ?? null;
  const [tasks, setTasks] = useState<readonly Task[]>([]);
  const [isLoading, setIsLoading] = useState(session !== null);
  const [listError, setListError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [stepsByTask, setStepsByTask] = useState<
    Readonly<Record<string, readonly AgentStep[]>>
  >({});
  const [stepsLoadedStatus, setStepsLoadedStatus] = useState<
    Readonly<Record<string, TaskStatus>>
  >({});
  const [draft, setDraft] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [cancelPendingTaskId, setCancelPendingTaskId] = useState<string | null>(
    null,
  );
  const [cancelError, setCancelError] = useState<CancelError | null>(null);
  const selectedTaskIdRef = useRef<string | null>(null);
  const draftKeyRef = useRef<DraftKey | null>(null);
  const submitPendingRef = useRef(false);
  const cancelPendingRef = useRef(false);
  const loadingStepsRef = useRef<Set<string>>(new Set());
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (sessionId === null) {
      setTasks([]);
      setIsLoading(false);
      setListError(null);
      return;
    }

    let isActive = true;
    setIsLoading(true);
    setListError(null);

    void (async () => {
      try {
        const response = await runtime.run(TASK_LIST_TIMEOUT_MS, (client) =>
          client.tasks.list({ sessionId, page_size: 100 }),
        );

        if (!isActive) {
          return;
        }

        const ordered = sortTasksChronologically(response.data);
        const previous = selectedTaskIdRef.current;
        const nextSelected =
          previous !== null && ordered.some((task) => task.id === previous)
            ? previous
            : (ordered[ordered.length - 1]?.id ?? null);

        selectedTaskIdRef.current = nextSelected;
        setSelectedTaskId(nextSelected);
        setTasks(ordered);

        if (reconnectVersion === 0 || nextSelected === null) {
          return;
        }

        const selected = ordered.find((task) => task.id === nextSelected);
        if (selected === undefined || isTerminalTaskStatus(selected.status)) {
          return;
        }

        const refreshed = await runtime.run(TASK_READ_TIMEOUT_MS, (client) =>
          client.tasks.get(nextSelected),
        );

        if (isActive) {
          setTasks((current) => upsertTask(current, refreshed.data));
        }
      } catch (error: unknown) {
        if (isActive && !isAbortError(error)) {
          setListError(toDisplayError(error));
        }
      } finally {
        if (isActive) {
          setIsLoading(false);
        }
      }
    })();

    return () => {
      isActive = false;
    };
  }, [runtime, sessionId, reconnectVersion, reloadKey]);

  const selectedTask =
    selectedTaskId === null
      ? undefined
      : tasks.find((task) => task.id === selectedTaskId);
  const selectedStatus =
    selectedTask === undefined
      ? undefined
      : effectiveTaskStatus(
          selectedTask.status,
          taskEvents.get(selectedTask.id)?.status,
        );

  useEffect(() => {
    if (selectedTask === undefined || selectedStatus === undefined) {
      return;
    }

    const hasSteps = stepsByTask[selectedTask.id] !== undefined;
    const isStaleTerminalLoad =
      isTerminalTaskStatus(selectedStatus) &&
      stepsLoadedStatus[selectedTask.id] !== selectedStatus;

    if (hasSteps && !isStaleTerminalLoad) {
      return;
    }
    if (loadingStepsRef.current.has(selectedTask.id)) {
      return;
    }

    const taskId = selectedTask.id;
    loadingStepsRef.current.add(taskId);
    let isActive = true;

    runtime
      .run(TASK_STEPS_TIMEOUT_MS, (client) =>
        client.tasks.listSteps(taskId, { page_size: 100 }),
      )
      .then((response) => {
        if (!isActive) {
          return;
        }

        setStepsByTask((current) => ({ ...current, [taskId]: response.data }));
        setStepsLoadedStatus((current) => ({
          ...current,
          [taskId]: selectedStatus,
        }));
      })
      .catch((error: unknown) => {
        if (!isActive || isAbortError(error)) {
          return;
        }

        console.error("Task steps load failed:", error);
        setStepsByTask((current) => ({ ...current, [taskId]: [] }));
        setStepsLoadedStatus((current) => ({
          ...current,
          [taskId]: selectedStatus,
        }));
      })
      .finally(() => {
        loadingStepsRef.current.delete(taskId);
      });

    return () => {
      isActive = false;
    };
  }, [
    runtime,
    selectedTask,
    selectedStatus,
    stepsByTask,
    stepsLoadedStatus,
  ]);

  const isSessionReady =
    session !== null &&
    (session.status === "ready" || session.status === "busy");
  const hasRunningTask = hasNonTerminalTask(tasks, taskEvents);
  const canUseComposer =
    profile !== null &&
    isSessionReady &&
    !isLoading &&
    listError === null &&
    !isSubmitting;
  const canSend =
    canUseComposer &&
    !hasRunningTask &&
    draft.trim() !== "" &&
    draft.trim().length <= MAX_GOAL_LENGTH;

  const handleSelectTask = (taskId: string): void => {
    selectedTaskIdRef.current = taskId;
    setSelectedTaskId(taskId);
  };

  const handleSubmit = async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();

    if (session === null || submitPendingRef.current || !canSend) {
      return;
    }

    const goal = draft.trim();
    const stored = draftKeyRef.current;
    const entry: DraftKey =
      stored !== null && stored.goal === goal
        ? stored
        : { goal, key: createIdempotencyKey() };
    draftKeyRef.current = entry;

    submitPendingRef.current = true;
    setIsSubmitting(true);
    setSubmitError(null);

    try {
      const response = await runtime.run(TASK_CREATE_TIMEOUT_MS, (client) =>
        client.tasks.create(
          session.id,
          { goal },
          { idempotencyKey: entry.key },
        ),
      );

      if (!isMountedRef.current) {
        return;
      }

      draftKeyRef.current = null;
      setDraft("");
      setTasks((current) => upsertTask(current, response.data));
      selectedTaskIdRef.current = response.data.id;
      setSelectedTaskId(response.data.id);
      setSubmitError(null);
    } catch (error: unknown) {
      if (!isMountedRef.current || isAbortError(error)) {
        return;
      }

      setSubmitError(toDisplayError(error));

      if (
        !(error instanceof ArgusApiError) ||
        (error.status !== 0 && error.status < 500)
      ) {
        return;
      }

      try {
        const response = await runtime.run(TASK_LIST_TIMEOUT_MS, (client) =>
          client.tasks.list({ sessionId: session.id, page_size: 100 }),
        );

        if (!isMountedRef.current) {
          return;
        }

        const ordered = sortTasksChronologically(response.data);
        const previous = selectedTaskIdRef.current;
        const nextSelected =
          previous !== null && ordered.some((task) => task.id === previous)
            ? previous
            : (ordered[ordered.length - 1]?.id ?? null);

        selectedTaskIdRef.current = nextSelected;
        setSelectedTaskId(nextSelected);
        setTasks(ordered);
      } catch (refreshError: unknown) {
        if (isMountedRef.current && !isAbortError(refreshError)) {
          console.error("Task list refresh after create failure failed:", refreshError);
        }
      }
    } finally {
      submitPendingRef.current = false;
      if (isMountedRef.current) {
        setIsSubmitting(false);
      }
    }
  };

  const handleCancel = async (taskId: string): Promise<void> => {
    if (cancelPendingRef.current) {
      return;
    }

    cancelPendingRef.current = true;
    setCancelPendingTaskId(taskId);
    setCancelError(null);

    try {
      const response = await runtime.run(TASK_CANCEL_TIMEOUT_MS, (client) =>
        client.tasks.cancel(taskId),
      );

      if (isMountedRef.current) {
        setTasks((current) => upsertTask(current, response.data));
      }
    } catch (error: unknown) {
      if (!isMountedRef.current || isAbortError(error)) {
        return;
      }

      setCancelError({ taskId, message: toDisplayError(error) });

      try {
        const refreshed = await runtime.run(TASK_READ_TIMEOUT_MS, (client) =>
          client.tasks.get(taskId),
        );

        if (isMountedRef.current) {
          setTasks((current) => upsertTask(current, refreshed.data));
        }
      } catch (refreshError: unknown) {
        if (isMountedRef.current && !isAbortError(refreshError)) {
          console.error("Task refresh after cancel failed:", refreshError);
        }
      }
    } finally {
      cancelPendingRef.current = false;
      if (isMountedRef.current) {
        setCancelPendingTaskId(null);
      }
    }
  };

  if (profile === null) {
    return (
      <section className="empty-state" aria-labelledby="workspace-heading">
        <h2 className="empty-state-heading" id="workspace-heading">
          {texts.taskChat.heading}
        </h2>
        <p className="empty-state-body">{texts.taskChat.noProfile}</p>
      </section>
    );
  }

  if (session === null) {
    return (
      <section className="empty-state" aria-labelledby="workspace-heading">
        <h2 className="empty-state-heading" id="workspace-heading">
          {texts.taskChat.heading}
        </h2>
        <p className="empty-state-body">{texts.taskChat.noSession}</p>
      </section>
    );
  }

  return (
    <div className="workspace-grid">
      <section className="panel chat-panel" aria-labelledby="workspace-heading">
        <h2 className="panel-heading" id="workspace-heading">
          {texts.taskChat.heading}
        </h2>

        {isLoading ? (
          <p className="panel-note" role="status" aria-live="polite">
            {texts.taskChat.loading}
          </p>
        ) : null}

        {listError === null ? null : (
          <>
            <p className="form-error" role="alert">
              {listError}
            </p>
            <button
              className="button"
              type="button"
              onClick={() => setReloadKey((key) => key + 1)}
              disabled={isLoading}
            >
              {texts.taskChat.retry}
            </button>
          </>
        )}

        {!isLoading && listError === null && tasks.length === 0 ? (
          <p className="panel-note">{texts.taskChat.empty}</p>
        ) : null}

        {tasks.length === 0 ? null : (
          <ol className="chat-list">
            {tasks.map((task) => {
              const overlay = taskEvents.get(task.id);
              const status = effectiveTaskStatus(task.status, overlay?.status);
              const steps = stepsByTask[task.id] ?? [];
              const isSelected = task.id === selectedTaskId;
              const isCancellable = !isTerminalTaskStatus(status);
              const isCancelPending = cancelPendingTaskId === task.id;

              return (
                <li
                  className="chat-task"
                  key={task.id}
                  data-selected={isSelected}
                  data-status={status}
                >
                  <button
                    className="chat-task-select"
                    type="button"
                    onClick={() => handleSelectTask(task.id)}
                    aria-pressed={isSelected}
                    aria-label={texts.taskChat.selectTask(task.goal)}
                  >
                    <span className="chat-speaker">
                      {texts.taskChat.operatorLabel}
                    </span>
                    <span className="chat-goal">{task.goal}</span>
                  </button>

                  <div className="chat-agent">
                    <div className="chat-agent-head">
                      <span className="chat-speaker">
                        {texts.taskChat.agentLabel}
                      </span>
                      <span className="chat-status" data-status={status}>
                        {taskStatusLabel(status)}
                      </span>
                    </div>
                    <p className="chat-reply">
                      {selectAgentReply({ status, overlay, steps })}
                    </p>
                  </div>

                  {isCancellable ? (
                    <div className="chat-task-actions">
                      <button
                        className="button button-quiet"
                        type="button"
                        onClick={() => void handleCancel(task.id)}
                        disabled={cancelPendingTaskId !== null}
                      >
                        {isCancelPending
                          ? texts.taskChat.cancelling
                          : texts.taskChat.cancel}
                      </button>
                    </div>
                  ) : null}

                  {cancelError !== null && cancelError.taskId === task.id ? (
                    <p className="form-error" role="alert">
                      {cancelError.message}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}

        <form
          className="chat-composer"
          onSubmit={(event) => void handleSubmit(event)}
        >
          <label className="field-label" htmlFor="task-goal">
            {texts.taskChat.goalLabel}
          </label>
          <textarea
            id="task-goal"
            className="input chat-textarea"
            value={draft}
            rows={3}
            maxLength={MAX_GOAL_LENGTH}
            placeholder={texts.taskChat.goalPlaceholder}
            onChange={(event) => setDraft(event.target.value)}
            disabled={!canUseComposer || hasRunningTask}
          />
          <div className="chat-composer-meta">
            <span className="chat-counter">
              {texts.taskChat.characterCount(draft.length)}
            </span>
            <button
              className="button button-primary"
              type="submit"
              disabled={!canSend}
            >
              {isSubmitting ? texts.taskChat.sending : texts.taskChat.send}
            </button>
          </div>
          {hasRunningTask ? (
            <p className="panel-note">{texts.taskChat.blocked}</p>
          ) : null}
          {submitError === null ? null : (
            <p className="form-error" role="alert">
              {submitError}
            </p>
          )}
        </form>
      </section>

      <TaskStatusPanel
        runtime={runtime}
        profile={profile}
        session={session}
        task={selectedTask ?? null}
        status={selectedStatus ?? null}
        steps={selectedTask === undefined ? [] : (stepsByTask[selectedTask.id] ?? [])}
        overlayStep={
          selectedTask === undefined
            ? undefined
            : taskEvents.get(selectedTask.id)?.lastStep
        }
      />
    </div>
  );
}
