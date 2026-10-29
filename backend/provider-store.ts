import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  providerApiKeySchema,
  providerIdSchema,
  providerModelSchema,
  type ProviderId,
} from "../shared/provider";

export const PROVIDER_CONFIG_FILE = "providers.json";

export const storedProviderEntrySchema = z.strictObject({
  model: providerModelSchema,
  apiKeys: z.array(providerApiKeySchema).min(1).max(20),
  updatedAt: z.iso.datetime({ offset: false }),
});

export type StoredProviderEntry = z.infer<typeof storedProviderEntrySchema>;

const legacyStoredProviderEntrySchema = z.strictObject({
  model: providerModelSchema,
  apiKey: providerApiKeySchema,
  updatedAt: z.iso.datetime({ offset: false }),
});

type LegacyStoredProviderEntry = z.infer<typeof legacyStoredProviderEntrySchema>;

export const storedProviderFileSchema = z
  .strictObject({
    active: providerIdSchema,
    configs: z.strictObject({
      gemini: storedProviderEntrySchema.optional(),
      openrouter: storedProviderEntrySchema.optional(),
      groq: storedProviderEntrySchema.optional(),
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

const legacyStoredProviderFileSchema = z.strictObject({
  active: providerIdSchema,
  configs: z.strictObject({
    gemini: legacyStoredProviderEntrySchema.optional(),
    openrouter: legacyStoredProviderEntrySchema.optional(),
    groq: legacyStoredProviderEntrySchema.optional(),
  }),
});

const storedProviderConfigSchema = z.strictObject({
  provider: providerIdSchema,
  model: providerModelSchema,
  apiKey: providerApiKeySchema,
  updatedAt: z.iso.datetime({ offset: false }),
});

export const storedActiveProviderSchema = z.strictObject({
  provider: providerIdSchema,
  model: providerModelSchema,
  apiKeys: z.array(providerApiKeySchema).min(1).max(20),
  updatedAt: z.iso.datetime({ offset: false }),
});

export type StoredProviderConfig = z.infer<typeof storedActiveProviderSchema>;

export type ProviderConfigRead =
  | { readonly status: "missing" }
  | { readonly status: "ok"; readonly config: StoredProviderFile }
  | { readonly status: "invalid" };

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function migrateEntry(entry: LegacyStoredProviderEntry): StoredProviderEntry {
  return {
    model: entry.model,
    apiKeys: [entry.apiKey],
    updatedAt: entry.updatedAt,
  };
}

function migrateLegacyConfig(
  config: z.infer<typeof storedProviderConfigSchema>,
): StoredProviderFile {
  return {
    active: config.provider,
    configs: {
      [config.provider]: migrateEntry(config),
    },
  };
}

function migrateLegacyFile(config: {
  readonly active: ProviderId;
  readonly configs: {
    readonly gemini?: LegacyStoredProviderEntry;
    readonly openrouter?: LegacyStoredProviderEntry;
    readonly groq?: LegacyStoredProviderEntry;
  };
}): StoredProviderFile | null {
  const configs: StoredProviderFile["configs"] = {};

  for (const id of providerIdSchema.options) {
    const entry = config.configs[id];
    if (entry !== undefined) {
      configs[id] = migrateEntry(entry);
    }
  }

  if (configs[config.active] === undefined) {
    return null;
  }

  return { active: config.active, configs };
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

  const legacyFile = legacyStoredProviderFileSchema.safeParse(value);
  if (legacyFile.success) {
    const migrated = migrateLegacyFile(legacyFile.data);
    if (migrated !== null) {
      return { status: "ok", config: migrated };
    }
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
