import { z } from "zod";

const millisecondsSchema = z.int().min(0);

const actionDelayPolicySchema = z.strictObject({
  mu: z.number().min(0).describe("Parameter mu log-normal dalam ln(milidetik)."),
  sigma: z.number().gt(0).describe("Parameter sigma log-normal, harus lebih besar dari 0."),
  minMs: millisecondsSchema,
  maxMs: millisecondsSchema,
}).refine((value) => value.minMs <= value.maxMs, {
  message: "Minimum delay must not exceed maximum delay.",
});

const typingPolicySchema = z.strictObject({
  baseIntervalMs: millisecondsSchema,
  burstIntervalMs: millisecondsSchema,
  burstLength: z.int().min(1),
  afterBurstPauseMs: millisecondsSchema,
});

const mousePolicySchema = z.strictObject({
  steps: z.int().min(1),
  overshootRatio: z
    .number()
    .min(0)
    .max(1)
    .describe("Overshoot sebagai fraksi jarak, 0 sampai 1."),
  curvature: z.number().min(0).max(1).describe("Kelengkungan kurva Bézier, 0 sampai 1."),
  stepDelayMs: millisecondsSchema,
});

const scrollPolicySchema = z.strictObject({
  initialDeltaPx: z.int().min(1),
  decay: z
    .number()
    .gt(0)
    .lt(1)
    .describe("Faktor peluruhan momentum per langkah."),
  steps: z.int().min(1),
  stepDelayMs: millisecondsSchema,
});

const readingPolicySchema = z.strictObject({
  msPerCharacter: z.number().min(0),
  minMs: millisecondsSchema,
  maxMs: millisecondsSchema,
}).refine((value) => value.minMs <= value.maxMs, {
  message: "Minimum reading time must not exceed maximum reading time.",
});

export const profilePolicySchema = z.strictObject({
  actionDelay: actionDelayPolicySchema,
  typing: typingPolicySchema,
  mouse: mousePolicySchema,
  scroll: scrollPolicySchema,
  reading: readingPolicySchema,
});

export type ProfilePolicy = z.infer<typeof profilePolicySchema>;

const DEFAULT_PROFILE_POLICY: ProfilePolicy = {
  actionDelay: { mu: 6.55, sigma: 0.4, minMs: 250, maxMs: 5_000 },
  typing: {
    baseIntervalMs: 110,
    burstIntervalMs: 40,
    burstLength: 6,
    afterBurstPauseMs: 320,
  },
  mouse: { steps: 24, overshootRatio: 0.08, curvature: 0.25, stepDelayMs: 12 },
  scroll: { initialDeltaPx: 480, decay: 0.82, steps: 8, stepDelayMs: 40 },
  reading: { msPerCharacter: 35, minMs: 250, maxMs: 6_000 },
};

export function createDefaultProfilePolicy(): ProfilePolicy {
  return structuredClone(DEFAULT_PROFILE_POLICY);
}
