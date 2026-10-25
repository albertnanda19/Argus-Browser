import { join } from "node:path";

export function chromeInstallDir(appDataDir: string): string {
  return join(appDataDir, "browsers", "chrome-for-testing");
}

export function chromeTempDir(appDataDir: string): string {
  return join(chromeInstallDir(appDataDir), ".tmp");
}

export function chromeLocalOverrideFile(appDataDir: string): string {
  return join(chromeInstallDir(appDataDir), "local.json");
}
