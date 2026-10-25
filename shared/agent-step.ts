import { z } from "zod";
import { taskIdSchema } from "./task";

export const agentStepIdSchema = z.string().regex(/^st_[0-9a-f]{16}$/);

export const agentStepStatusSchema = z.enum(["done", "failed", "blocked"]);

export type AgentStepStatus = z.infer<typeof agentStepStatusSchema>;

export const agentStepVerificationSchema = z.strictObject({
  stepOk: z.boolean(),
  goalComplete: z.boolean(),
  reason: z.string().min(1).max(4_000),
});

export type AgentStepVerification = z.infer<typeof agentStepVerificationSchema>;

export const agentStepResultSchema = z.strictObject({
  status: agentStepStatusSchema,
  url: z.string(),
  pageChanged: z.boolean(),
  verification: agentStepVerificationSchema.nullable(),
});

export type AgentStepResult = z.infer<typeof agentStepResultSchema>;

export const agentStepSchema = z.strictObject({
  id: agentStepIdSchema,
  taskId: taskIdSchema,
  index: z.int().min(1),
  action: z.string().min(1).max(100),
  target: z.string().max(300),
  result: agentStepResultSchema,
  durationMs: z.int().min(0),
});

export type AgentStep = z.infer<typeof agentStepSchema>;

export const agentStepListResponseSchema = z.strictObject({
  data: z.array(agentStepSchema),
  total: z.int().min(0),
  page: z.int().min(1),
  page_size: z.int().min(1).max(100),
});

export type AgentStepListResponse = z.infer<typeof agentStepListResponseSchema>;
