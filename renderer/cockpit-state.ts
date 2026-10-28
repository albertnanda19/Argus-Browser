import { ArgusApiError } from "../shared/client";
import type { Session, SessionStatus } from "../shared/session";
import { texts } from "./texts";

const SESSION_POLL_FAST_MS = 1000;
const SESSION_POLL_BUSY_MS = 2000;

const ACTIVE_SESSION_STATUSES: ReadonlySet<SessionStatus> = new Set([
  "starting",
  "ready",
  "busy",
  "closing",
]);

const lastUsedFormat = new Intl.DateTimeFormat("id-ID", {
  dateStyle: "medium",
  timeStyle: "short",
});

export function isSessionActive(status: SessionStatus): boolean {
  return ACTIVE_SESSION_STATUSES.has(status);
}

export function findActiveSession(
  sessions: readonly Session[],
  profileId: string,
): Session | null {
  return (
    sessions.find(
      (session) =>
        session.profileId === profileId && isSessionActive(session.status),
    ) ?? null
  );
}

export function nextSessionPollDelay(status: SessionStatus): number | null {
  switch (status) {
    case "starting":
    case "closing":
      return SESSION_POLL_FAST_MS;
    case "busy":
      return SESSION_POLL_BUSY_MS;
    case "ready":
    case "closed":
    case "error":
      return null;
  }
}

export function shortSessionId(id: string): string {
  return id.slice(0, 10);
}

export function formatLastUsedAt(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : lastUsedFormat.format(date);
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function toDisplayError(error: unknown): string {
  return error instanceof ArgusApiError ? error.message : texts.api.generic;
}
