import { z } from "zod";
import { chromeInstallerStateSchema } from "./chrome-installer";
import { profileIdSchema, profileNameSchema, profileSchema } from "./profile";
import { sessionSchema } from "./session";
import { approvalSchema, jsonObjectSchema, taskSchema } from "./task";

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export const createProfileRequestSchema = z.strictObject({
  name: profileNameSchema,
});

export type CreateProfileRequest = z.infer<typeof createProfileRequestSchema>;

export const createSessionRequestSchema = z.strictObject({
  profileId: profileIdSchema,
});

export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;

export const localExecutableRequestSchema = z.strictObject({
  path: z.string().min(1),
});

export type LocalExecutableRequest = z.infer<typeof localExecutableRequestSchema>;

export const browserStateResponseSchema = z.strictObject({
  data: chromeInstallerStateSchema,
});

export type BrowserStateResponse = z.infer<typeof browserStateResponseSchema>;

export const profileResponseSchema = z.strictObject({
  data: profileSchema,
});

export type ProfileResponse = z.infer<typeof profileResponseSchema>;

export const profileListResponseSchema = z.strictObject({
  data: z.array(profileSchema),
  total: z.int().min(0),
  page: z.int().min(1),
  page_size: z.int().min(1).max(100),
});

export type ProfileListResponse = z.infer<typeof profileListResponseSchema>;

export const sessionResponseSchema = z.strictObject({
  data: sessionSchema,
});

export type SessionResponse = z.infer<typeof sessionResponseSchema>;

export const sessionListResponseSchema = z.strictObject({
  data: z.array(sessionSchema),
  total: z.int().min(0),
  page: z.int().min(1),
  page_size: z.int().min(1).max(100),
});

export type SessionListResponse = z.infer<typeof sessionListResponseSchema>;

export const idempotencyKeySchema = z.string().trim().min(1).max(200);

export const createTaskRequestSchema = z.strictObject({
  goal: z.string().min(1).max(2000),
  outputSchema: jsonObjectSchema.optional(),
});

export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>;

export const approvalDecisionRequestSchema = z.discriminatedUnion("approve", [
  z.strictObject({ approve: z.literal(true) }),
  z.strictObject({ approve: z.literal(false), reason: z.string().min(1).max(500) }),
]);

export type ApprovalDecisionRequest = z.infer<typeof approvalDecisionRequestSchema>;

export const taskResponseSchema = z.strictObject({
  data: taskSchema,
});

export type TaskResponse = z.infer<typeof taskResponseSchema>;

export const approvalResponseSchema = z.strictObject({
  data: z.strictObject({
    task: taskSchema,
    approval: approvalSchema,
  }),
});

export type ApprovalResponse = z.infer<typeof approvalResponseSchema>;
