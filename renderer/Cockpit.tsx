import { useCallback, useEffect, useRef, useState } from "react";
import type { Profile } from "../shared/profile";
import type { Session } from "../shared/session";
import type { ArgusRuntime } from "./api-runtime";
import { ApprovalQueue } from "./ApprovalQueue";
import { BrowserSetupSection } from "./BrowserSetupSection";
import { isAbortError } from "./cockpit-state";
import { ProfileSection } from "./ProfileSection";
import { SessionSection } from "./SessionSection";
import {
  applyTaskEvent,
  clearOverlayStatuses,
  createEventIdDeduplicator,
  INITIAL_RECONNECT_DELAY_MS,
  nextReconnectDelay,
  type TaskEventOverlay,
} from "./task-chat-state";
import { TaskChat } from "./TaskChat";
import { texts } from "./texts";

type CockpitProps = {
  readonly runtime: ArgusRuntime | null;
  readonly isConnected: boolean;
};

function waitForReconnect(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    const handleAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(() => {
      signal.removeEventListener("abort", handleAbort);
      resolve();
    }, delayMs);

    signal.addEventListener("abort", handleAbort, { once: true });
  });
}

export function Cockpit({ runtime, isConnected }: CockpitProps) {
  const [selectedProfile, setSelectedProfile] = useState<Profile | null>(null);
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [isStreamDisconnected, setIsStreamDisconnected] = useState(false);
  const [taskEvents, setTaskEvents] = useState<
    ReadonlyMap<string, TaskEventOverlay>
  >(() => new Map());
  const [reconnectVersion, setReconnectVersion] = useState(0);
  const deduplicatorRef = useRef(createEventIdDeduplicator());
  const lastEventIdRef = useRef<string | undefined>(undefined);
  const hasConnectedRef = useRef(false);

  const handleActiveSessionChange = useCallback(
    (next: Session | null): void => {
      setActiveSession(next);
    },
    [],
  );

  const handleDeleted = (profileId: string): void => {
    setSelectedProfile((current) =>
      current !== null && current.id === profileId ? null : current,
    );
  };

  useEffect(() => {
    if (runtime === null || !isConnected) {
      setIsStreamDisconnected(false);
      return;
    }

    const controller = new AbortController();
    let isDisposed = false;
    let backoff = INITIAL_RECONNECT_DELAY_MS;

    const connect = async (): Promise<void> => {
      while (!isDisposed) {
        const isReconnect = hasConnectedRef.current;
        let hasReceivedInAttempt = false;

        try {
          for await (const entry of runtime.client.events.stream({
            lastEventId: lastEventIdRef.current,
            signal: controller.signal,
          })) {
            if (isDisposed) {
              return;
            }

            lastEventIdRef.current = entry.id;

            if (!hasReceivedInAttempt) {
              hasReceivedInAttempt = true;
              backoff = INITIAL_RECONNECT_DELAY_MS;
              setIsStreamDisconnected(false);
              hasConnectedRef.current = true;

              if (isReconnect) {
                setTaskEvents((current) => clearOverlayStatuses(current));
                setReconnectVersion((current) => current + 1);
              }
            }

            if (!deduplicatorRef.current.remember(entry.id)) {
              continue;
            }

            setTaskEvents((current) => applyTaskEvent(current, entry.event));
          }
        } catch (error: unknown) {
          if (
            isDisposed ||
            controller.signal.aborted ||
            isAbortError(error)
          ) {
            return;
          }

          console.error("Event stream disconnected:", error);
        }

        if (isDisposed || controller.signal.aborted) {
          return;
        }

        setIsStreamDisconnected(true);
        const delay = backoff;
        backoff = nextReconnectDelay(backoff);
        await waitForReconnect(delay, controller.signal);

        if (isDisposed || controller.signal.aborted) {
          return;
        }

        setIsStreamDisconnected(false);
      }
    };

    void connect();

    return () => {
      isDisposed = true;
      controller.abort();
    };
  }, [runtime, isConnected]);

  const sessionForProfile =
    activeSession !== null &&
    selectedProfile !== null &&
    activeSession.profileId === selectedProfile.id
      ? activeSession
      : null;

  return (
    <div className="cockpit">
      <aside className="sidebar" aria-label={texts.sidebar.label}>
        {runtime !== null && isConnected ? (
          <>
            <ProfileSection
              runtime={runtime}
              selectedProfileId={selectedProfile?.id ?? null}
              onSelect={setSelectedProfile}
              onDeleted={handleDeleted}
            />
            <SessionSection
              key={selectedProfile?.id ?? "none"}
              runtime={runtime}
              profile={selectedProfile}
              onActiveSessionChange={handleActiveSessionChange}
            />
            <BrowserSetupSection runtime={runtime} />
          </>
        ) : (
          <p className="panel-note">{texts.sidebar.unavailable}</p>
        )}
      </aside>

      <main className="workspace">
        {runtime !== null && isConnected ? (
          <>
            {isStreamDisconnected ? (
              <p className="connection-banner" role="status" aria-live="polite">
                {texts.taskChat.streamDisconnected}
              </p>
            ) : null}
            <ApprovalQueue
              runtime={runtime}
              taskEvents={taskEvents}
              reconnectVersion={reconnectVersion}
            />
            <TaskChat
              key={`${selectedProfile?.id ?? "none"}:${sessionForProfile?.id ?? "none"}`}
              runtime={runtime}
              profile={selectedProfile}
              session={sessionForProfile}
              taskEvents={taskEvents}
              reconnectVersion={reconnectVersion}
            />
          </>
        ) : (
          <section className="empty-state" aria-labelledby="workspace-heading">
            <h2 className="empty-state-heading" id="workspace-heading">
              {texts.workspace.heading}
            </h2>
            <p className="empty-state-body">{texts.workspace.body}</p>
          </section>
        )}
      </main>
    </div>
  );
}
