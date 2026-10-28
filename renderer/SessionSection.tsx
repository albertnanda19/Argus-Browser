import { useEffect, useRef, useState } from "react";
import { ArgusApiError } from "../shared/client";
import type { Profile } from "../shared/profile";
import type { Session } from "../shared/session";
import type { ArgusRuntime } from "./api-runtime";
import {
  findActiveSession,
  isAbortError,
  isSessionActive,
  nextSessionPollDelay,
  shortSessionId,
  toDisplayError,
} from "./cockpit-state";
import { texts } from "./texts";

const SESSION_READ_TIMEOUT_MS = 5000;
const SESSION_START_TIMEOUT_MS = 60000;
const SESSION_CLOSE_TIMEOUT_MS = 10000;

type SessionSectionProps = {
  readonly runtime: ArgusRuntime;
  readonly profile: Profile | null;
  readonly onActiveSessionChange: (session: Session | null) => void;
};

type PendingAction = "start" | "close" | null;

async function fetchActiveSession(
  runtime: ArgusRuntime,
  profileId: string,
): Promise<Session | null> {
  const response = await runtime.run(SESSION_READ_TIMEOUT_MS, (client) =>
    client.sessions.list({ page_size: 100 }),
  );

  return findActiveSession(response.data, profileId);
}

export function SessionSection({
  runtime,
  profile,
  onActiveSessionChange,
}: SessionSectionProps) {
  const profileId = profile?.id ?? null;
  const [session, setSession] = useState<Session | null>(null);
  const [isLoading, setIsLoading] = useState(profile !== null);
  const [pending, setPending] = useState<PendingAction>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const pendingRef = useRef(false);
  const isMountedRef = useRef(true);
  const versionRef = useRef(0);
  const onActiveSessionChangeRef = useRef(onActiveSessionChange);

  useEffect(() => {
    onActiveSessionChangeRef.current = onActiveSessionChange;
  }, [onActiveSessionChange]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const active =
      session !== null && session.profileId === profileId ? session : null;
    onActiveSessionChange(active);
  }, [session, profileId, onActiveSessionChange]);

  useEffect(
    () => () => {
      onActiveSessionChangeRef.current(null);
    },
    [],
  );

  useEffect(() => {
    if (profileId === null) {
      setSession(null);
      setError(null);
      setIsLoading(false);
      return;
    }

    let isActive = true;
    const version = versionRef.current;
    setSession(null);
    setError(null);
    setIsLoading(true);

    fetchActiveSession(runtime, profileId)
      .then((next) => {
        if (isActive && versionRef.current === version) {
          setSession(next);
        }
      })
      .catch((error: unknown) => {
        if (
          isActive &&
          versionRef.current === version &&
          !isAbortError(error)
        ) {
          setError(toDisplayError(error));
        }
      })
      .finally(() => {
        if (isActive) {
          setIsLoading(false);
        }
      });

    return () => {
      isActive = false;
    };
  }, [runtime, profileId, reloadKey]);

  useEffect(() => {
    if (session === null) {
      return;
    }

    const delay = nextSessionPollDelay(session.status);

    if (delay === null) {
      return;
    }

    let isActive = true;
    const version = versionRef.current;
    const timer = setTimeout(() => {
      runtime
        .run(SESSION_READ_TIMEOUT_MS, (client) =>
          client.sessions.get(session.id),
        )
        .then((response) => {
          if (
            isActive &&
            isMountedRef.current &&
            versionRef.current === version
          ) {
            setSession(response.data);
          }
        })
        .catch((error: unknown) => {
          if (
            isActive &&
            isMountedRef.current &&
            versionRef.current === version &&
            !isAbortError(error)
          ) {
            setError(toDisplayError(error));
          }
        });
    }, delay);

    return () => {
      isActive = false;
      clearTimeout(timer);
    };
  }, [runtime, session]);

  const handleStart = async (): Promise<void> => {
    if (profileId === null || pendingRef.current) {
      return;
    }

    pendingRef.current = true;
    versionRef.current += 1;
    setPending("start");
    setError(null);

    try {
      const response = await runtime.run(SESSION_START_TIMEOUT_MS, (client) =>
        client.sessions.start({ profileId }),
      );

      if (isMountedRef.current) {
        setSession(response.data);
      }
    } catch (error: unknown) {
      if (!isMountedRef.current) {
        return;
      }

      if (error instanceof ArgusApiError && error.status === 409) {
        let existing: Session | null;

        try {
          existing = await fetchActiveSession(runtime, profileId);
        } catch (reloadError: unknown) {
          if (isMountedRef.current && !isAbortError(reloadError)) {
            setError(toDisplayError(reloadError));
          }
          return;
        }

        if (!isMountedRef.current) {
          return;
        }

        if (existing === null) {
          setError(error.message);
        } else {
          setSession(existing);
        }
      } else if (!isAbortError(error)) {
        setError(toDisplayError(error));
      }
    } finally {
      pendingRef.current = false;
      if (isMountedRef.current) {
        setPending(null);
      }
    }
  };

  const handleClose = async (): Promise<void> => {
    if (session === null || pendingRef.current) {
      return;
    }

    const sessionId = session.id;
    pendingRef.current = true;
    versionRef.current += 1;
    setPending("close");
    setError(null);

    try {
      await runtime.run(SESSION_CLOSE_TIMEOUT_MS, (client) =>
        client.sessions.close(sessionId),
      );

      if (isMountedRef.current) {
        setSession(null);
      }
    } catch (error: unknown) {
      if (isMountedRef.current && !isAbortError(error)) {
        setError(toDisplayError(error));
      }
    } finally {
      pendingRef.current = false;
      if (isMountedRef.current) {
        setPending(null);
      }
    }
  };

  const hasActiveSession = session !== null && isSessionActive(session.status);

  return (
    <section
      className="panel"
      aria-labelledby="sessions-heading"
      aria-busy={isLoading || pending !== null}
    >
      <h2 className="panel-heading" id="sessions-heading">
        {texts.sessions.heading}
      </h2>

      {profile === null ? (
        <p className="panel-note">{texts.sessions.selectProfile}</p>
      ) : (
        <>
          {isLoading ? (
            <p className="panel-note" role="status" aria-live="polite">
              {texts.sessions.loading}
            </p>
          ) : null}

          {error === null ? null : (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}

          {session === null
            ? !isLoading &&
              error === null && (
                <p className="panel-note">{texts.sessions.empty}</p>
              )
            : (
                <div className="session-card" data-status={session.status}>
                  <p className="session-profile">
                    {texts.sessions.profile(profile.name)}
                  </p>
                  <p className="session-id">
                    {texts.sessions.id(shortSessionId(session.id))}
                  </p>
                  <p
                    className="session-status"
                    data-status={session.status}
                    role="status"
                    aria-live="polite"
                  >
                    {texts.sessions.status[session.status]}
                  </p>
                </div>
              )}

          <div className="session-actions">
            {hasActiveSession ? (
              <button
                className="button"
                type="button"
                onClick={() => void handleClose()}
                disabled={pending !== null}
              >
                {pending === "close"
                  ? texts.sessions.closing
                  : texts.sessions.close}
              </button>
            ) : (
              <button
                className="button button-primary"
                type="button"
                onClick={() => void handleStart()}
                disabled={pending !== null || isLoading}
              >
                {pending === "start"
                  ? texts.sessions.starting
                  : texts.sessions.start}
              </button>
            )}

            {error !== null && !isLoading ? (
              <button
                className="button"
                type="button"
                onClick={() => setReloadKey((key) => key + 1)}
                disabled={pending !== null}
              >
                {texts.sessions.retry}
              </button>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}
