import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { apiCredentialsSchema, type ApiCredentials } from "../shared/contracts";

export function resolveAppDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ARGUS_APP_DATA_DIR) {
    return env.ARGUS_APP_DATA_DIR;
  }

  if (process.platform === "win32") {
    if (!env.APPDATA) {
      throw new Error("APPDATA is not set.");
    }
    return join(env.APPDATA, "Argus");
  }

  return join(homedir(), "Library", "Application Support", "Argus");
}

export async function writeApiCredentials(
  appDataDir: string,
  credentials: ApiCredentials,
): Promise<void> {
  await mkdir(appDataDir, { recursive: true, mode: 0o700 });

  const file = join(appDataDir, "api.json");
  const contents = JSON.stringify(apiCredentialsSchema.parse(credentials));

  await writeFile(file, contents, { mode: 0o600 });
  await chmod(file, 0o600);
}

export async function readApiCredentials(appDataDir: string): Promise<ApiCredentials> {
  const file = join(appDataDir, "api.json");
  const contents: unknown = JSON.parse(await readFile(file, "utf8"));
  return apiCredentialsSchema.parse(contents);
}
