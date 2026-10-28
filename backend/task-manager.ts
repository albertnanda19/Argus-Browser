import { randomBytes } from "node:crypto";
import type { ApprovalDecisionRequest, CreateTaskRequest } from "../shared/api";
import {
  approvalRequestedEventSchema,
  taskCancelledEventSchema,
  taskCompletedEventSchema,
  taskFailedEventSchema,
} from "../shared/event";
import type { Session } from "../shared/session";
import {
  approvalSchema,
  taskSchema,
  type Approval,
  type JsonObject,
  type ResearchTarget,
  type TaskEntity,
  type TaskStatus,
} from "../shared/task";
import type { EventBus } from "./event-bus";
import { TaskError } from "./task-errors";

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
const CANCEL_REASON = "Task dibatalkan.";

const TERMINAL_STATUSES = new Set<TaskStatus>(["completed", "failed", "cancelled"]);
const CANCELLABLE_STATUSES = new Set<TaskStatus>(["queued", "running", "waiting_approval"]);

const TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  queued: new Set(["running", "cancelled"]),
  running: new Set(["waiting_approval", "completed", "failed", "cancelled"]),
  waiting_approval: new Set(["running", "cancelled"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

export type TaskSessionSource = {
  get(sessionId: string): Session | null;
};

export type ApprovalRequestInput = {
  readonly action: string;
  readonly payload: JsonObject;
  readonly target: string;
  readonly selector: string;
  readonly highlighted: boolean;
  readonly category: string;
};

export type ApprovalResult = {
  readonly task: TaskEntity;
  readonly approval: Approval;
};

export type TaskService = {
  createTask(sessionId: string, input: CreateTaskRequest, idempotencyKey: string): TaskEntity;
  getTask(taskId: string): TaskEntity | null;
  listBySession(sessionId: string): TaskEntity[];
  listTasks(): TaskEntity[];
  listApprovals(): Approval[];
  cancelTask(taskId: string): TaskEntity;
  startTask(taskId: string): TaskEntity;
  requestApproval(taskId: string, input: ApprovalRequestInput): Approval;
  resolveApproval(taskId: string, input: ApprovalDecisionRequest): ApprovalResult;
  completeTask(taskId: string, result: JsonObject): TaskEntity;
  failTask(taskId: string, reason: string): TaskEntity;
  getApproval(approvalId: string): Approval | null;
};

export type TaskManagerOptions = {
  readonly sessions: TaskSessionSource;
  readonly events: EventBus;
  readonly now?: () => Date;
};

type IdempotencyEntry = {
  readonly taskId: string;
  readonly fingerprint: string;
  readonly createdAtMs: number;
};

function createTaskId(): string {
  return `t_${randomBytes(8).toString("hex")}`;
}

function createApprovalId(): string {
  return `a_${randomBytes(8).toString("hex")}`;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const sortedEntries = Object.entries(value).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return Object.fromEntries(
      sortedEntries.map(([key, entryValue]) => [key, canonicalize(entryValue)]),
    );
  }
  return value;
}

function createFingerprint(sessionId: string, input: CreateTaskRequest): string {
  return JSON.stringify(
    canonicalize({
      sessionId,
      goal: input.goal,
      kind: input.kind ?? "agent",
      research: researchOf(input),
      outputSchema: input.outputSchema ?? null,
    }),
  );
}

function researchOf(input: CreateTaskRequest): ResearchTarget | null {
  if ((input.kind ?? "agent") !== "research" || input.research === undefined) {
    return null;
  }
  return {
    targetName: input.research.targetName,
    organization: input.research.organization ?? null,
  };
}

class TaskManagerImpl implements TaskService {
  private readonly sessions: TaskSessionSource;
  private readonly events: EventBus;
  private readonly now: () => Date;
  private readonly tasks = new Map<string, TaskEntity>();
  private readonly approvals = new Map<string, Approval>();
  private readonly pendingApprovals = new Map<string, string>();
  private readonly idempotency = new Map<string, IdempotencyEntry>();

  constructor(options: TaskManagerOptions) {
    this.sessions = options.sessions;
    this.events = options.events;
    this.now = options.now ?? (() => new Date());
  }

  createTask(sessionId: string, input: CreateTaskRequest, idempotencyKey: string): TaskEntity {
    const session = this.sessions.get(sessionId);
    if (session === null) {
      throw new TaskError("task_session_not_found");
    }
    if (session.status !== "ready") {
      throw new TaskError("task_session_not_ready");
    }

    const fingerprint = createFingerprint(sessionId, input);
    const existing = this.idempotency.get(idempotencyKey);

    if (existing !== undefined) {
      if (this.now().getTime() - existing.createdAtMs >= IDEMPOTENCY_TTL_MS) {
        this.idempotency.delete(idempotencyKey);
      } else if (existing.fingerprint !== fingerprint) {
        throw new TaskError("task_idempotency_conflict");
      } else {
        const task = this.tasks.get(existing.taskId);
        if (task !== undefined) {
          return { ...task };
        }
        this.idempotency.delete(idempotencyKey);
      }
    }

    const createdAt = this.now();
    const task = taskSchema.parse({
      id: createTaskId(),
      sessionId,
      goal: input.goal,
      kind: input.kind ?? "agent",
      research: researchOf(input),
      outputSchema: input.outputSchema ?? null,
      status: "queued",
      createdAt: createdAt.toISOString(),
      completedAt: null,
    });

    this.tasks.set(task.id, task);
    this.idempotency.set(idempotencyKey, {
      taskId: task.id,
      fingerprint,
      createdAtMs: createdAt.getTime(),
    });
    return { ...task };
  }

  getTask(taskId: string): TaskEntity | null {
    const task = this.tasks.get(taskId);
    return task === undefined ? null : { ...task };
  }

  listBySession(sessionId: string): TaskEntity[] {
    return [...this.tasks.values()]
      .filter((task) => task.sessionId === sessionId)
      .map((task) => ({ ...task }));
  }

  listTasks(): TaskEntity[] {
    return [...this.tasks.values()].map((task) => ({ ...task }));
  }

  listApprovals(): Approval[] {
    return [...this.approvals.values()].map((approval) => ({ ...approval }));
  }

  getApproval(approvalId: string): Approval | null {
    const approval = this.approvals.get(approvalId);
    return approval === undefined ? null : { ...approval };
  }

  startTask(taskId: string): TaskEntity {
    const task = this.requireTask(taskId);
    if (task.status !== "queued") {
      throw new TaskError("task_invalid_transition");
    }
    return this.applyTransition(taskId, "running");
  }

  requestApproval(taskId: string, input: ApprovalRequestInput): Approval {
    const at = this.now().toISOString();
    const approval = approvalSchema.parse({
      id: createApprovalId(),
      taskId,
      action: input.action,
      target: input.target,
      payload: input.payload,
      decision: "pending",
      requestedAt: at,
      decidedAt: null,
    });
    const event = approvalRequestedEventSchema.parse({
      type: "approval.requested",
      taskId,
      action: input.action,
      target: input.target,
      selector: input.selector,
      highlighted: input.highlighted,
      category: input.category,
      at,
    });

    this.applyTransition(taskId, "waiting_approval");
    this.approvals.set(approval.id, approval);
    this.pendingApprovals.set(taskId, approval.id);
    this.events.publish(event);
    return { ...approval };
  }

  resolveApproval(taskId: string, input: ApprovalDecisionRequest): ApprovalResult {
    const task = this.requireTask(taskId);
    if (task.status !== "waiting_approval") {
      throw new TaskError("task_not_waiting_approval");
    }

    const approvalId = this.pendingApprovals.get(taskId);
    const approval = approvalId === undefined ? undefined : this.approvals.get(approvalId);
    if (approvalId === undefined || approval === undefined) {
      throw new TaskError("task_not_waiting_approval");
    }

    const at = this.now().toISOString();
    const decision = input.approve ? "approved" : "rejected";
    const resolvedApproval = approvalSchema.parse({
      ...approval,
      decision,
      decidedAt: at,
    });
    this.approvals.set(approvalId, resolvedApproval);
    this.pendingApprovals.delete(taskId);

    if (input.approve) {
      const running = this.applyTransition(taskId, "running");
      return { task: running, approval: { ...resolvedApproval } };
    }

    const cancelled = this.applyTransition(taskId, "cancelled");
    this.publishCancelled(taskId, input.reason, this.completedAtOf(cancelled));
    return { task: cancelled, approval: { ...resolvedApproval } };
  }

  cancelTask(taskId: string): TaskEntity {
    const task = this.requireTask(taskId);
    if (!CANCELLABLE_STATUSES.has(task.status)) {
      throw new TaskError("task_not_cancellable");
    }

    const cancelled = this.applyTransition(taskId, "cancelled");
    const completedAt = this.completedAtOf(cancelled);
    this.rejectPendingApproval(taskId, completedAt);
    this.publishCancelled(taskId, CANCEL_REASON, completedAt);
    return cancelled;
  }

  completeTask(taskId: string, result: JsonObject): TaskEntity {
    const task = this.applyTransition(taskId, "completed");
    this.events.publish(
      taskCompletedEventSchema.parse({
        type: "task.completed",
        taskId,
        result,
        at: task.completedAt,
      }),
    );
    return task;
  }

  failTask(taskId: string, reason: string): TaskEntity {
    const task = this.applyTransition(taskId, "failed");
    this.events.publish(
      taskFailedEventSchema.parse({
        type: "task.failed",
        taskId,
        reason,
        at: task.completedAt,
      }),
    );
    return task;
  }

  private requireTask(taskId: string): TaskEntity {
    const task = this.tasks.get(taskId);
    if (task === undefined) {
      throw new TaskError("task_not_found");
    }
    return task;
  }

  private applyTransition(taskId: string, nextStatus: TaskStatus): TaskEntity {
    const task = this.requireTask(taskId);
    if (!TRANSITIONS[task.status].has(nextStatus)) {
      throw new TaskError("task_invalid_transition");
    }

    const updated = taskSchema.parse({
      ...task,
      status: nextStatus,
      completedAt: TERMINAL_STATUSES.has(nextStatus)
        ? this.now().toISOString()
        : task.completedAt,
    });
    this.tasks.set(taskId, updated);
    return { ...updated };
  }

  private rejectPendingApproval(taskId: string, decidedAt: string): void {
    const approvalId = this.pendingApprovals.get(taskId);
    if (approvalId === undefined) {
      return;
    }

    const approval = this.approvals.get(approvalId);
    if (approval !== undefined) {
      this.approvals.set(
        approvalId,
        approvalSchema.parse({ ...approval, decision: "rejected", decidedAt }),
      );
    }
    this.pendingApprovals.delete(taskId);
  }

  private publishCancelled(taskId: string, reason: string, at: string): void {
    this.events.publish(
      taskCancelledEventSchema.parse({
        type: "task.cancelled",
        taskId,
        reason,
        at,
      }),
    );
  }

  private completedAtOf(task: TaskEntity): string {
    if (task.completedAt === null) {
      throw new TaskError("task_invalid_transition");
    }
    return task.completedAt;
  }
}

export function createTaskManager(options: TaskManagerOptions): TaskService {
  return new TaskManagerImpl(options);
}
