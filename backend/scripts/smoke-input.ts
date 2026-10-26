import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { createDefaultProfilePolicy } from "../../shared/profile-policy";
import type { Profile } from "../../shared/profile";
import {
  launchBrowser,
  type BrowserPage,
  type BrowserSessionContext,
} from "../browser-launcher";
import { createChromeInstaller, type ChromeInstaller } from "../chrome-installer";
import { createInputExecutor, type InputExecutionResult } from "../input-executor";
import {
  createProfile,
  deleteProfile,
  ProfileStoreError,
  resolveProfileDir,
} from "../profile-store";

const execFileAsync = promisify(execFile);
const PROCESS_TIMEOUT_MS = 10_000;
const PROCESS_POLL_MS = 100;
const CLEANUP_TIMEOUT_MS = 5_000;
const PAGE_TIMEOUT_MS = 10_000;
const STATUS_TIMEOUT_MS = 2_000;
const STATUS_POLL_MS = 50;
const FILL_TEXT = "Argus cek input";
const TYPE_TEXT = "!";

const SMOKE_PAGE_HTML = `<!doctype html>
<html lang="id">
  <head>
    <meta charset="utf-8">
    <title>Argus input smoke</title>
    <style>
      html, body { margin: 0; padding: 0; }
      body { min-height: 4000px; font-family: sans-serif; }
      #scroller { position: fixed; left: 0; top: 0; width: 180px; height: 180px; overflow: auto; border: 1px solid #888; }
      #scroller div { height: 2000px; }
      #target { position: absolute; left: 240px; top: 240px; width: 200px; height: 60px; }
      #field { position: absolute; left: 240px; top: 340px; width: 300px; height: 36px; }
      #status { position: fixed; right: 10px; bottom: 10px; width: 260px; padding: 8px; background: #f4f4f4; border: 1px solid #888; font: 12px monospace; pointer-events: none; }
      #status span { display: block; }
    </style>
  </head>
  <body>
    <div id="scroller"><div></div></div>
    <button id="target" type="button">Klik</button>
    <input id="field" type="text" value="lama">
    <div id="status">
      <span>click: <b id="click-trusted">none</b></span>
      <span>clicked: <b id="clicked">no</b></span>
      <span>value: <b id="value">lama</b></span>
      <span>input: <b id="input-trusted">none</b></span>
      <span>keydown: <b id="key-trusted">none</b></span>
      <span>scroller wheel: <b id="scroller-trusted">none</b></span>
      <span>scroller top: <b id="scroller-top">0</b></span>
      <span>page wheel: <b id="page-wheel-trusted">none</b></span>
      <span>page scroll: <b id="page-scroll-y">0</b></span>
    </div>
    <script>
      const field = document.querySelector("#field");
      const scroller = document.querySelector("#scroller");
      field.addEventListener("input", (event) => {
        document.querySelector("#value").textContent = field.value;
        document.querySelector("#input-trusted").textContent = event.isTrusted ? "trusted" : "untrusted";
      });
      field.addEventListener("keydown", (event) => {
        document.querySelector("#key-trusted").textContent = event.isTrusted ? "trusted" : "untrusted";
      });
      document.querySelector("#target").addEventListener("click", (event) => {
        document.querySelector("#click-trusted").textContent = event.isTrusted ? "trusted" : "untrusted";
        document.querySelector("#clicked").textContent = "yes";
      });
      scroller.addEventListener("wheel", (event) => {
        document.querySelector("#scroller-trusted").textContent = event.isTrusted ? "trusted" : "untrusted";
      }, { passive: true });
      scroller.addEventListener("scroll", () => {
        document.querySelector("#scroller-top").textContent = String(scroller.scrollTop);
      });
      document.addEventListener("wheel", (event) => {
        document.querySelector("#page-wheel-trusted").textContent = event.isTrusted ? "trusted" : "untrusted";
      }, { passive: true });
      window.addEventListener("scroll", () => {
        document.querySelector("#page-scroll-y").textContent = String(window.scrollY);
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
  server: Server | null;
  isProfileDeleted: boolean;
};

function createTempRoot(): string {
  const workspaceRoot = resolve(__dirname, "../../../../..");
  return join(
    workspaceRoot,
    "tmp",
    "testing",
    `e5-input-${randomBytes(4).toString("hex")}`,
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

type CleanupTimeout = <T>(promise: Promise<T>, timeoutMs: number) => Promise<T>;

const withTimeout: CleanupTimeout = (promise, timeoutMs) =>
  new Promise((resolvePromise, rejectPromise) => {
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

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    console.log(`chrome source: local (read only) ${result.version}`);
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

async function readText(page: BrowserPage, selector: string): Promise<string> {
  return (
    await page.locator(selector).innerText({ timeout: PAGE_TIMEOUT_MS })
  ).trim();
}

async function waitForText(
  page: BrowserPage,
  selector: string,
  isExpected: (value: string) => boolean,
  label: string,
): Promise<string> {
  const deadline = Date.now() + STATUS_TIMEOUT_MS;

  for (;;) {
    const value = await readText(page, selector);
    if (isExpected(value)) {
      return value;
    }
    if (Date.now() >= deadline) {
      throw new Error(`${label}: unexpected page state "${value}".`);
    }
    await new Promise<void>((resolveDelay) => {
      setTimeout(resolveDelay, STATUS_POLL_MS);
    });
  }
}

function assertDone(result: InputExecutionResult, label: string): void {
  if (result.status !== "done" || result.actionCount !== 1) {
    throw new Error(`${label}: unexpected result status ${result.status}.`);
  }
  console.log(`${label}: PASS (status done, actionCount 1)`);
}

function assertTrusted(value: string, label: string): void {
  if (value !== "trusted") {
    throw new Error(`${label}: expected trusted, got "${value}".`);
  }
  console.log(`${label}: PASS (isTrusted true)`);
}

async function runSteps(state: SmokeState): Promise<void> {
  console.log(`tmp root: ${state.tempRoot}`);

  console.log("step 1: resolve Chrome for Testing in the temporary app data");
  await mkdir(state.appDataDir, { recursive: true, mode: 0o700 });
  await resolveChrome(state);
  const executablePath = state.executablePath;
  if (executablePath === null) {
    throw new Error("Chrome for Testing resolved without an executable path.");
  }

  console.log("step 2: start the local smoke page server");
  const pageUrl = await startServer(state);
  console.log(`page url: ${pageUrl}`);

  console.log("step 3: create a temporary profile and launch the Argus browser");
  const profile = await createProfile(state.appDataDir, "Input smoke profile");
  state.profile = profile;
  const profileDir = resolveProfileDir(state.appDataDir, profile.id);
  assertInside(profileDir, join(state.appDataDir, "profiles"), "profile directory");
  state.profileDir = profileDir;

  const launched = await launchBrowser({ executablePath, userDataDir: profileDir });
  state.context = launched.context;
  console.log("launch: PASS (CDP loopback ready)");

  const page = launched.context.pages().at(-1) ?? (await launched.context.newPage());
  await page.goto(pageUrl, { timeout: PAGE_TIMEOUT_MS });
  console.log("page loaded: PASS");

  const executor = createInputExecutor({
    context: launched.context,
    policy: createDefaultProfilePolicy(),
  });
  const signal = new AbortController().signal;

  console.log("step 4: fill the text field through CDP");
  assertDone(
    await executor.execute({ method: "fill", selector: "#field", arguments: [FILL_TEXT] }, signal),
    "fill",
  );
  const filledValue = await waitForText(
    page,
    "#value",
    (value) => value === FILL_TEXT,
    "fill value",
  );
  console.log(
    `fill value: PASS (length ${filledValue.length}, expected length ${FILL_TEXT.length})`,
  );
  assertTrusted(await readText(page, "#input-trusted"), "fill input event");
  assertTrusted(await readText(page, "#key-trusted"), "fill keydown event");

  console.log("step 5: append one character through CDP");
  assertDone(
    await executor.execute({ method: "type", selector: "#field", arguments: [TYPE_TEXT] }, signal),
    "type",
  );
  const typedValue = await waitForText(
    page,
    "#value",
    (value) => value === `${FILL_TEXT}${TYPE_TEXT}`,
    "type value",
  );
  console.log(
    `type value: PASS (length ${typedValue.length}, expected length ${FILL_TEXT.length + TYPE_TEXT.length})`,
  );
  assertTrusted(await readText(page, "#input-trusted"), "type input event");

  console.log("step 6: click the button through CDP");
  assertDone(
    await executor.execute({ method: "click", selector: "#target" }, signal),
    "click",
  );
  const clicked = await waitForText(
    page,
    "#clicked",
    (value) => value === "yes",
    "click handler",
  );
  console.log(`click handler: PASS (${clicked})`);
  assertTrusted(await readText(page, "#click-trusted"), "click event");

  console.log("step 7: scroll the element through CDP");
  assertDone(
    await executor.execute({ method: "scroll", selector: "#scroller", arguments: ["down"] }, signal),
    "element scroll",
  );
  const scrollerTop = await waitForText(
    page,
    "#scroller-top",
    (value) => Number(value) > 0,
    "element scroll position",
  );
  console.log(`element scroll position: PASS (scrollTop ${scrollerTop})`);
  assertTrusted(await readText(page, "#scroller-trusted"), "element wheel event");

  console.log("step 8: scroll the viewport through CDP");
  assertDone(
    await executor.execute({ method: "scroll" }, signal),
    "viewport scroll",
  );
  const pageScroll = await waitForText(
    page,
    "#page-scroll-y",
    (value) => Number(value) > 0,
    "viewport scroll position",
  );
  console.log(`viewport scroll position: PASS (scrollY ${pageScroll})`);
  assertTrusted(await readText(page, "#page-wheel-trusted"), "viewport wheel event");

  console.log("step 9: prove the page and browser survived the executor");
  if (page.url() !== pageUrl) {
    throw new Error(`page url changed unexpectedly: ${page.url()}`);
  }
  console.log("page alive after executor: PASS");

  console.log("step 10: close the browser and delete the temporary profile");
  await withTimeout(launched.context.close(), CLEANUP_TIMEOUT_MS);
  state.context = null;
  await waitForNoProcess(profileDir, "process check after close");
  await deleteProfile(state.appDataDir, profile.id);
  state.isProfileDeleted = true;
  console.log("profile deleted: PASS");
}

async function cleanup(state: SmokeState): Promise<unknown> {
  let failure: unknown = null;

  const record = (error: unknown): void => {
    failure ??= error;
    console.error(`cleanup: FAIL ${describeError(error)}`);
  };

  if (state.context !== null) {
    try {
      await withTimeout(state.context.close(), CLEANUP_TIMEOUT_MS);
      state.context = null;
      console.log("cleanup: closed open browser context");
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
