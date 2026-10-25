import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { chromium, type BrowserContext } from "playwright-core";
import type { ChromeInstallerState } from "../../shared/chrome-installer";
import type { Profile } from "../../shared/profile";
import { createChromeInstaller } from "../chrome-installer";
import {
  createProfile,
  deleteProfile,
  ProfileStoreError,
  resolveProfileDir,
} from "../profile-store";

const execFileAsync = promisify(execFile);
const COOKIE_NAME = "argus_smoke";
const COOKIE_URL = "https://example.com";
const PROCESS_TIMEOUT_MS = 10_000;
const PROCESS_POLL_MS = 100;
const LAUNCH_TIMEOUT_MS = 30_000;

type SmokeState = {
  appDataDir: string;
  tempRoot: string;
  executablePath: string | null;
  profile: Profile | null;
  profileDir: string | null;
  context: BrowserContext | null;
  isProfileDeleted: boolean;
};

function createTempRoot(): string {
  const workspaceRoot = resolve(__dirname, "../../../../..");
  return join(
    workspaceRoot,
    "tmp",
    "testing",
    `e2-smoke-${randomBytes(4).toString("hex")}`,
  );
}

function assertInside(childPath: string, parentPath: string, label: string): void {
  const child = resolve(childPath);
  const parent = resolve(parentPath);
  if (!child.startsWith(`${parent}${sep}`)) {
    throw new Error(`${label} is outside the expected directory: ${child}`);
  }
}

async function listProcessesContaining(needle: string): Promise<string[]> {
  if (process.platform === "win32") {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | Select-Object -ExpandProperty CommandLine",
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    return stdout.split(/\r?\n/).filter((line) => line.includes(needle));
  }

  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,command="], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.split("\n").filter((line) => line.includes(needle));
}

async function waitForNoProcess(needle: string, label: string): Promise<void> {
  const deadline = Date.now() + PROCESS_TIMEOUT_MS;

  for (;;) {
    const processes = await listProcessesContaining(needle);
    if (processes.length === 0) {
      console.log(`${label}: PASS (no matching process)`);
      return;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `${label}: ${processes.length} matching process(es) still running after ${PROCESS_TIMEOUT_MS} ms`,
      );
    }

    await new Promise<void>((resolveDelay) => {
      setTimeout(resolveDelay, PROCESS_POLL_MS);
    });
  }
}

async function assertHeaded(profileDir: string): Promise<void> {
  if (process.platform !== "darwin") {
    console.log("headed check: SKIPPED (only available on macOS)");
    return;
  }

  const processes = await listProcessesContaining(profileDir);
  if (processes.length === 0) {
    throw new Error(`headed check: no Chrome process uses profile ${profileDir}`);
  }

  const headless = processes.filter((line) => line.includes("--headless"));
  if (headless.length > 0) {
    throw new Error("headed check: Chrome was launched with --headless");
  }

  console.log(
    `headed check: PASS (${processes.length} process(es) use the profile directory, no --headless)`,
  );
}

async function ensureChrome(appDataDir: string): Promise<string> {
  let lastStatus = "";
  const installer = createChromeInstaller({
    appDataDir,
    onStateChange: (state: ChromeInstallerState) => {
      if (state.status !== lastStatus) {
        lastStatus = state.status;
        console.log(`chrome installer state: ${state.status}`);
      }
    },
  });

  const initial = await installer.initialize();
  console.log(`chrome installer initial state: ${initial.status}`);

  const state = initial.status === "absent" ? await installer.start() : initial;
  if (state.status !== "ready") {
    const detail = state.error === null ? "" : ` (${state.error.code})`;
    throw new Error(`Chrome for Testing is not ready: ${state.status}${detail}`);
  }
  if (state.version === null) {
    throw new Error("Chrome for Testing is ready without a version");
  }

  const executablePath = installer.getExecutablePath();
  if (executablePath === null) {
    throw new Error("Chrome for Testing is ready without an executable path");
  }

  assertInside(
    executablePath,
    join(appDataDir, "browsers", "chrome-for-testing"),
    "Chrome executable",
  );

  console.log(`chrome installer source: ${state.source}`);
  console.log(`chrome version: ${state.version}`);
  console.log(`chrome executable: ${executablePath}`);

  return executablePath;
}

async function launchHeaded(
  executablePath: string,
  profileDir: string,
): Promise<BrowserContext> {
  return chromium.launchPersistentContext(profileDir, {
    executablePath,
    headless: false,
    timeout: LAUNCH_TIMEOUT_MS,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
}

function findCookie(
  cookies: { name: string; value: string; domain: string; expires: number }[],
  phase: string,
  expectedValue: string,
): { name: string; value: string; domain: string; expires: number } {
  const cookie = cookies.find((candidate) => candidate.name === COOKIE_NAME);
  if (cookie === undefined) {
    throw new Error(`cookie check ${phase}: ${COOKIE_NAME} is missing`);
  }
  if (cookie.value !== expectedValue) {
    throw new Error(`cookie check ${phase}: value changed`);
  }
  if (cookie.domain !== "example.com") {
    throw new Error(`cookie check ${phase}: unexpected domain ${cookie.domain}`);
  }
  if (cookie.expires <= Math.floor(Date.now() / 1000)) {
    throw new Error(`cookie check ${phase}: cookie is expired or a session cookie`);
  }
  return cookie;
}

async function runSteps(state: SmokeState): Promise<void> {
  console.log(`app data: ${state.appDataDir}`);
  if (process.env.ARGUS_APP_DATA_DIR) {
    console.log(
      "ARGUS_APP_DATA_DIR is ignored; this smoke test always uses a temporary app data directory",
    );
  }

  await mkdir(state.appDataDir, { recursive: true, mode: 0o700 });

  console.log("step 1: ensure Chrome for Testing");
  const executablePath = await ensureChrome(state.appDataDir);
  state.executablePath = executablePath;

  console.log("step 2: create profile");
  state.profile = await createProfile(state.appDataDir, "E2 smoke profile");
  state.profileDir = resolveProfileDir(state.appDataDir, state.profile.id);
  assertInside(state.profileDir, join(state.appDataDir, "profiles"), "profile directory");
  console.log(`profile: ${state.profileDir}`);

  console.log("step 3: launch first headed context");
  state.context = await launchHeaded(executablePath, state.profileDir);
  await assertHeaded(state.profileDir);

  const page = state.context.pages()[0] ?? (await state.context.newPage());
  await page.goto("about:blank");
  console.log(`page opened: ${page.url()}`);

  const cookieValue = randomBytes(8).toString("hex");
  const expires = Math.floor(Date.now() / 1000) + 3600;
  await state.context.addCookies([
    {
      name: COOKIE_NAME,
      value: cookieValue,
      url: COOKIE_URL,
      expires,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
  ]);

  const before = findCookie(
    await state.context.cookies(COOKIE_URL),
    "before close",
    cookieValue,
  );
  console.log(
    `cookie before close: ${before.name}=${before.value} domain=${before.domain} expires=${before.expires}`,
  );

  console.log("step 4: close first context");
  await state.context.close();
  state.context = null;
  await waitForNoProcess(state.profileDir, "process check after first close");

  console.log("step 5: relaunch with the same profile");
  state.context = await launchHeaded(executablePath, state.profileDir);
  const after = findCookie(
    await state.context.cookies(COOKIE_URL),
    "after relaunch",
    cookieValue,
  );
  console.log(
    `cookie after relaunch: ${after.name}=${after.value} domain=${after.domain} expires=${after.expires}`,
  );
  console.log("cookie persistence: PASS");

  console.log("step 6: close second context");
  await state.context.close();
  state.context = null;
  await waitForNoProcess(state.profileDir, "process check after second close");
  await waitForNoProcess(executablePath, "executable process check");

  console.log("step 7: delete profile");
  if (state.profile === null) {
    throw new Error("profile is missing before cleanup");
  }
  await deleteProfile(state.appDataDir, state.profile.id);
  state.isProfileDeleted = true;
  console.log("profile deleted: PASS");
}

async function cleanup(state: SmokeState): Promise<unknown> {
  let failure: unknown = null;

  const record = (error: unknown): void => {
    failure ??= error;
    console.error(
      `cleanup: FAIL ${error instanceof Error ? error.message : String(error)}`,
    );
  };

  if (state.context !== null) {
    try {
      await state.context.close();
      state.context = null;
      console.log("cleanup: closed open browser context");
    } catch (error) {
      record(error);
    }
  }

  if (state.profileDir !== null) {
    try {
      await waitForNoProcess(state.profileDir, "cleanup process check");
    } catch (error) {
      record(error);
    }
  }

  if (state.profile !== null && !state.isProfileDeleted) {
    try {
      await deleteProfile(state.appDataDir, state.profile.id);
      state.isProfileDeleted = true;
      console.log("cleanup: deleted profile");
    } catch (error) {
      if (error instanceof ProfileStoreError && error.code === "profile_not_found") {
        state.isProfileDeleted = true;
      } else {
        record(error);
      }
    }
  }

  try {
    await rm(state.tempRoot, { recursive: true, force: true });
    console.log(`cleanup: removed ${state.tempRoot}`);
  } catch (error) {
    record(error);
  }

  if (state.executablePath !== null) {
    try {
      await waitForNoProcess(state.executablePath, "final process check");
    } catch (error) {
      record(error);
    }
  }

  if (failure === null) {
    console.log("cleanup: PASS");
  }
  return failure;
}

async function run(): Promise<void> {
  const tempRoot = createTempRoot();
  const state: SmokeState = {
    appDataDir: join(tempRoot, "appdata"),
    tempRoot,
    executablePath: null,
    profile: null,
    profileDir: null,
    context: null,
    isProfileDeleted: false,
  };

  let cleanupFailure: unknown = null;
  try {
    await runSteps(state);
  } finally {
    cleanupFailure = await cleanup(state);
  }

  if (cleanupFailure !== null) {
    throw cleanupFailure;
  }
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  try {
    await run();
    console.log(`duration: ${Date.now() - startedAt} ms`);
    console.log("SMOKE PASS");
  } catch (error) {
    process.exitCode = 1;
    console.error(`duration: ${Date.now() - startedAt} ms`);
    console.error(
      `SMOKE FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

void main();
