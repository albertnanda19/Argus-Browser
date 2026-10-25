import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { Profile } from "../../shared/profile";
import { resolveAppDataDir } from "../app-data";
import {
  launchBrowser,
  type BrowserPage,
  type BrowserSessionContext,
} from "../browser-launcher";
import { createChromeInstaller } from "../chrome-installer";
import { chromeTempDir } from "../chrome-paths";
import {
  createProfile,
  deleteProfile,
  ProfileStoreError,
  resolveProfileDir,
} from "../profile-store";
import { createProviderRegistry } from "../provider-registry";
import type { ProviderService } from "../provider-service";
import type { StoredProviderConfig } from "../provider-store";
import { createStagehandAgent, type StagehandAgent } from "../stagehand-agent";

const execFileAsync = promisify(execFile);
const PROCESS_TIMEOUT_MS = 10_000;
const PROCESS_POLL_MS = 100;
const CLEANUP_TIMEOUT_MS = 5_000;
const PAGE_TIMEOUT_MS = 10_000;
const CDP_PROBE_TIMEOUT_MS = 2_000;
const SMOKE_PAGE_HTML =
  "<main><h1>Argus attach smoke</h1><button>Lanjut</button></main>";
const SMOKE_API_KEY = "smoke-placeholder-key";

type SmokeState = {
  readonly tempRoot: string;
  readonly appDataDir: string;
  executablePath: string | null;
  profile: Profile | null;
  profileDir: string | null;
  context: BrowserSessionContext | null;
  agent: StagehandAgent | null;
  isProfileDeleted: boolean;
};

function createTempRoot(): string {
  const workspaceRoot = resolve(__dirname, "../../../../..");
  return join(
    workspaceRoot,
    "tmp",
    "testing",
    `attach-smoke-${randomBytes(4).toString("hex")}`,
  );
}

function assertInside(childPath: string, parentPath: string, label: string): void {
  const child = resolve(childPath);
  const parent = resolve(parentPath);
  if (!child.startsWith(`${parent}${sep}`)) {
    throw new Error(`${label} is outside the expected directory: ${child}`);
  }
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  if (error.cause instanceof Error) {
    return `${error.message} (cause: ${error.cause.message})`;
  }
  return error.message;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new Error(`Timed out after ${timeoutMs} ms.`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });
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

async function resolveUserChrome(): Promise<string> {
  const appDataDir = resolveAppDataDir();
  console.log(`app data: ${appDataDir}`);

  const tempDir = chromeTempDir(appDataDir);
  const tempEntries = await readdir(tempDir).catch(() => null);
  if (tempEntries !== null && tempEntries.length > 0) {
    throw new Error(
      `Chrome for Testing is being installed at ${tempDir}; retry after it finishes.`,
    );
  }

  const installer = createChromeInstaller({ appDataDir });
  const state = await installer.initialize();
  console.log(`chrome installer state: ${state.status}`);

  if (state.status !== "ready" || state.version === null) {
    throw new Error(
      `Chrome for Testing is not installed in ${appDataDir}; this smoke test does not download it.`,
    );
  }

  const executablePath = installer.getExecutablePath();
  if (executablePath === null) {
    throw new Error("Chrome for Testing is ready without an executable path.");
  }

  console.log(`chrome version: ${state.version}`);
  console.log(`chrome source: ${state.source ?? "unknown"}`);
  console.log(`chrome executable: ${executablePath}`);

  return executablePath;
}

function createSmokeProviders(): ProviderService {
  const config: StoredProviderConfig = {
    provider: "gemini",
    model: "smoke-model",
    apiKey: SMOKE_API_KEY,
    updatedAt: new Date(0).toISOString(),
  };

  return {
    getConfig: () => ({
      provider: config.provider,
      model: config.model,
      configured: true,
      updatedAt: config.updatedAt,
    }),
    getActive: () => ({ ...config }),
    async setConfig() {
      throw new Error("Smoke provider configuration is read-only.");
    },
  };
}

async function readActivePage(context: BrowserSessionContext): Promise<BrowserPage> {
  return context.pages().at(-1) ?? (await context.newPage());
}

async function assertChromeIsAlive(
  cdpUrl: string,
  context: BrowserSessionContext,
): Promise<void> {
  const response = await fetch(`${cdpUrl}/json/version`, {
    signal: AbortSignal.timeout(CDP_PROBE_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`CDP endpoint responded with status ${response.status} after adapter close.`);
  }

  const pages = context.pages();
  if (pages.length === 0) {
    throw new Error("Chrome has no readable page after adapter close.");
  }
}

async function runSteps(state: SmokeState): Promise<void> {
  console.log(`tmp root: ${state.tempRoot}`);
  if (process.env.ARGUS_APP_DATA_DIR) {
    console.log("ARGUS_APP_DATA_DIR is used only to read the Chrome for Testing binary");
  }

  console.log("step 1: resolve Chrome for Testing from the user app data");
  const executablePath = await resolveUserChrome();
  state.executablePath = executablePath;
  console.log("chrome lookup: PASS");

  console.log("step 2: create temporary profile");
  await mkdir(state.appDataDir, { recursive: true, mode: 0o700 });
  const profile = await createProfile(state.appDataDir, "Attach smoke profile");
  state.profile = profile;
  const profileDir = resolveProfileDir(state.appDataDir, profile.id);
  assertInside(profileDir, join(state.appDataDir, "profiles"), "profile directory");
  state.profileDir = profileDir;
  console.log(`profile: ${profileDir}`);
  console.log("profile: PASS");

  console.log("step 3: launch Argus browser with CDP");
  const launched = await launchBrowser({ executablePath, userDataDir: profileDir });
  state.context = launched.context;
  console.log("launch: PASS");

  console.log("step 4: create the Stagehand adapter with a fake provider configuration");
  const agent = await createStagehandAgent({
    cdpUrl: launched.cdpUrl,
    providers: createSmokeProviders(),
    registry: createProviderRegistry(),
  });
  state.agent = agent;
  console.log("stagehand adapter: PASS (no model call)");

  console.log("step 5: read the active Argus page");
  const page = await readActivePage(launched.context);
  await page.goto(`data:text/html,${encodeURIComponent(SMOKE_PAGE_HTML)}`, {
    timeout: PAGE_TIMEOUT_MS,
  });
  console.log(`page url: ${page.url()}`);
  console.log("page: PASS");

  console.log("step 6: capture accessibility snapshot through the adapter");
  const snapshot = await agent.snapshot();
  const tree = snapshot.formattedTree.trim();
  if (tree.length === 0) {
    throw new Error("Adapter snapshot formattedTree is empty.");
  }
  console.log(`formattedTree length: ${tree.length}`);
  console.log("adapter snapshot: PASS");

  console.log("step 7: close the adapter and prove Chrome is still alive");
  await agent.close();
  state.agent = null;
  console.log("adapter close: PASS");
  await assertChromeIsAlive(launched.cdpUrl, launched.context);
  console.log("chrome after adapter close: PASS (CDP responds, page still readable)");
}

async function cleanup(state: SmokeState): Promise<unknown> {
  let failure: unknown = null;

  const record = (error: unknown): void => {
    failure ??= error;
    console.error(`cleanup: FAIL ${describeError(error)}`);
  };

  if (state.agent !== null) {
    try {
      await withTimeout(state.agent.close(), CLEANUP_TIMEOUT_MS);
      state.agent = null;
      console.log("cleanup: closed Stagehand adapter");
    } catch (error) {
      record(error);
    }
  }

  if (state.context !== null) {
    try {
      await withTimeout(state.context.close(), CLEANUP_TIMEOUT_MS);
      state.context = null;
      console.log("cleanup: closed browser context");
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
    tempRoot,
    appDataDir: join(tempRoot, "appdata"),
    executablePath: null,
    profile: null,
    profileDir: null,
    context: null,
    agent: null,
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
    console.error(`SMOKE FAILED: ${describeError(error)}`);
  }
}

void main();
