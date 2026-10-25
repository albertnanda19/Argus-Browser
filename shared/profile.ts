import { z } from "zod";

export const profileIdSchema = z.string().regex(/^p_[0-9a-f]{16}$/);

export const profileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine((name) => !/[\u0000-\u001f\u007f-\u009f]/.test(name));

export const profileSchema = z.strictObject({
  id: profileIdSchema,
  name: profileNameSchema,
  createdAt: z.iso.datetime({ offset: false }),
  lastUsedAt: z.iso.datetime({ offset: false }).nullable(),
});

export type Profile = z.infer<typeof profileSchema>;
