import { z } from "zod";
import { sessionIdSchema } from "./session";

export const taskIdSchema = z.string().regex(/^t_[0-9a-f]{16}$/);

export const taskStatusSchema = z.enum([
  "queued",
  "running",
  "waiting_approval",
  "completed",
  "failed",
  "cancelled",
]);

export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const jsonObjectSchema = z.record(z.string(), z.unknown());

export type JsonObject = z.infer<typeof jsonObjectSchema>;

export const taskSchema = z.strictObject({
  id: taskIdSchema,
  sessionId: sessionIdSchema,
  goal: z.string().min(1).max(2000),
  outputSchema: jsonObjectSchema.nullable(),
  status: taskStatusSchema,
  createdAt: z.iso.datetime({ offset: false }),
  completedAt: z.iso.datetime({ offset: false }).nullable(),
});

export type Task = z.infer<typeof taskSchema>;

export const approvalIdSchema = z.string().regex(/^a_[0-9a-f]{16}$/);

export const approvalDecisionSchema = z.enum(["pending", "approved", "rejected"]);

export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

export const approvalSchema = z.strictObject({
  id: approvalIdSchema,
  taskId: taskIdSchema,
  action: z.string().min(1),
  target: z.string().min(1).max(300),
  payload: jsonObjectSchema,
  decision: approvalDecisionSchema,
  requestedAt: z.iso.datetime({ offset: false }),
  decidedAt: z.iso.datetime({ offset: false }).nullable(),
});

export type Approval = z.infer<typeof approvalSchema>;

export const taskErrorCodeSchema = z.enum([
  "task_session_not_found",
  "task_session_not_ready",
  "task_idempotency_conflict",
  "task_not_found",
  "task_not_cancellable",
  "task_not_waiting_approval",
  "task_invalid_transition",
]);

export type TaskErrorCode = z.infer<typeof taskErrorCodeSchema>;
