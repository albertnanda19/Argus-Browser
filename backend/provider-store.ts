import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  providerApiKeySchema,
  providerIdSchema,
  providerModelSchema,
} from "../shared/provider";

export const PROVIDER_CONFIG_FILE = "providers.json";

export const storedProviderEntrySchema = z.strictObject({
  model: providerModelSchema,
  apiKey: providerApiKeySchema,
  updatedAt: z.iso.datetime({ offset: false }),
});

export type StoredProviderEntry = z.infer<typeof storedProviderEntrySchema>;

export const storedProviderFileSchema = z
  .strictObject({
    active: providerIdSchema,
    configs: z.strictObject({
      gemini: storedProviderEntrySchema.optional(),
      openrouter: storedProviderEntrySchema.optional(),
    }),
  })
  .superRefine((value, context) => {
    if (value.configs[value.active] === undefined) {
      context.addIssue({
        code: "custom",
        path: ["configs", value.active],
        message: "The active provider has no configuration.",
      });
    }
  });

export type StoredProviderFile = z.infer<typeof storedProviderFileSchema>;

export const storedProviderConfigSchema = z.strictObject({
  provider: providerIdSchema,
  model: providerModelSchema,
  apiKey: providerApiKeySchema,
  updatedAt: z.iso.datetime({ offset: false }),
});

export type StoredProviderConfig = z.infer<typeof storedProviderConfigSchema>;

export type ProviderConfigRead =
  | { readonly status: "missing" }
  | { readonly status: "ok"; readonly config: StoredProviderFile }
  | { readonly status: "invalid" };

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function migrateLegacyConfig(config: StoredProviderConfig): StoredProviderFile {
  return {
    active: config.provider,
    configs: {
      [config.provider]: {
        model: config.model,
        apiKey: config.apiKey,
        updatedAt: config.updatedAt,
      },
    },
  };
}

export async function readStoredProviderConfig(
  appDataDir: string,
): Promise<ProviderConfigRead> {
  let contents: string;

  try {
    contents = await readFile(join(appDataDir, PROVIDER_CONFIG_FILE), "utf8");
  } catch (error) {
    return isMissing(error) ? { status: "missing" } : { status: "invalid" };
  }

  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    return { status: "invalid" };
  }

  const current = storedProviderFileSchema.safeParse(value);
  if (current.success) {
    return { status: "ok", config: current.data };
  }

  const legacy = storedProviderConfigSchema.safeParse(value);
  if (legacy.success) {
    return { status: "ok", config: migrateLegacyConfig(legacy.data) };
  }

  return { status: "invalid" };
}

export async function writeStoredProviderConfig(
  appDataDir: string,
  config: StoredProviderFile,
): Promise<void> {
  await mkdir(appDataDir, { recursive: true, mode: 0o700 });

  const file = join(appDataDir, PROVIDER_CONFIG_FILE);
  const tempFile = join(
    appDataDir,
    `.${PROVIDER_CONFIG_FILE}-${randomBytes(4).toString("hex")}.tmp`,
  );
  const contents = JSON.stringify(storedProviderFileSchema.parse(config));

  try {
    await writeFile(tempFile, contents, { mode: 0o600 });
    await chmod(tempFile, 0o600);
    await rename(tempFile, file);
  } catch (error) {
    await rm(tempFile, { force: true }).catch(() => {
      console.warn("Failed to remove temporary provider configuration file.");
    });
    throw error;
  }
}
