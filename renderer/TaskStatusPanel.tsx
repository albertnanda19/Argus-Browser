import { useEffect, useRef, useState } from "react";
import type { AgentStep } from "../shared/agent-step";
import type { Profile } from "../shared/profile";
import type { Session } from "../shared/session";
import type { Task, TaskStatus } from "../shared/task";
import type { ArgusRuntime } from "./api-runtime";
import { isAbortError } from "./cockpit-state";
import {
  formatStepDuration,
  sanitizePageUrl,
  selectCurrentStep,
  shouldPollThumbnail,
} from "./task-panel-state";
import {
  formatStepAction,
  taskStatusLabel,
  type TaskLastStep,
} from "./task-chat-state";
import { texts } from "./texts";

const THUMBNAIL_TIMEOUT_MS = 5000;
const THUMBNAIL_POLL_INTERVAL_MS = 2000;

type TaskStatusPanelProps = {
  readonly runtime: ArgusRuntime;
  readonly profile: Profile;
  readonly session: Session;
  readonly task: Task | null;
  readonly status: TaskStatus | null;
  readonly steps: readonly AgentStep[];
  readonly overlayStep: TaskLastStep | undefined;
};

type TaskThumbnailProps = {
  readonly runtime: ArgusRuntime;
  readonly session: Session;
  readonly profileName: string;
};

function TaskThumbnail({ runtime, session, profileName }: TaskThumbnailProps) {
  const [imageSource, setImageSource] = useState<string | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (session.status !== "ready" && session.status !== "busy") {
      setImageSource(null);
      return;
    }

    let isDisposed = false;
    let isCapturing = false;
    let captureWhenFree = false;
    let hasLoggedFailure = false;
    let timer: number | null = null;
    let controller: AbortController | null = null;

    const clearTimer = (): void => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };

    const replaceImage = (next: string | null): void => {
      const previous = objectUrlRef.current;
      objectUrlRef.current = next;

      if (previous !== null) {
        URL.revokeObjectURL(previous);
      }

      setImageSource(next);
    };

    const schedule = (): void => {
      clearTimer();

      if (
        isDisposed ||
        !shouldPollThumbnail(session.status, document.visibilityState)
      ) {
        return;
      }

      timer = window.setTimeout(() => {
        void capture();
      }, THUMBNAIL_POLL_INTERVAL_MS);
    };

    const capture = async (): Promise<void> => {
      if (isDisposed || isCapturing) {
        return;
      }

      if (!shouldPollThumbnail(session.status, document.visibilityState)) {
        return;
      }

      isCapturing = true;
      timer = null;
      const activeController = new AbortController();
      controller = activeController;
      let blob: Blob | null = null;

      try {
        blob = await runtime.run(THUMBNAIL_TIMEOUT_MS, (client) =>
          client.sessions.thumbnail(session.id, {
            signal: activeController.signal,
          }),
        );
        hasLoggedFailure = false;
      } catch (error: unknown) {
        if (
          !isDisposed &&
          !activeController.signal.aborted &&
          !isAbortError(error) &&
          !hasLoggedFailure
        ) {
          hasLoggedFailure = true;
          console.error("Thumbnail capture failed.");
        }
      } finally {
        activeController.abort();
        controller = null;
        isCapturing = false;
      }

      if (isDisposed) {
        return;
      }

      replaceImage(blob === null ? null : URL.createObjectURL(blob));

      if (captureWhenFree) {
        captureWhenFree = false;
        void capture();
        return;
      }

      schedule();
    };

    const handleVisibilityChange = (): void => {
      if (isDisposed) {
        return;
      }

      clearTimer();

      if (
        !shouldPollThumbnail(session.status, document.visibilityState)
      ) {
        return;
      }

      if (isCapturing) {
        captureWhenFree = true;
        return;
      }

      void capture();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    if (shouldPollThumbnail(session.status, document.visibilityState)) {
      void capture();
    }

    return () => {
      isDisposed = true;
      clearTimer();
      controller?.abort();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      replaceImage(null);
    };
  }, [runtime, session.id, session.status]);

  return (
    <div className="status-thumbnail">
      {imageSource === null ? (
        <p className="panel-note" role="status">
          {texts.taskStatus.thumbnailUnavailable}
        </p>
      ) : (
        <img
          src={imageSource}
          alt={texts.taskStatus.thumbnailAlt(profileName)}
        />
      )}
    </div>
  );
}

export function TaskStatusPanel({
  runtime,
  profile,
  session,
  task,
  status,
  steps,
  overlayStep,
}: TaskStatusPanelProps) {
  const currentStep = selectCurrentStep(steps, overlayStep);
  const pageUrl =
    currentStep === null ? null : sanitizePageUrl(currentStep.url);
  const hasTarget =
    currentStep !== null && currentStep.target.trim() !== "";

  return (
    <section
      className="panel status-panel"
      aria-labelledby="status-panel-heading"
    >
      <h2 className="panel-heading" id="status-panel-heading">
        {texts.taskStatus.heading}
      </h2>

      <div className="status-block" aria-live="polite">
        {task === null || status === null ? (
          <p className="panel-note">{texts.taskStatus.noTask}</p>
        ) : (
          <>
            <div className="status-field">
              <span className="status-label">
                {texts.taskStatus.statusLabel}
              </span>
              <span className="chat-status" data-status={status}>
                {taskStatusLabel(status)}
              </span>
            </div>
            <div className="status-field">
              <span className="status-label">
                {texts.taskStatus.goalLabel}
              </span>
              <p className="status-goal">{task.goal}</p>
            </div>
          </>
        )}
      </div>

      <div className="status-section" aria-live="polite">
        <h3 className="status-subheading">{texts.taskStatus.stepHeading}</h3>
        {currentStep === null ? (
          <p className="panel-note">{texts.taskStatus.noStep}</p>
        ) : (
          <dl className="status-facts">
            <dt>{texts.taskStatus.stepIndexLabel}</dt>
            <dd>{currentStep.index}</dd>
            <dt>{texts.taskStatus.actionLabel}</dt>
            <dd>{formatStepAction(currentStep.action)}</dd>
            {hasTarget ? (
              <>
                <dt>{texts.taskStatus.targetLabel}</dt>
                <dd>{currentStep.target}</dd>
              </>
            ) : null}
            <dt>{texts.taskStatus.stepStatusLabel}</dt>
            <dd>
              <span className="chat-status" data-status={currentStep.status}>
                {texts.taskChat.step.status[currentStep.status]}
              </span>
            </dd>
            {currentStep.durationMs === null ? null : (
              <>
                <dt>{texts.taskStatus.durationLabel}</dt>
                <dd>{formatStepDuration(currentStep.durationMs)}</dd>
              </>
            )}
          </dl>
        )}
      </div>

      <div className="status-section" aria-live="polite">
        <h3 className="status-subheading">{texts.taskStatus.pageHeading}</h3>
        <p className="status-url">{pageUrl ?? texts.taskStatus.noPage}</p>
      </div>

      <div className="status-section">
        <h3 className="status-subheading">
          {texts.taskStatus.thumbnailHeading}
        </h3>
        <TaskThumbnail
          runtime={runtime}
          session={session}
          profileName={profile.name}
        />
      </div>
    </section>
  );
}
