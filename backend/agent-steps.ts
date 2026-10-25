import { randomBytes } from "node:crypto";

export type AgentStepStatus = "done" | "failed" | "blocked";

export type AgentStepVerification = {
  readonly stepOk: boolean;
  readonly goalComplete: boolean;
  readonly reason: string;
};

export type AgentStepResult = {
  readonly status: AgentStepStatus;
  readonly url: string;
  readonly pageChanged: boolean;
  readonly verification: AgentStepVerification | null;
};

export type AgentStep = {
  readonly id: string;
  readonly taskId: string;
  readonly index: number;
  readonly action: string;
  readonly target: string;
  readonly result: AgentStepResult;
  readonly durationMs: number;
};

export type AddAgentStepInput = {
  readonly taskId: string;
  readonly action: string;
  readonly target: string;
  readonly result: AgentStepResult;
  readonly durationMs: number;
};

export type AgentStepStore = {
  add(input: AddAgentStepInput): AgentStep;
  list(taskId: string): AgentStep[];
  last(taskId: string): AgentStep | null;
};

const TARGET_MAX_LENGTH = 300;

function createStepId(): string {
  return `st_${randomBytes(8).toString("hex")}`;
}

function cloneStep(step: AgentStep): AgentStep {
  return {
    ...step,
    result: {
      ...step.result,
      verification:
        step.result.verification === null ? null : { ...step.result.verification },
    },
  };
}

class AgentStepStoreImpl implements AgentStepStore {
  private readonly steps = new Map<string, AgentStep[]>();

  add(input: AddAgentStepInput): AgentStep {
    const existing = this.steps.get(input.taskId) ?? [];
    const step: AgentStep = {
      id: createStepId(),
      taskId: input.taskId,
      index: existing.length + 1,
      action: input.action,
      target: input.target.slice(0, TARGET_MAX_LENGTH),
      result: {
        ...input.result,
        verification:
          input.result.verification === null ? null : { ...input.result.verification },
      },
      durationMs: input.durationMs,
    };

    existing.push(step);
    this.steps.set(input.taskId, existing);
    return cloneStep(step);
  }

  list(taskId: string): AgentStep[] {
    return (this.steps.get(taskId) ?? []).map(cloneStep);
  }

  last(taskId: string): AgentStep | null {
    const step = this.steps.get(taskId)?.at(-1);
    return step === undefined ? null : cloneStep(step);
  }
}

export function createAgentStepStore(): AgentStepStore {
  return new AgentStepStoreImpl();
}
