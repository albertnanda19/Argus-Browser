import { z } from "zod";

export const providerIdSchema = z.enum(["gemini"]);

export type ProviderId = z.infer<typeof providerIdSchema>;

export const providerModelSchema = z.string().trim().min(1).max(200);

export const providerApiKeySchema = z.string().trim().min(1).max(4096);

export const providerKeySchema = z.string().trim().min(1).max(100);

export const providerConfigSchema = z.strictObject({
  provider: providerIdSchema.nullable(),
  model: providerModelSchema.nullable(),
  configured: z.boolean(),
  updatedAt: z.iso.datetime({ offset: false }).nullable(),
});

export type ProviderConfig = z.infer<typeof providerConfigSchema>;

export const providerConfigRequestSchema = z.strictObject({
  provider: providerKeySchema,
  model: providerModelSchema,
  apiKey: providerApiKeySchema,
});

export type ProviderConfigRequest = z.infer<typeof providerConfigRequestSchema>;

export const providerResponseSchema = z.strictObject({
  data: providerConfigSchema,
});

export type ProviderResponse = z.infer<typeof providerResponseSchema>;

export const providerErrorCodeSchema = z.enum([
  "provider_unknown",
  "provider_validation_failed",
]);

export type ProviderErrorCode = z.infer<typeof providerErrorCodeSchema>;
