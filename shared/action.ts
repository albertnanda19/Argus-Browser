import { z } from "zod";
import { taskIdSchema } from "./task";

const selectorSchema = z.string().min(1).max(1000);

export const navigateActionRequestSchema = z.strictObject({
  action: z.literal("navigate"),
  url: z.url(),
  taskId: taskIdSchema.optional(),
});

export const clickActionRequestSchema = z.strictObject({
  action: z.literal("click"),
  selector: selectorSchema,
  taskId: taskIdSchema.optional(),
});

export const typeActionRequestSchema = z.strictObject({
  action: z.literal("type"),
  selector: selectorSchema,
  text: z.string().max(10_000),
  taskId: taskIdSchema.optional(),
});

export const extractActionRequestSchema = z.strictObject({
  action: z.literal("extract"),
  selector: selectorSchema,
  taskId: taskIdSchema.optional(),
});

export const actionRequestSchema = z.discriminatedUnion("action", [
  navigateActionRequestSchema,
  clickActionRequestSchema,
  typeActionRequestSchema,
  extractActionRequestSchema,
]);

export type ActionRequest = z.infer<typeof actionRequestSchema>;

export const navigateActionResultSchema = z.strictObject({
  action: z.literal("navigate"),
  url: z.string().min(1),
});

export const clickActionResultSchema = z.strictObject({
  action: z.literal("click"),
  selector: z.string().min(1),
});

export const typeActionResultSchema = z.strictObject({
  action: z.literal("type"),
  selector: z.string().min(1),
});

export const extractActionResultSchema = z.strictObject({
  action: z.literal("extract"),
  selector: z.string().min(1),
  value: z.string(),
});

export const actionResultSchema = z.discriminatedUnion("action", [
  navigateActionResultSchema,
  clickActionResultSchema,
  typeActionResultSchema,
  extractActionResultSchema,
]);

export type ActionResult = z.infer<typeof actionResultSchema>;

export const actionResponseSchema = z.strictObject({
  data: actionResultSchema,
});

export type ActionResponse = z.infer<typeof actionResponseSchema>;

export const actionErrorCodeSchema = z.enum([
  "action_session_not_found",
  "action_session_not_ready",
  "action_task_not_found",
  "action_task_not_running",
  "action_navigation_failed",
  "action_target_not_found",
  "action_failed",
]);

export type ActionErrorCode = z.infer<typeof actionErrorCodeSchema>;
