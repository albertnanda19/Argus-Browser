import { z } from "zod";
import { taskIdSchema } from "./task";

export const researchContactIdSchema = z.string().regex(/^c_[0-9a-f]{16}$/);

export const researchChainIdSchema = z.string().regex(/^e_[0-9a-f]{16}$/);

export const researchContactTypeSchema = z.enum([
  "whatsapp",
  "phone",
  "email",
  "linkedin",
  "social",
  "profile",
]);

export const researchContactMethodSchema = z.enum([
  "wa_me_link",
  "api_whatsapp_link",
  "tel_link",
  "jsonld_telephone",
  "email_text",
  "linkedin_url",
  "social_url",
  "profile_url",
]);

export const researchVerificationSchema = z.enum([
  "unverified",
  "wa_me_reachable",
  "wa_me_unreachable",
]);

const E164_PATTERN = /^\+[1-9][0-9]{7,14}$/;
const PHONE_TYPES = new Set(["whatsapp", "phone"]);

export const researchContactSchema = z
  .strictObject({
    id: researchContactIdSchema,
    taskId: taskIdSchema,
    type: researchContactTypeSchema,
    value: z.string().min(1),
    sourceUrl: z.url({ protocol: /^https?$/ }),
    method: researchContactMethodSchema,
    confidence: z.number().min(0).max(1),
    verification: researchVerificationSchema,
  })
  .refine(
    (contact) => !PHONE_TYPES.has(contact.type) || E164_PATTERN.test(contact.value),
    { message: "Nomor harus memakai format E.164.", path: ["value"] },
  );

export type ResearchContact = z.infer<typeof researchContactSchema>;

export const researchChainEntrySchema = z.strictObject({
  id: researchChainIdSchema,
  taskId: taskIdSchema,
  fromNode: z.string().min(1).max(300),
  toNode: z.string().min(1).max(300),
  how: z.string().min(1).max(300),
});

export type ResearchChainEntry = z.infer<typeof researchChainEntrySchema>;

export const researchResultSchema = z.strictObject({
  taskId: taskIdSchema,
  contacts: z.array(researchContactSchema),
  chain: z.array(researchChainEntrySchema),
});

export type ResearchResult = z.infer<typeof researchResultSchema>;
