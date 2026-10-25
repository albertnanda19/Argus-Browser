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

export const storedProviderConfigSchema = z.strictObject({
  provider: providerIdSchema,
  model: providerModelSchema,
  apiKey: providerApiKeySchema,
  updatedAt: z.iso.datetime({ offset: false }),
});

export type StoredProviderConfig = z.infer<typeof storedProviderConfigSchema>;

export type ProviderConfigRead =
  | { readonly status: "missing" }
  | { readonly status: "ok"; readonly config: StoredProviderConfig }
  | { readonly status: "invalid" };

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
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

  try {
    const parsed = storedProviderConfigSchema.safeParse(JSON.parse(contents));
    return parsed.success ? { status: "ok", config: parsed.data } : { status: "invalid" };
  } catch {
    return { status: "invalid" };
  }
}

export async function writeStoredProviderConfig(
  appDataDir: string,
  config: StoredProviderConfig,
): Promise<void> {
  await mkdir(appDataDir, { recursive: true, mode: 0o700 });

  const file = join(appDataDir, PROVIDER_CONFIG_FILE);
  const tempFile = join(
    appDataDir,
    `.${PROVIDER_CONFIG_FILE}-${randomBytes(4).toString("hex")}.tmp`,
  );
  const contents = JSON.stringify(storedProviderConfigSchema.parse(config));

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
