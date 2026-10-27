import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { Profile } from "../../shared/profile";
import {
  launchBrowser,
  type BrowserPage,
  type BrowserSessionContext,
} from "../browser-launcher";
import { createChromeInstaller, type ChromeInstaller } from "../chrome-installer";
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
import {
  buildVerifyInstruction,
  parseVerification,
  verificationSchema,
} from "../task-runner";

const execFileAsync = promisify(execFile);
const PROCESS_TIMEOUT_MS = 10_000;
const PROCESS_POLL_MS = 100;
const CLEANUP_TIMEOUT_MS = 5_000;
const PAGE_TIMEOUT_MS = 10_000;
const ACT_BUDGET_MS = 1_000;
const EXPECTED_CODE = "4821";
const SMOKE_PAGE_HTML = `<!doctype html>
<html lang="id">
  <head><meta charset="utf-8"><title>Argus act smoke</title></head>
  <body>
    <main>
      <h1>Argus act smoke</h1>
      <button id="show-code">Tampilkan kode</button>
      <div id="code-output"></div>
    </main>
    <script>
      document.querySelector("#show-code").addEventListener("click", () => {
        document.querySelector("#code-output").textContent = "${EXPECTED_CODE}";
      });
    </script>
  </body>
</html>`;

type SmokeState = {
  readonly tempRoot: string;
  readonly appDataDir: string;
  executablePath: string | null;
  installer: ChromeInstaller | null;
  profile: Profile | null;
  profileDir: string | null;
  context: BrowserSessionContext | null;
  agent: StagehandAgent | null;
  server: Server | null;
  isProfileDeleted: boolean;
};

function createTempRoot(): string {
  const workspaceRoot = resolve(__dirname, "../../../../..");
  return join(
    workspaceRoot,
    "tmp",
    "testing",
    `e4-verify-${randomBytes(4).toString("hex")}`,
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

type RawVerificationShape = {
  readonly hasFence: boolean;
  readonly hasOutsideText: boolean;
  readonly length: number;
  readonly excerpt: string;
};

function describeVerificationShape(raw: unknown): RawVerificationShape {
  const text = typeof raw === "string" ? raw : JSON.stringify(raw) ?? "";
  const fence = /```[\s\S]*?```/.exec(text);
  let outside: string;

  if (fence === null) {
    const trimmed = text.trim();
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    outside =
      start === -1 || end === -1
        ? trimmed
        : `${trimmed.slice(0, start)}${trimmed.slice(end + 1)}`;
  } else {
    outside = `${text.slice(0, fence.index)}${text.slice(
      fence.index + fence[0].length,
    )}`;
  }

  return {
    hasFence: fence !== null,
    hasOutsideText: outside.trim().length > 0,
    length: text.length,
    excerpt: text.replace(/\s+/g, " ").trim().slice(0, 200),
  };
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

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(
      `${name} is not set. Set ARGUS_E2E_GEMINI_API_KEY and ARGUS_E2E_GEMINI_MODEL to run this smoke test.`,
    );
  }
  return value;
}

function createSmokeProviders(model: string, apiKey: string): ProviderService {
  const config: StoredProviderConfig = {
    provider: "gemini",
    model,
    apiKey,
    updatedAt: new Date(0).toISOString(),
  };

  return {
    getConfig: () => ({
      provider: "gemini",
      model: config.model,
      configured: true,
      updatedAt: config.updatedAt,
      available: ["gemini"],
    }),
    getActive: () => ({ ...config }),
    async setConfig() {
      throw new Error("Smoke provider configuration is read-only.");
    },
  };
}

async function resolveChrome(state: SmokeState): Promise<void> {
  const installer = createChromeInstaller({ appDataDir: state.appDataDir });
  state.installer = installer;
  const initial = await installer.initialize();
  console.log(`chrome installer state: ${initial.status}`);

  if (initial.status === "ready") {
    const executablePath = installer.getExecutablePath();
    if (executablePath === null) {
      throw new Error("Chrome for Testing is ready without an executable path.");
    }
    state.executablePath = executablePath;
    console.log(
      `chrome source: ${initial.source ?? "managed"} ${initial.version ?? "unknown"}`,
    );
    return;
  }

  const localPath = process.env.ARGUS_SMOKE_CHROME_PATH;
  if (localPath !== undefined && localPath.length > 0) {
    const result = await installer.setLocalBinary(localPath);
    if (!result.ok) {
      throw new Error(
        `ARGUS_SMOKE_CHROME_PATH is not a usable Chrome for Testing binary: ${result.error.code}`,
      );
    }
    state.executablePath = result.path;
    console.log(`chrome source: local ${result.version}`);
    return;
  }

  if (process.env.ARGUS_SMOKE_ALLOW_DOWNLOAD === "1") {
    console.log("chrome: downloading into the temporary app data (approved)");
    const downloaded = await installer.start();
    const executablePath = installer.getExecutablePath();
    if (downloaded.status !== "ready" || executablePath === null) {
      throw new Error(
        `Chrome for Testing download ended with status ${downloaded.status}.`,
      );
    }
    state.executablePath = executablePath;
    console.log(
      `chrome source: ${downloaded.source ?? "managed"} ${downloaded.version ?? "unknown"}`,
    );
    return;
  }

  throw new Error(
    "Chrome for Testing is not installed in the temporary app data. Set ARGUS_SMOKE_CHROME_PATH to an approved binary, or set ARGUS_SMOKE_ALLOW_DOWNLOAD=1 after approving a download.",
  );
}

async function startServer(state: SmokeState): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(SMOKE_PAGE_HTML);
  });
  state.server = server;

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const onError = (error: Error) => {
      rejectPromise(error);
    };
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolvePromise();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The local smoke server has no TCP port.");
  }

  await mkdir(state.tempRoot, { recursive: true, mode: 0o700 });
  await writeFile(join(state.tempRoot, "port.txt"), `${address.port}\n`, {
    mode: 0o600,
  });

  return `http://127.0.0.1:${address.port}/`;
}

async function readActivePage(
  context: BrowserSessionContext,
): Promise<BrowserPage> {
  return context.pages().at(-1) ?? (await context.newPage());
}

async function assertCodeOutput(
  page: BrowserPage,
  expected: string,
  label: string,
): Promise<void> {
  const value = (
    await page.locator("#code-output").innerText({ timeout: PAGE_TIMEOUT_MS })
  ).trim();
  if (value !== expected) {
    throw new Error(
      `${label}: #code-output is "${value}", expected "${expected}".`,
    );
  }
  console.log(`${label}: #code-output = "${value}"`);
}

async function runSteps(state: SmokeState): Promise<void> {
  console.log(`tmp root: ${state.tempRoot}`);

  console.log("step 1: read model credentials from the environment");
  const apiKey = readRequiredEnv("ARGUS_E2E_GEMINI_API_KEY");
  const model = readRequiredEnv("ARGUS_E2E_GEMINI_MODEL");
  console.log(`model: ${model}`);
  console.log("credentials: PASS (not printed)");

  console.log("step 2: resolve Chrome for Testing in the temporary app data");
  await mkdir(state.appDataDir, { recursive: true, mode: 0o700 });
  await resolveChrome(state);
  const executablePath = state.executablePath;
  if (executablePath === null) {
    throw new Error("Chrome for Testing resolved without an executable path.");
  }
  console.log("chrome lookup: PASS");

  console.log("step 3: start the local smoke page server");
  const pageUrl = await startServer(state);
  console.log(`page url: ${pageUrl}`);
  console.log("local server: PASS");

  console.log("step 4: create a temporary profile and launch the Argus browser");
  const profile = await createProfile(state.appDataDir, "Act smoke profile");
  state.profile = profile;
  const profileDir = resolveProfileDir(state.appDataDir, profile.id);
  assertInside(profileDir, join(state.appDataDir, "profiles"), "profile directory");
  state.profileDir = profileDir;
  console.log(`profile: ${profileDir}`);

  const launched = await launchBrowser({ executablePath, userDataDir: profileDir });
  state.context = launched.context;
  console.log("launch: PASS (CDP loopback ready)");

  console.log("step 5: load the page before Stagehand is created");
  const page = await readActivePage(launched.context);
  await page.goto(pageUrl, { timeout: PAGE_TIMEOUT_MS });
  await assertCodeOutput(page, "", "cold page");
  console.log("cold page: PASS (page loaded before attach)");

  console.log("step 6: create the Stagehand adapter with the configured model");
  const agent = await createStagehandAgent({
    cdpUrl: launched.cdpUrl,
    providers: createSmokeProviders(model, apiKey),
    registry: createProviderRegistry(),
  });
  state.agent = agent;
  console.log("stagehand adapter: PASS (no model call)");

  console.log("step 7: prepare the page and expect one reload");
  const prepareStartedAt = Date.now();
  const preparation = await agent.preparePage();
  const prepareMs = Date.now() - prepareStartedAt;
  if (!preparation.reloaded) {
    throw new Error(
      "Page preparation did not reload: the initial locator probe unexpectedly succeeded on a cold page.",
    );
  }
  console.log(
    `page preparation: initial probe failed, reloaded once, second probe ready in ${prepareMs} ms`,
  );
  await assertCodeOutput(page, "", "reloaded page");
  console.log("page preparation: PASS");

  console.log("step 8: observe the button");
  const actions = await agent.observe("Find the button that shows the code.");
  const action = actions[0];
  if (action === undefined) {
    throw new Error("Observe returned no actions for the cold page.");
  }
  console.log(
    `observe: ${actions.length} action(s), first="${action.description}" method=${action.method ?? "none"}`,
  );

  console.log("step 9: replay the observed click with the ten second limit");
  const actStartedAt = Date.now();
  const summary = await agent.act(action);
  const actMs = Date.now() - actStartedAt;
  if (!summary.success) {
    throw new Error(`Act replay failed: ${summary.actionCount} action(s) reported.`);
  }
  if (actMs >= ACT_BUDGET_MS) {
    throw new Error(`Act replay took ${actMs} ms, expected less than ${ACT_BUDGET_MS} ms.`);
  }
  console.log(`act replay: PASS ${actMs} ms`);
  await assertCodeOutput(page, EXPECTED_CODE, "act result");

  console.log("step 10: verify three times with the runner parser");
  const verificationInstruction = buildVerifyInstruction(
    "Tampilkan kode pada halaman uji Argus.",
    action.description,
    pageUrl,
    true,
  );

  for (let index = 1; index <= 3; index += 1) {
    const raw = await agent.extractStructured(
      verificationInstruction,
      verificationSchema,
    );
    const shape = describeVerificationShape(raw);
    const verification = parseVerification(raw);
    console.log(
      `verification ${index}: type=${typeof raw} fence=${shape.hasFence} outsideText=${shape.hasOutsideText} length=${shape.length} excerpt="${shape.excerpt}" parsed=${verification !== null}${
        verification === null
          ? ""
          : ` stepOk=${verification.stepOk} goalComplete=${verification.goalComplete} reasonLength=${verification.reason.length}`
      }`,
    );

    if (verification === null) {
      throw new Error(
        `Verification ${index} could not be parsed from ${shape.length} characters.`,
      );
    }
  }
  console.log("verification: PASS (3 model calls parsed)");
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

  if (state.server !== null) {
    try {
      const server = state.server;
      state.server = null;
      server.closeAllConnections();
      await withTimeout(
        new Promise<void>((resolvePromise) => {
          server.close(() => resolvePromise());
        }),
        CLEANUP_TIMEOUT_MS,
      );
      console.log("cleanup: closed local page server");
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

  if (state.installer !== null) {
    try {
      await state.installer.shutdown();
      state.installer = null;
      console.log("cleanup: stopped Chrome installer");
    } catch (error) {
      record(error);
    }
  }

  try {
    await rm(state.tempRoot, { recursive: true, force: true });
    console.log(`cleanup: removed ${state.tempRoot}`);
  } catch (error) {
    record(error);
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
    installer: null,
    profile: null,
    profileDir: null,
    context: null,
    agent: null,
    server: null,
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
