import { z } from "zod";
import { profileIdSchema } from "./profile";

export const sessionIdSchema = z.string().regex(/^s_[0-9a-f]{16}$/);

export const sessionStatusSchema = z.enum([
  "starting",
  "ready",
  "busy",
  "closing",
  "closed",
  "error",
]);

export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const sessionSchema = z.strictObject({
  id: sessionIdSchema,
  profileId: profileIdSchema,
  status: sessionStatusSchema,
  startedAt: z.iso.datetime({ offset: false }),
  endedAt: z.iso.datetime({ offset: false }).nullable(),
  pid: z.int().positive().nullable(),
});

export type Session = z.infer<typeof sessionSchema>;

export const sessionErrorCodeSchema = z.enum([
  "session_profile_not_found",
  "session_profile_corrupt",
  "session_chrome_not_ready",
  "session_conflict",
  "session_not_found",
  "session_launch_failed",
  "session_close_failed",
]);

export type SessionErrorCode = z.infer<typeof sessionErrorCodeSchema>;
