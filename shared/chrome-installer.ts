import { z } from "zod";

export const chromeInstallerErrorCodeSchema = z.enum([
  "chrome_download_failed",
  "chrome_checksum_mismatch",
  "chrome_extract_failed",
  "chrome_executable_not_found",
  "chrome_local_invalid",
  "chrome_local_missing",
  "chrome_platform_unsupported",
]);

export type ChromeInstallerErrorCode = z.infer<typeof chromeInstallerErrorCodeSchema>;

export const chromeInstallerErrorSchema = z.strictObject({
  code: chromeInstallerErrorCodeSchema,
  message: z.string().min(1),
});

export type ChromeInstallerError = z.infer<typeof chromeInstallerErrorSchema>;

export const chromeDownloadProgressSchema = z.strictObject({
  receivedBytes: z.int().min(0),
  totalBytes: z.int().min(0).nullable(),
  percent: z.number().min(0).max(100).nullable(),
});

export type ChromeDownloadProgress = z.infer<typeof chromeDownloadProgressSchema>;

export const chromeInstallerStatusSchema = z.enum([
  "absent",
  "downloading",
  "verifying",
  "extracting",
  "ready",
  "error",
]);

export type ChromeInstallerStatus = z.infer<typeof chromeInstallerStatusSchema>;

export const chromeInstallerStateSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("absent"),
    source: z.null(),
    version: z.null(),
    progress: z.null(),
    error: z.null(),
  }),
  z.strictObject({
    status: z.literal("downloading"),
    source: z.literal("managed"),
    version: z.string().min(1),
    progress: chromeDownloadProgressSchema,
    error: z.null(),
  }),
  z.strictObject({
    status: z.literal("verifying"),
    source: z.literal("managed"),
    version: z.string().min(1),
    progress: z.null(),
    error: z.null(),
  }),
  z.strictObject({
    status: z.literal("extracting"),
    source: z.literal("managed"),
    version: z.string().min(1),
    progress: z.null(),
    error: z.null(),
  }),
  z.strictObject({
    status: z.literal("ready"),
    source: z.enum(["managed", "local"]),
    version: z.string().min(1).nullable(),
    progress: z.null(),
    error: z.null(),
  }),
  z.strictObject({
    status: z.literal("error"),
    source: z.enum(["managed", "local"]).nullable(),
    version: z.string().min(1).nullable(),
    progress: z.null(),
    error: chromeInstallerErrorSchema,
  }),
]);

export type ChromeInstallerState = z.infer<typeof chromeInstallerStateSchema>;
