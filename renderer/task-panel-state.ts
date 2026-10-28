import type { AgentStep, AgentStepStatus } from "../shared/agent-step";
import type { SessionStatus } from "../shared/session";
import type { TaskLastStep } from "./task-chat-state";

export type CurrentStep = {
  readonly index: number;
  readonly action: string;
  readonly target: string;
  readonly status: AgentStepStatus;
  readonly durationMs: number | null;
  readonly url: string;
};

function latestStep(steps: readonly AgentStep[]): AgentStep | null {
  let latest: AgentStep | null = null;

  for (const step of steps) {
    if (latest === null || step.index > latest.index) {
      latest = step;
    }
  }

  return latest;
}

export function selectCurrentStep(
  steps: readonly AgentStep[],
  overlayStep: TaskLastStep | undefined,
): CurrentStep | null {
  const cached = latestStep(steps);

  if (
    overlayStep !== undefined &&
    (cached === null || overlayStep.index >= cached.index)
  ) {
    return {
      index: overlayStep.index,
      action: overlayStep.action,
      target: overlayStep.target,
      status: overlayStep.status,
      durationMs:
        cached !== null && cached.index === overlayStep.index
          ? cached.durationMs
          : null,
      url: overlayStep.url,
    };
  }

  if (cached === null) {
    return null;
  }

  return {
    index: cached.index,
    action: cached.action,
    target: cached.target,
    status: cached.result.status,
    durationMs: cached.durationMs,
    url: cached.result.url,
  };
}

export function sanitizePageUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();

  if (trimmed === "") {
    return null;
  }

  let parsed: URL;

  try {
    parsed = new URL(trimmed);
  } catch {
    return trimmed;
  }

  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    return `${parsed.origin}${parsed.pathname}`;
  }

  parsed.search = "";
  parsed.hash = "";
  return parsed.href;
}

export function shouldPollThumbnail(
  status: SessionStatus | null,
  visibility: DocumentVisibilityState,
): boolean {
  return (
    (status === "ready" || status === "busy") && visibility === "visible"
  );
}

export function formatStepDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs} ms`;
  }

  const seconds = durationMs / 1000;

  return Number.isInteger(seconds)
    ? `${seconds} dtk`
    : `${seconds.toFixed(1).replace(".", ",")} dtk`;
}
