import { useCallback, useEffect, useRef, useState } from "react";
import type { Task } from "../shared/task";
import type { ArgusRuntime } from "./api-runtime";
import { isAbortError, shortSessionId, toDisplayError } from "./cockpit-state";
import {
  TASK_HISTORY_FILTERS,
  TASK_HISTORY_PAGE_SIZE,
  TASK_HISTORY_REFRESH_DEBOUNCE_MS,
  TASK_HISTORY_TICK_INTERVAL_MS,
  filterHistoryTasks,
  formatHistoryCreatedAt,
  formatHistoryDuration,
  hasHistoryRefreshTrigger,
  historyDurationMs,
  historyFilterLabel,
  mergeHistoryPages,
  type TaskHistoryFilter,
} from "./task-history-state";
import {
  effectiveTaskStatus,
  hasNonTerminalTask,
  taskStatusLabel,
  type TaskEventOverlay,
} from "./task-chat-state";
import { texts } from "./texts";

const TASK_LIST_TIMEOUT_MS = 5000;

type TaskHistoryPanelProps = {
  readonly runtime: ArgusRuntime;
  readonly taskEvents: ReadonlyMap<string, TaskEventOverlay>;
  readonly reconnectVersion: number;
};

export function TaskHistoryPanel({
  runtime,
  taskEvents,
  reconnectVersion,
}: TaskHistoryPanelProps) {
  const [tasks, setTasks] = useState<readonly Task[]>([]);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState<TaskHistoryFilter>("all");
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const tasksRef = useRef<readonly Task[]>([]);
  const nextPageRef = useRef(1);
  const sequenceRef = useRef(0);
  const isLoadingMoreRef = useRef(false);
  const isMountedRef = useRef(true);
  const previousOverlaysRef = useRef(taskEvents);
  const refreshTimerRef = useRef<number | null>(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let isActive = true;
    const sequence = sequenceRef.current + 1;
    sequenceRef.current = sequence;
    setIsLoading(true);

    runtime
      .run(TASK_LIST_TIMEOUT_MS, (client) =>
        client.tasks.list({
          page: 1,
          page_size: TASK_HISTORY_PAGE_SIZE,
          ...(filter === "all" ? {} : { status: filter }),
        }),
      )
      .then((response) => {
        if (!isActive || sequence !== sequenceRef.current) {
          return;
        }

        const merged = mergeHistoryPages(tasksRef.current, response.data);
        tasksRef.current = merged;
        nextPageRef.current = Math.max(nextPageRef.current, 2);
        setTasks(merged);
        setTotal(Math.max(response.total, merged.length));
        setError(null);
      })
      .catch((loadError: unknown) => {
        if (
          !isActive ||
          sequence !== sequenceRef.current ||
          isAbortError(loadError)
        ) {
          return;
        }

        console.error("Task history load failed:", loadError);
        setError(toDisplayError(loadError));
      })
      .finally(() => {
        if (isActive && sequence === sequenceRef.current) {
          setIsLoading(false);
        }
      });

    return () => {
      isActive = false;
    };
  }, [runtime, filter, reconnectVersion, reloadKey]);

  const scheduleRefresh = useCallback((): void => {
    if (refreshTimerRef.current !== null) {
      window.clearTimeout(refreshTimerRef.current);
    }

    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null;

      if (isMountedRef.current) {
        setReloadKey((current) => current + 1);
      }
    }, TASK_HISTORY_REFRESH_DEBOUNCE_MS);
  }, []);

  useEffect(() => {
    const previous = previousOverlaysRef.current;
    previousOverlaysRef.current = taskEvents;

    if (hasHistoryRefreshTrigger(previous, taskEvents, tasksRef.current)) {
      scheduleRefresh();
    }
  }, [taskEvents, scheduleRefresh]);

  useEffect(() => {
    const handleVisibilityChange = (): void => {
      if (document.visibilityState === "visible") {
        scheduleRefresh();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [scheduleRefresh]);

  useEffect(
    () => () => {
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
      }
    },
    [],
  );

  const visibleTasks = filterHistoryTasks(tasks, taskEvents, filter);
  const hasLiveTasks = hasNonTerminalTask(visibleTasks, taskEvents);

  useEffect(() => {
    if (!hasLiveTasks) {
      return;
    }

    let interval: number | null = null;

    const stop = (): void => {
      if (interval !== null) {
        window.clearInterval(interval);
        interval = null;
      }
    };

    const start = (): void => {
      if (interval !== null) {
        return;
      }

      setNowMs(Date.now());
      interval = window.setInterval(() => {
        setNowMs(Date.now());
      }, TASK_HISTORY_TICK_INTERVAL_MS);
    };

    const handleVisibilityChange = (): void => {
      if (document.visibilityState === "visible") {
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === "visible") {
      start();
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [hasLiveTasks]);

  const handleFilterChange = (next: TaskHistoryFilter): void => {
    if (next === filter) {
      return;
    }

    sequenceRef.current += 1;
    nextPageRef.current = 1;
    isLoadingMoreRef.current = false;
    tasksRef.current = [];
    setTasks([]);
    setTotal(0);
    setError(null);
    setIsLoading(true);
    setIsLoadingMore(false);
    setFilter(next);
  };

  const handleLoadMore = async (): Promise<void> => {
    if (isLoadingMoreRef.current || isLoading) {
      return;
    }

    const sequence = sequenceRef.current;
    const page = nextPageRef.current;
    isLoadingMoreRef.current = true;
    setIsLoadingMore(true);

    try {
      const response = await runtime.run(TASK_LIST_TIMEOUT_MS, (client) =>
        client.tasks.list({
          page,
          page_size: TASK_HISTORY_PAGE_SIZE,
          ...(filter === "all" ? {} : { status: filter }),
        }),
      );

      if (!isMountedRef.current || sequence !== sequenceRef.current) {
        return;
      }

      const merged = mergeHistoryPages(tasksRef.current, response.data);
      tasksRef.current = merged;
      nextPageRef.current = page + 1;
      setTasks(merged);
      setTotal(Math.max(response.total, merged.length));
      setError(null);
    } catch (loadError: unknown) {
      if (
        !isMountedRef.current ||
        sequence !== sequenceRef.current ||
        isAbortError(loadError)
      ) {
        return;
      }

      console.error("Task history page load failed:", loadError);
      setError(toDisplayError(loadError));
    } finally {
      isLoadingMoreRef.current = false;

      if (isMountedRef.current) {
        setIsLoadingMore(false);
      }
    }
  };

  const isBusy = isLoading || isLoadingMore;
  const isEmpty = !isLoading && error === null && visibleTasks.length === 0;

  return (
    <section
      className="panel history-panel"
      aria-labelledby="history-heading"
      aria-busy={isBusy}
    >
      <div className="history-header">
        <h2 className="panel-heading" id="history-heading">
          {texts.taskHistory.heading}
        </h2>
        <button
          className="button button-quiet"
          type="button"
          onClick={() => setReloadKey((current) => current + 1)}
          disabled={isBusy}
        >
          {texts.taskHistory.reload}
        </button>
      </div>

      <div className="history-filter">
        <label className="field-label" htmlFor="history-status-filter">
          {texts.taskHistory.filterLabel}
        </label>
        <select
          id="history-status-filter"
          className="input history-select"
          value={filter}
          onChange={(event) => {
            const next = TASK_HISTORY_FILTERS.find(
              (item) => item === event.target.value,
            );

            if (next !== undefined) {
              handleFilterChange(next);
            }
          }}
        >
          {TASK_HISTORY_FILTERS.map((value) => (
            <option key={value} value={value}>
              {historyFilterLabel(value)}
            </option>
          ))}
        </select>
      </div>

      {isLoading && tasks.length === 0 ? (
        <p className="panel-note" role="status" aria-live="polite">
          {texts.taskHistory.loading}
        </p>
      ) : null}

      {error === null ? null : (
        <>
          <p className="form-error" role="alert">
            {error}
          </p>
          <button
            className="button"
            type="button"
            onClick={() => setReloadKey((current) => current + 1)}
            disabled={isBusy}
          >
            {texts.taskHistory.retry}
          </button>
        </>
      )}

      {isEmpty ? (
        <p className="panel-note">
          {filter === "all"
            ? texts.taskHistory.empty
            : texts.taskHistory.emptyFiltered}
        </p>
      ) : null}

      {visibleTasks.length === 0 ? null : (
        <ol
          className="history-list"
          tabIndex={0}
          aria-label={texts.taskHistory.listLabel}
        >
          {visibleTasks.map((task) => {
            const status = effectiveTaskStatus(
              task.status,
              taskEvents.get(task.id)?.status,
            );
            const duration = formatHistoryDuration(
              historyDurationMs(task, status, nowMs),
            );

            return (
              <li className="history-item" key={task.id} data-status={status}>
                <p className="history-goal">{task.goal}</p>
                <div className="history-meta">
                  <span className="chat-status" data-status={status}>
                    {taskStatusLabel(status)}
                  </span>
                  <span className="history-duration">
                    {texts.taskHistory.durationLabel(duration)}
                  </span>
                </div>
                <div className="history-footer">
                  <span className="history-created">
                    {texts.taskHistory.createdLabel}{" "}
                    <time dateTime={task.createdAt}>
                      {formatHistoryCreatedAt(task.createdAt)}
                    </time>
                  </span>
                  <span className="history-session">
                    {texts.sessions.id(shortSessionId(task.sessionId))}
                  </span>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {tasks.length > 0 && tasks.length < total ? (
        <button
          className="button"
          type="button"
          onClick={() => void handleLoadMore()}
          disabled={isBusy}
        >
          {isLoadingMore
            ? texts.taskHistory.loadingMore
            : texts.taskHistory.loadMore}
        </button>
      ) : null}
    </section>
  );
}
