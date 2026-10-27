import { z } from "zod";
import { agentStepSchema, agentStepStatusSchema } from "./agent-step";
import { jsonObjectSchema, taskIdSchema } from "./task";

export const stepActionSchema = z.enum(["navigate", "click", "type", "extract"]);

export type StepAction = z.infer<typeof stepActionSchema>;

export const stepEventSchema = z.strictObject({
  type: z.literal("step"),
  taskId: taskIdSchema.nullable(),
  action: stepActionSchema,
  url: z.string().min(1).optional(),
  selector: z.string().min(1).optional(),
  at: z.iso.datetime({ offset: false }),
});

export type StepEvent = z.infer<typeof stepEventSchema>;

export const agentStepEventSchema = z.strictObject({
  type: z.literal("agent.step"),
  taskId: taskIdSchema,
  index: agentStepSchema.shape.index,
  action: agentStepSchema.shape.action,
  target: agentStepSchema.shape.target,
  status: agentStepStatusSchema,
  url: z.string(),
  at: z.iso.datetime({ offset: false }),
});

export type AgentStepEvent = z.infer<typeof agentStepEventSchema>;

export const approvalRequestedEventSchema = z.strictObject({
  type: z.literal("approval.requested"),
  taskId: taskIdSchema,
  action: z.string().min(1).max(100),
  target: z.string().min(1).max(300),
  selector: z.string().max(1000),
  highlighted: z.boolean(),
  category: z.string().min(1).max(50),
  at: z.iso.datetime({ offset: false }),
});

export type ApprovalRequestedEvent = z.infer<typeof approvalRequestedEventSchema>;

export const taskCompletedEventSchema = z.strictObject({
  type: z.literal("task.completed"),
  taskId: taskIdSchema,
  result: jsonObjectSchema,
  at: z.iso.datetime({ offset: false }),
});

export type TaskCompletedEvent = z.infer<typeof taskCompletedEventSchema>;

export const taskFailedEventSchema = z.strictObject({
  type: z.literal("task.failed"),
  taskId: taskIdSchema,
  reason: z.string().min(1),
  at: z.iso.datetime({ offset: false }),
});

export type TaskFailedEvent = z.infer<typeof taskFailedEventSchema>;

export const taskCancelledEventSchema = z.strictObject({
  type: z.literal("task.cancelled"),
  taskId: taskIdSchema,
  reason: z.string().min(1),
  at: z.iso.datetime({ offset: false }),
});

export type TaskCancelledEvent = z.infer<typeof taskCancelledEventSchema>;

export const domainEventSchema = z.discriminatedUnion("type", [
  stepEventSchema,
  agentStepEventSchema,
  approvalRequestedEventSchema,
  taskCompletedEventSchema,
  taskFailedEventSchema,
  taskCancelledEventSchema,
]);

export type DomainEvent = z.infer<typeof domainEventSchema>;
