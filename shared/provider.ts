import { z } from "zod";

export const providerIdSchema = z.enum(["gemini", "openrouter", "groq"]);

export type ProviderId = z.infer<typeof providerIdSchema>;

export const providerModelSchema = z.string().trim().min(1).max(200);

export const providerApiKeySchema = z.string().trim().min(1).max(4096);

export const providerKeySchema = z.string().trim().min(1).max(100);

export const providerKeyIdSchema = z.string().regex(/^k_[0-9a-f]{12}$/);

export const providerKeyStatusSchema = z.enum(["ready", "cooldown", "auth_failed"]);

export type ProviderKeyStatus = z.infer<typeof providerKeyStatusSchema>;

export const providerKeyStateSchema = z.strictObject({
  id: providerKeyIdSchema,
  status: providerKeyStatusSchema,
  cooldownUntil: z.iso.datetime({ offset: false }).nullable(),
  lastUsedAt: z.iso.datetime({ offset: false }).nullable(),
});

export type ProviderKeyState = z.infer<typeof providerKeyStateSchema>;

export const providerConfigSchema = z.strictObject({
  provider: providerIdSchema.nullable(),
  model: providerModelSchema.nullable(),
  configured: z.boolean(),
  updatedAt: z.iso.datetime({ offset: false }).nullable(),
  available: z.array(providerIdSchema),
  keys: z.array(providerKeyStateSchema),
});

export type ProviderConfig = z.infer<typeof providerConfigSchema>;

export const providerConfigRequestSchema = z
  .strictObject({
    provider: providerKeySchema,
    model: providerModelSchema,
    apiKey: providerApiKeySchema.optional(),
    apiKeys: z.array(providerApiKeySchema).min(1).max(20).optional(),
  })
  .superRefine((value, context) => {
    if (value.apiKey !== undefined && value.apiKeys !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["apiKeys"],
        message: "Send apiKey or apiKeys, not both.",
      });
    }
  });

export type ProviderConfigRequest = z.infer<typeof providerConfigRequestSchema>;

export const providerResponseSchema = z.strictObject({
  data: providerConfigSchema,
});

export type ProviderResponse = z.infer<typeof providerResponseSchema>;

export const providerErrorCodeSchema = z.enum([
  "provider_unknown",
  "provider_validation_failed",
  "provider_api_key_required",
]);

export type ProviderErrorCode = z.infer<typeof providerErrorCodeSchema>;
