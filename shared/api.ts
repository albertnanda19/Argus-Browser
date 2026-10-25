import { z } from "zod";
import { chromeInstallerStateSchema } from "./chrome-installer";
import { profileIdSchema, profileNameSchema, profileSchema } from "./profile";
import { sessionSchema } from "./session";

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
