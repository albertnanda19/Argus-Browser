import { spawn } from "node:child_process";
import {
  access,
  chmod,
  constants,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, posix, resolve, win32 } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { ChromeInstallerError } from "../shared/chrome-installer";
import { ChromeAbortError, ChromeFailure, CHROME_ERROR_MESSAGES, isAbortError } from "./chrome-errors";
import { chromeLocalOverrideFile } from "./chrome-paths";

const LOCAL_VERSION_TIMEOUT_MS = 5000;
const MAX_VERSION_OUTPUT_BYTES = 8192;

const chromeLocalOverrideSchema = z.strictObject({
  path: z.string().min(1),
  version: z.string().min(1),
});

export type ChromeLocalOverride = z.infer<typeof chromeLocalOverrideSchema>;

export type ChromeLocalValidation =
  | { readonly ok: true; readonly path: string; readonly version: string }
  | { readonly ok: false; readonly error: ChromeInstallerError };

export type ChromeLocalCheck = "ok" | "missing" | "invalid";

export type ValidateLocalChromeOptions = {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
};

function localError(code: ChromeInstallerError["code"]): ChromeLocalValidation {
  return { ok: false, error: { code, message: CHROME_ERROR_MESSAGES[code] } };
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isPathWithin(
  target: string,
  root: string,
  pathApi: typeof posix | typeof win32,
  caseInsensitive: boolean,
): boolean {
  const normalize = (value: string) =>
    caseInsensitive ? pathApi.resolve(value).toLowerCase() : pathApi.resolve(value);
  const relativePath = pathApi.relative(normalize(root), normalize(target));
  return relativePath === "" || (!relativePath.startsWith("..") && !pathApi.isAbsolute(relativePath));
}

export function isGoogleChromeStablePath(
  target: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (platform === "darwin") {
    const roots = [
      "/Applications/Google Chrome.app",
      join(homedir(), "Applications", "Google Chrome.app"),
    ];
    return roots.some((root) => isPathWithin(target, root, posix, true));
  }

  if (platform === "win32") {
    const roots = [
      env.ProgramFiles,
      env["ProgramFiles(x86)"],
      env.LOCALAPPDATA,
    ]
      .filter((root): root is string => typeof root === "string" && root.length > 0)
      .map((root) => win32.join(root, "Google", "Chrome", "Application"));
    return roots.some((root) => isPathWithin(target, root, win32, true));
  }

  return false;
}

function runChromeVersion(
  executable: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolveOutput, rejectOutput) => {
    const child = spawn(executable, ["--version"], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      signal?.removeEventListener("abort", onAbort);
    };

    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      child.kill("SIGKILL");
      rejectOutput(error);
    };

    const succeed = (value: string) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolveOutput(value);
    };

    const onAbort = () => {
      fail(new ChromeAbortError());
    };

    const appendOutput = (chunk: Buffer) => {
      if (output.length < MAX_VERSION_OUTPUT_BYTES) {
        output += chunk.toString("utf8");
      }
    };

    child.stdout.on("data", appendOutput);
    child.stderr.on("data", appendOutput);
    child.on("error", () => {
      fail(new ChromeFailure("chrome_local_invalid"));
    });
    child.on("close", (code) => {
      if (code === 0) {
        succeed(output.trim());
        return;
      }
      fail(new ChromeFailure("chrome_local_invalid"));
    });

    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }

    timer = setTimeout(() => {
      fail(new ChromeFailure("chrome_local_invalid"));
    }, timeoutMs);
  });
}

export async function readChromeVersion(
  executable: string,
  options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
): Promise<string> {
  const output = await runChromeVersion(
    executable,
    options.timeoutMs ?? LOCAL_VERSION_TIMEOUT_MS,
    options.signal,
  );
  const match = /Chrome for Testing\s+(\d+(?:\.\d+)+)/i.exec(output);
  if (match?.[1] === undefined) {
    throw new ChromeFailure("chrome_local_invalid");
  }
  return match[1];
}

async function inspectLocalBinaryPath(
  inputPath: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Promise<{ readonly path: string } | { readonly code: ChromeInstallerError["code"] }> {
  if (platform !== "darwin" && platform !== "win32") {
    return { code: "chrome_platform_unsupported" };
  }

  if (!isAbsolute(inputPath) || isGoogleChromeStablePath(inputPath, platform, env)) {
    return { code: "chrome_local_invalid" };
  }

  let realPath: string;
  try {
    realPath = await realpath(resolve(inputPath));
  } catch (error) {
    if (isEnoent(error)) {
      return { code: "chrome_local_missing" };
    }
    return { code: "chrome_local_invalid" };
  }

  if (isGoogleChromeStablePath(realPath, platform, env)) {
    return { code: "chrome_local_invalid" };
  }

  try {
    const stats = await stat(realPath);
    if (!stats.isFile()) {
      return { code: "chrome_local_invalid" };
    }
    await access(realPath, constants.X_OK);
  } catch (error) {
    if (isEnoent(error)) {
      return { code: "chrome_local_missing" };
    }
    return { code: "chrome_local_invalid" };
  }

  return { path: realPath };
}

export async function validateLocalChromeBinary(
  inputPath: string,
  options: ValidateLocalChromeOptions = {},
): Promise<ChromeLocalValidation> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const inspected = await inspectLocalBinaryPath(inputPath, platform, env);

  if (!("path" in inspected)) {
    return localError(inspected.code);
  }

  let version: string;
  try {
    version = await readChromeVersion(inspected.path, {
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    if (error instanceof ChromeFailure) {
      return localError(error.code);
    }
    return localError("chrome_local_invalid");
  }

  return { ok: true, path: inspected.path, version };
}

export async function checkLocalChromeOverride(
  override: ChromeLocalOverride,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ChromeLocalCheck> {
  const inspected = await inspectLocalBinaryPath(override.path, platform, env);
  if ("path" in inspected) {
    return "ok";
  }
  return inspected.code === "chrome_local_missing" ? "missing" : "invalid";
}

export async function readLocalChromeOverride(
  appDataDir: string,
): Promise<ChromeLocalOverride | null> {
  const file = chromeLocalOverrideFile(appDataDir);
  let contents: string;
  try {
    contents = await readFile(file, "utf8");
  } catch (error) {
    if (isEnoent(error)) {
      return null;
    }
    throw error;
  }

  try {
    const parsed = chromeLocalOverrideSchema.safeParse(JSON.parse(contents));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function writeLocalChromeOverride(
  appDataDir: string,
  override: ChromeLocalOverride,
): Promise<void> {
  const file = chromeLocalOverrideFile(appDataDir);
  const tempFile = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  const contents = JSON.stringify(chromeLocalOverrideSchema.parse(override));

  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  try {
    await writeFile(tempFile, contents, { mode: 0o600 });
    await chmod(tempFile, 0o600);
    await rename(tempFile, file);
    await chmod(file, 0o600);
  } finally {
    await rm(tempFile, { force: true }).catch(() => undefined);
  }
}

export async function removeLocalChromeOverride(appDataDir: string): Promise<void> {
  await rm(chromeLocalOverrideFile(appDataDir), { force: true });
}
