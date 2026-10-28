import type { Context } from "hono";
import { problemSchema, type Problem } from "../shared/contracts";
import { ActionError } from "./action-errors";
import { ProfileStoreError } from "./profile-store";
import { ProviderError } from "./provider-errors";
import { SessionError } from "./session-errors";
import { TaskError } from "./task-errors";

export type ProblemStatus = 400 | 401 | 404 | 409 | 422 | 500;

export const INTERNAL_ERROR_DETAIL = "Terjadi kesalahan internal.";

const TITLES: Record<ProblemStatus, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  404: "Not Found",
  409: "Conflict",
  422: "Unprocessable Content",
  500: "Internal Server Error",
};

export function problem(status: ProblemStatus, detail: string): Problem {
  return problemSchema.parse({
    type: "about:blank",
    title: TITLES[status],
    status,
    detail,
  });
}

export function problemResponse(c: Context, status: ProblemStatus, detail: string): Response {
  return c.body(JSON.stringify(problem(status, detail)), status, {
    "Content-Type": "application/problem+json",
  });
}

export function knownProblem(
  error: unknown,
): { readonly status: ProblemStatus; readonly detail: string } | null {
  if (error instanceof ProfileStoreError) {
    if (error.code === "invalid_profile_name") {
      return { status: 400, detail: error.message };
    }
    if (error.code === "profile_not_found") {
      return { status: 404, detail: error.message };
    }
    return { status: 422, detail: error.message };
  }

  if (error instanceof SessionError) {
    switch (error.code) {
      case "session_profile_not_found":
      case "session_not_found":
        return { status: 404, detail: error.message };
      case "session_profile_corrupt":
      case "session_chrome_not_ready":
        return { status: 422, detail: error.message };
      case "session_conflict":
        return { status: 409, detail: error.message };
      case "session_launch_failed":
      case "session_close_failed":
        return { status: 500, detail: error.message };
    }
  }

  if (error instanceof TaskError) {
    switch (error.code) {
      case "task_session_not_found":
      case "task_not_found":
        return { status: 404, detail: error.message };
      case "task_session_not_ready":
      case "task_idempotency_conflict":
      case "task_not_cancellable":
      case "task_not_waiting_approval":
      case "task_not_research":
      case "task_invalid_transition":
        return { status: 409, detail: error.message };
    }
  }

  if (error instanceof ActionError) {
    switch (error.code) {
      case "action_session_not_found":
      case "action_task_not_found":
        return { status: 404, detail: error.message };
      case "action_session_not_ready":
      case "action_task_not_running":
        return { status: 409, detail: error.message };
      case "action_navigation_failed":
      case "action_target_not_found":
      case "action_failed":
        return { status: 422, detail: error.message };
    }
  }

  if (error instanceof ProviderError) {
    if (error.code === "provider_api_key_required") {
      return { status: 400, detail: error.message };
    }
    return { status: 422, detail: error.message };
  }

  return null;
}

export function handleKnownError(c: Context, error: unknown): Response {
  const known = knownProblem(error);
  if (known === null) {
    throw error;
  }
  return problemResponse(c, known.status, known.detail);
}
