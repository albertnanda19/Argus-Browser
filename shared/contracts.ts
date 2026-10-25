import { z } from "zod";

export const apiCredentialsSchema = z.strictObject({
  port: z.int().min(1).max(65535),
  token: z.string().min(1),
});

export type ApiCredentials = z.infer<typeof apiCredentialsSchema>;

export const apiInfoSchema = z.strictObject({
  baseUrl: z.url(),
  token: z.string().min(1),
});

export type ApiInfo = z.infer<typeof apiInfoSchema>;

export const sidecarStateSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("starting") }),
  z.strictObject({ status: z.literal("connected"), apiInfo: apiInfoSchema }),
  z.strictObject({ status: z.literal("error") }),
]);

export type SidecarState = z.infer<typeof sidecarStateSchema>;

export const healthResponseSchema = z.strictObject({
  data: z.strictObject({
    ok: z.literal(true),
  }),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const problemSchema = z.strictObject({
  type: z.literal("about:blank"),
  title: z.string(),
  status: z.int(),
  detail: z.string(),
});

export type Problem = z.infer<typeof problemSchema>;

export const sidecarReadyMessageSchema = z.strictObject({
  type: z.literal("ready"),
});

export type SidecarReadyMessage = z.infer<typeof sidecarReadyMessageSchema>;
