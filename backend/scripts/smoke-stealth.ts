import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type {
  Page,
  Stagehand,
  StagehandBrowser,
} from "@browserbasehq/stagehand" with { "resolution-mode": "import" };
import type { Profile } from "../../shared/profile";
import { resolveAppDataDir } from "../app-data";
import { launchBrowser } from "../browser-launcher";
import { createFingerprintProfile } from "../browser-stealth";
import { createChromeInstaller } from "../chrome-installer";
import { chromeTempDir } from "../chrome-paths";
import { createProfile, resolveProfileDir } from "../profile-store";

const execFileAsync = promisify(execFile);
const FIRST_URL = "data:text/html,<h1>argus-first-page</h1>";
const STAGEHAND_URL = "data:text/html,<h1>argus-stagehand-page</h1>";
const FIRST_MARKER = "argus-first-page";
const STAGEHAND_MARKER = "argus-stagehand-page";
const PAGE_TIMEOUT_MS = 10_000;
const PROCESS_TIMEOUT_MS = 10_000;
const PROCESS_POLL_MS = 100;
const CLEANUP_TIMEOUT_MS = 5_000;
const CANVAS_WIDTH = 240;
const CANVAS_HEIGHT = 60;
const PROBE_EXPRESSION = `(() => {
  const isNativeFunction = (fn) =>
    Function.prototype.toString.call(fn).includes("[native code]");
  const isNativeMethod = (owner, key, arity) => {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    const fn = descriptor?.value;
    return (
      typeof fn === "function" &&
      fn.name === key &&
      fn.length === arity &&
      isNativeFunction(fn) &&
      !Object.hasOwn(fn, "prototype") &&
      descriptor.writable === true &&
      descriptor.enumerable === true &&
      descriptor.configurable === true
    );
  };
  const isNativeGetter = (owner, key) => {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    const getter = descriptor?.get;
    return (
      typeof getter === "function" &&
      getter.name === "get " + key &&
      getter.length === 0 &&
      isNativeFunction(getter) &&
      descriptor.set === undefined &&
      descriptor.enumerable === true &&
      descriptor.configurable === true
    );
  };
  const hashBytes = (data) => {
    let hash = 0x811c9dc5;
    for (let index = 0; index < data.length; index += 1) {
      hash ^= data[index];
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  };
  const canvas = document.createElement("canvas");
  canvas.width = ${CANVAS_WIDTH};
  canvas.height = ${CANVAS_HEIGHT};
  const context = canvas.getContext("2d");
  context.fillStyle = "#f2f4f7";
  context.fillRect(0, 0, ${CANVAS_WIDTH}, ${CANVAS_HEIGHT});
  context.fillStyle = "#1a3d6d";
  context.font = "16px sans-serif";
  context.fillText("Argus fingerprint", 12, 32);
  context.strokeStyle = "#c0392b";
  context.beginPath();
  context.arc(200, 30, 16, 0, Math.PI * 2);
  context.stroke();
  const canvasDataUrl = canvas.toDataURL("image/png");
  const canvasRepeatDataUrl = canvas.toDataURL("image/png");
  const image = context.getImageData(0, 0, ${CANVAS_WIDTH}, ${CANVAS_HEIGHT});
  const imageRepeat = context.getImageData(0, 0, ${CANVAS_WIDTH}, ${CANVAS_HEIGHT});
  const subImage = context.getImageData(12, 8, 20, 10);
  let imageDataConsistent = true;
  for (let y = 0; y < subImage.height && imageDataConsistent; y += 1) {
    for (let x = 0; x < subImage.width; x += 1) {
      const subIndex = (y * subImage.width + x) * 4;
      const fullIndex = ((8 + y) * ${CANVAS_WIDTH} + (12 + x)) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        if (subImage.data[subIndex + channel] !== image.data[fullIndex + channel]) {
          imageDataConsistent = false;
          break;
        }
      }
      if (!imageDataConsistent) {
        break;
      }
    }
  }
  const glCanvas = document.createElement("canvas");
  const gl = glCanvas.getContext("webgl") || glCanvas.getContext("experimental-webgl");
  let webglVendor = "";
  let webglRenderer = "";
  if (gl !== null) {
    const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
    webglVendor = String(gl.getParameter(debugInfo === null ? gl.VENDOR : debugInfo.UNMASKED_VENDOR_WEBGL));
    webglRenderer = String(gl.getParameter(debugInfo === null ? gl.RENDERER : debugInfo.UNMASKED_RENDERER_WEBGL));
  }
  const windowArtifacts = Reflect.ownKeys(globalThis)
    .map((key) => String(key))
    .filter((key) => key.toLowerCase().includes("argus"));
  return {
    webdriver: navigator.webdriver === true,
    webdriverGetterNative: isNativeGetter(Navigator.prototype, "webdriver"),
    hardwareConcurrency: navigator.hardwareConcurrency,
    hardwareConcurrencyGetterNative: isNativeGetter(Navigator.prototype, "hardwareConcurrency"),
    canvasMethodsNative:
      isNativeMethod(HTMLCanvasElement.prototype, "toDataURL", 0) &&
      isNativeMethod(HTMLCanvasElement.prototype, "toBlob", 1) &&
      isNativeMethod(CanvasRenderingContext2D.prototype, "getImageData", 4),
    windowArtifacts,
    webglVendor,
    webglRenderer,
    canvasWidth: canvas.width,
    canvasHeight: canvas.height,
    canvasDataUrl,
    canvasRepeatDataUrl,
    canvasImageDataHash: hashBytes(image.data),
    canvasImageDataStable:
      image.data.length === imageRepeat.data.length &&
      image.data.every((value, index) => value === imageRepeat.data[index]),
    canvasImageDataConsistent: imageDataConsistent,
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    language: navigator.language,
    languages: navigator.languages,
  };
})()`;

type FingerprintProbe = {
  readonly webdriver: boolean;
  readonly webdriverGetterNative: boolean;
  readonly hardwareConcurrency: number;
  readonly hardwareConcurrencyGetterNative: boolean;
  readonly canvasMethodsNative: boolean;
  readonly windowArtifacts: readonly string[];
  readonly webglVendor: string;
  readonly webglRenderer: string;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly canvasDataUrl: string;
  readonly canvasRepeatDataUrl: string;
  readonly canvasImageDataHash: string;
  readonly canvasImageDataStable: boolean;
  readonly canvasImageDataConsistent: boolean;
  readonly userAgent: string;
  readonly platform: string;
  readonly timeZone: string;
  readonly language: string;
  readonly languages: readonly string[];
};

type FingerprintReport = {
  readonly key: string;
  readonly webdriver: boolean;
  readonly webdriverGetterNative: boolean;
  readonly hardwareConcurrency: number;
  readonly hardwareConcurrencyGetterNative: boolean;
  readonly canvasMethodsNative: boolean;
  readonly windowArtifacts: readonly string[];
  readonly webglVendor: string;
  readonly webglRenderer: string;
  readonly canvasHash: string;
  readonly canvasImageDataHash: string;
  readonly canvasImageDataStable: boolean;
  readonly canvasImageDataConsistent: boolean;
  readonly canvasDataUrlStable: boolean;
  readonly argsHasEnableAutomation: boolean;
  readonly argsHasAutomationControlDisabled: boolean;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly canvasType: string;
  readonly userAgent: string;
  readonly platform: string;
  readonly timeZone: string;
  readonly language: string;
  readonly languages: readonly string[];
};

type LaunchSample = {
  readonly label: string;
  readonly key: string;
  readonly expectedHardwareConcurrency: number;
  readonly first: FingerprintProbe;
  readonly stagehand: FingerprintProbe | null;
  readonly processCount: number;
  readonly argsHasEnableAutomation: boolean;
  readonly argsHasAutomationControlDisabled: boolean;
  readonly canvasStableInPage: boolean;
  readonly stagehandCanvasStable: boolean | null;
};

type LaunchReport = {
  readonly first: FingerprintReport;
  readonly stagehand: FingerprintReport | null;
};

type SmokeReport = {
  readonly ok: boolean;
  readonly chrome: {
    readonly version: string;
    readonly source: string | null;
    readonly executablePath: string;
  };
  readonly tempRoot: string;
  readonly profiles: {
    readonly a: string;
    readonly b: string;
  };
  readonly launches: {
    readonly a1: LaunchReport;
    readonly a2: LaunchReport;
    readonly b: LaunchReport;
  };
  readonly checks: Record<string, boolean>;
  readonly webgl: {
    readonly spoofed: boolean;
    readonly reason: string;
  };
  readonly error?: string;
  readonly cleanup?: string;
};

type SmokeState = {
  readonly tempRoot: string;
  readonly appDataDir: string;
  executablePath: string | null;
  readonly profileDirs: string[];
};

function createTempRoot(): string {
  const workspaceRoot = resolve(__dirname, "../../../../..");
  return join(
    workspaceRoot,
    "tmp",
    "testing",
    `p2-stealth-${randomBytes(4).toString("hex")}`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

async function resolveUserChrome(): Promise<{
  executablePath: string;
  version: string;
  source: string | null;
}> {
  const appDataDir = resolveAppDataDir();
  console.error(`app data: ${appDataDir}`);

  const tempDir = chromeTempDir(appDataDir);
  const tempEntries = await readdir(tempDir).catch(() => null);
  if (tempEntries !== null && tempEntries.length > 0) {
    throw new Error(
      `Chrome for Testing is being installed at ${tempDir}; retry after it finishes.`,
    );
  }

  const installer = createChromeInstaller({ appDataDir });
  const state = await installer.initialize();
  console.error(`chrome installer state: ${state.status}`);

  if (state.status !== "ready" || state.version === null) {
    throw new Error(
      `Chrome for Testing is not installed in ${appDataDir}; this smoke test does not download it.`,
    );
  }

  const executablePath = installer.getExecutablePath();
  if (executablePath === null) {
    throw new Error("Chrome for Testing is ready without an executable path.");
  }

  console.error(`chrome version: ${state.version}`);
  console.error(`chrome source: ${state.source ?? "unknown"}`);
  console.error(`chrome executable: ${executablePath}`);

  return { executablePath, version: state.version, source: state.source };
}

function parseProbe(value: unknown): FingerprintProbe {
  if (!isRecord(value)) {
    throw new Error("Fingerprint probe returned a non-object value.");
  }

  const {
    webdriver,
    webdriverGetterNative,
    hardwareConcurrency,
    hardwareConcurrencyGetterNative,
    canvasMethodsNative,
    windowArtifacts,
    webglVendor,
    webglRenderer,
    canvasWidth,
    canvasHeight,
    canvasDataUrl,
    canvasRepeatDataUrl,
    canvasImageDataHash,
    canvasImageDataStable,
    canvasImageDataConsistent,
    userAgent,
    platform,
    timeZone,
    language,
    languages,
  } = value;

  if (
    typeof webdriver !== "boolean" ||
    typeof webdriverGetterNative !== "boolean" ||
    typeof hardwareConcurrency !== "number" ||
    typeof hardwareConcurrencyGetterNative !== "boolean" ||
    typeof canvasMethodsNative !== "boolean" ||
    typeof webglVendor !== "string" ||
    typeof webglRenderer !== "string" ||
    typeof canvasWidth !== "number" ||
    typeof canvasHeight !== "number" ||
    typeof canvasDataUrl !== "string" ||
    typeof canvasRepeatDataUrl !== "string" ||
    typeof canvasImageDataHash !== "string" ||
    typeof canvasImageDataStable !== "boolean" ||
    typeof canvasImageDataConsistent !== "boolean" ||
    typeof userAgent !== "string" ||
    typeof platform !== "string" ||
    typeof timeZone !== "string" ||
    typeof language !== "string"
  ) {
    throw new Error("Fingerprint probe returned an invalid shape.");
  }

  if (!Array.isArray(windowArtifacts)) {
    throw new Error("Fingerprint probe did not return window artifacts.");
  }
  const artifactList = windowArtifacts.filter(
    (item: unknown): item is string => typeof item === "string",
  );
  if (artifactList.length !== windowArtifacts.length) {
    throw new Error("Fingerprint probe returned a non-string window artifact.");
  }

  if (!Array.isArray(languages)) {
    throw new Error("Fingerprint probe did not return a language list.");
  }
  const languageList = languages.filter(
    (item: unknown): item is string => typeof item === "string",
  );
  if (languageList.length !== languages.length) {
    throw new Error("Fingerprint probe returned a non-string language.");
  }

  return {
    webdriver,
    webdriverGetterNative,
    hardwareConcurrency,
    hardwareConcurrencyGetterNative,
    canvasMethodsNative,
    windowArtifacts: artifactList,
    webglVendor,
    webglRenderer,
    canvasWidth,
    canvasHeight,
    canvasDataUrl,
    canvasRepeatDataUrl,
    canvasImageDataHash,
    canvasImageDataStable,
    canvasImageDataConsistent,
    userAgent,
    platform,
    timeZone,
    language,
    languages: languageList,
  };
}

async function probePage(page: {
  evaluate(expression: string): Promise<unknown>;
}): Promise<FingerprintProbe> {
  return parseProbe(await page.evaluate(PROBE_EXPRESSION));
}

function hashCanvas(canvasDataUrl: string): string {
  return createHash("sha256").update(canvasDataUrl).digest("hex");
}

function canvasType(canvasDataUrl: string): string {
  return canvasDataUrl.startsWith("data:image/png") ? "image/png" : "unexpected";
}

function toFingerprintReport(
  probe: FingerprintProbe,
  key: string,
  argsHasEnableAutomation: boolean,
  argsHasAutomationControlDisabled: boolean,
): FingerprintReport {
  return {
    key,
    webdriver: probe.webdriver,
    webdriverGetterNative: probe.webdriverGetterNative,
    hardwareConcurrency: probe.hardwareConcurrency,
    hardwareConcurrencyGetterNative: probe.hardwareConcurrencyGetterNative,
    canvasMethodsNative: probe.canvasMethodsNative,
    windowArtifacts: probe.windowArtifacts,
    webglVendor: probe.webglVendor,
    webglRenderer: probe.webglRenderer,
    canvasHash: hashCanvas(probe.canvasDataUrl),
    canvasImageDataHash: probe.canvasImageDataHash,
    canvasImageDataStable: probe.canvasImageDataStable,
    canvasImageDataConsistent: probe.canvasImageDataConsistent,
    canvasDataUrlStable: probe.canvasDataUrl === probe.canvasRepeatDataUrl,
    argsHasEnableAutomation,
    argsHasAutomationControlDisabled,
    canvasWidth: probe.canvasWidth,
    canvasHeight: probe.canvasHeight,
    canvasType: canvasType(probe.canvasDataUrl),
    userAgent: probe.userAgent,
    platform: probe.platform,
    timeZone: probe.timeZone,
    language: probe.language,
    languages: probe.languages,
  };
}

async function waitForPageUrl(
  page: { url(): Promise<string> },
  marker: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await page.url()).includes(marker)) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Page did not reach ${marker} in ${timeoutMs} ms.`);
    }
    await new Promise<void>((resolveDelay) => {
      setTimeout(resolveDelay, 50);
    });
  }
}

async function runLaunch(options: {
  readonly executablePath: string;
  readonly profile: Profile;
  readonly profileDir: string;
  readonly label: string;
  readonly includeStagehandPage: boolean;
}): Promise<LaunchSample> {
  const expected = createFingerprintProfile(options.profile.id);
  const launched = await launchBrowser({
    executablePath: options.executablePath,
    userDataDir: options.profileDir,
    profileId: options.profile.id,
  });
  let stagehandBrowser: StagehandBrowser | null = null;
  let stagehand: Stagehand | null = null;

  try {
    const firstPage =
      launched.context.pages()[0] ?? (await launched.context.newPage());
    await firstPage.goto(FIRST_URL, { timeout: PAGE_TIMEOUT_MS });

    const processes = await listProcessesContaining(options.profileDir);
    const argsHasEnableAutomation = processes.some((line) =>
      line.includes("--enable-automation"),
    );
    const argsHasAutomationControlDisabled = processes.some((line) =>
      line.includes("--disable-blink-features=AutomationControlled"),
    );

    const { localBrowser, Stagehand } = await import("@browserbasehq/stagehand");
    stagehandBrowser = await localBrowser.connect({ cdpUrl: launched.cdpUrl });
    stagehand = await Stagehand.create({
      browser: stagehandBrowser,
      logging: { level: "off" },
    });

    const stagehandPages = await stagehand.browser.context.pages();
    let firstStagehandPage: Page | null = null;
    for (const page of stagehandPages) {
      if ((await page.url()).includes(FIRST_MARKER)) {
        firstStagehandPage = page;
        break;
      }
    }
    if (firstStagehandPage === null) {
      throw new Error("Stagehand connection cannot see the launcher page.");
    }

    const first = await probePage(firstStagehandPage);
    const firstRepeat = await probePage(firstStagehandPage);
    const canvasStableInPage =
      hashCanvas(first.canvasDataUrl) === hashCanvas(firstRepeat.canvasDataUrl);

    let stagehandProbe: FingerprintProbe | null = null;
    let stagehandCanvasStable: boolean | null = null;
    if (options.includeStagehandPage) {
      const stagehandPage = await stagehand.browser.context.newPage(STAGEHAND_URL);
      await waitForPageUrl(stagehandPage, STAGEHAND_MARKER, PAGE_TIMEOUT_MS);
      stagehandProbe = await probePage(stagehandPage);
      const stagehandRepeat = await probePage(stagehandPage);
      stagehandCanvasStable =
        hashCanvas(stagehandProbe.canvasDataUrl) ===
        hashCanvas(stagehandRepeat.canvasDataUrl);
    }

    return {
      label: options.label,
      key: options.profile.id,
      expectedHardwareConcurrency: expected.hardwareConcurrency,
      first,
      stagehand: stagehandProbe,
      processCount: processes.length,
      argsHasEnableAutomation,
      argsHasAutomationControlDisabled,
      canvasStableInPage,
      stagehandCanvasStable,
    };
  } finally {
    if (stagehand !== null) {
      await withTimeout(stagehand.close(), CLEANUP_TIMEOUT_MS).catch(() => undefined);
    }
    if (stagehandBrowser !== null) {
      await withTimeout(stagehandBrowser.close(), CLEANUP_TIMEOUT_MS).catch(() => undefined);
    }
    await withTimeout(launched.context.close(), CLEANUP_TIMEOUT_MS).catch(() => undefined);
    await waitForNoProcess(options.profileDir, `${options.label} process check`).catch(
      () => undefined,
    );
  }
}

async function runSmoke(state: SmokeState): Promise<SmokeReport> {
  const chrome = await resolveUserChrome();
  state.executablePath = chrome.executablePath;

  await mkdir(state.appDataDir, { recursive: true, mode: 0o700 });

  const profileA = await createProfile(state.appDataDir, "Stealth profile A");
  const profileB = await createProfile(state.appDataDir, "Stealth profile B");
  const profileDirA = resolveProfileDir(state.appDataDir, profileA.id);
  const profileDirB = resolveProfileDir(state.appDataDir, profileB.id);
  assertInside(profileDirA, join(state.appDataDir, "profiles"), "profile A directory");
  assertInside(profileDirB, join(state.appDataDir, "profiles"), "profile B directory");
  state.profileDirs.push(profileDirA, profileDirB);

  console.error("launch A1");
  const a1 = await runLaunch({
    executablePath: chrome.executablePath,
    profile: profileA,
    profileDir: profileDirA,
    label: "A1",
    includeStagehandPage: true,
  });

  console.error("launch A2");
  const a2 = await runLaunch({
    executablePath: chrome.executablePath,
    profile: profileA,
    profileDir: profileDirA,
    label: "A2",
    includeStagehandPage: false,
  });

  console.error("launch B1");
  const b = await runLaunch({
    executablePath: chrome.executablePath,
    profile: profileB,
    profileDir: profileDirB,
    label: "B1",
    includeStagehandPage: false,
  });

  const samples = [a1, a2, b];
  const nodeTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const chromeMajor = chrome.version.split(".")[0] ?? "";
  const firstPageProbes = samples.map((sample) => sample.first);
  const stagehandProbe = a1.stagehand;

  const hasCanvasShape = (probe: FingerprintProbe): boolean =>
    probe.canvasWidth === CANVAS_WIDTH &&
    probe.canvasHeight === CANVAS_HEIGHT &&
    canvasType(probe.canvasDataUrl) === "image/png";

  const checks: Record<string, boolean> = {
    chromeProcessObserved: samples.every((sample) => sample.processCount > 0),
    noEnableAutomationInArguments: samples.every(
      (sample) => !sample.argsHasEnableAutomation,
    ),
    automationControlDisabled: samples.every(
      (sample) => sample.argsHasAutomationControlDisabled,
    ),
    noArgusWindowArtifacts:
      firstPageProbes.every((probe) => probe.windowArtifacts.length === 0) &&
      (stagehandProbe === null || stagehandProbe.windowArtifacts.length === 0),
    nativeNavigatorDescriptors:
      firstPageProbes.every(
        (probe) => probe.webdriverGetterNative && probe.hardwareConcurrencyGetterNative,
      ) &&
      (stagehandProbe === null ||
        (stagehandProbe.webdriverGetterNative &&
          stagehandProbe.hardwareConcurrencyGetterNative)),
    nativeCanvasMethods:
      firstPageProbes.every((probe) => probe.canvasMethodsNative) &&
      (stagehandProbe === null || stagehandProbe.canvasMethodsNative),
    canvasImageDataStable:
      firstPageProbes.every((probe) => probe.canvasImageDataStable) &&
      (stagehandProbe === null || stagehandProbe.canvasImageDataStable),
    canvasImageDataConsistent:
      firstPageProbes.every((probe) => probe.canvasImageDataConsistent) &&
      (stagehandProbe === null || stagehandProbe.canvasImageDataConsistent),
    sameProfileImageDataStable:
      a1.first.canvasImageDataHash === a2.first.canvasImageDataHash &&
      (a1.stagehand === null ||
        a1.stagehand.canvasImageDataHash === a1.first.canvasImageDataHash),
    differentProfileImageDataDiffers:
      a1.first.canvasImageDataHash !== b.first.canvasImageDataHash,
    firstPageWebdriverFalse: firstPageProbes.every((probe) => !probe.webdriver),
    stagehandPageWebdriverFalse:
      stagehandProbe !== null ? !stagehandProbe.webdriver : false,
    firstPageHardwareConcurrencyApplied: samples.every(
      (sample) =>
        sample.first.hardwareConcurrency === sample.expectedHardwareConcurrency,
    ),
    stagehandPageHardwareConcurrencyApplied:
      stagehandProbe !== null
        ? stagehandProbe.hardwareConcurrency ===
          createFingerprintProfile(a1.key).hardwareConcurrency
        : false,
    firstPageCanvasShapePreserved: firstPageProbes.every(hasCanvasShape),
    stagehandPageCanvasShapePreserved:
      stagehandProbe !== null ? hasCanvasShape(stagehandProbe) : false,
    canvasDeterministicWithinPage:
      samples.every((sample) => sample.canvasStableInPage) &&
      a1.stagehandCanvasStable === true,
    sameProfileStable:
      a1.first.canvasDataUrl === a2.first.canvasDataUrl &&
      a1.first.hardwareConcurrency === a2.first.hardwareConcurrency &&
      a1.first.webglVendor === a2.first.webglVendor &&
      a1.first.webglRenderer === a2.first.webglRenderer,
    differentProfileDiffers:
      a1.first.canvasDataUrl !== b.first.canvasDataUrl ||
      a1.first.hardwareConcurrency !== b.first.hardwareConcurrency ||
      a1.first.webglVendor !== b.first.webglVendor ||
      a1.first.webglRenderer !== b.first.webglRenderer,
    differentProfileCanvasDiffers: a1.first.canvasDataUrl !== b.first.canvasDataUrl,
    userAgentMatchesChrome:
      firstPageProbes.every(
        (probe) =>
          probe.userAgent.includes("Chrome/") &&
          !probe.userAgent.includes("HeadlessChrome") &&
          (chromeMajor.length === 0 || probe.userAgent.includes(`Chrome/${chromeMajor}.`)),
      ),
    platformMatchesOs: firstPageProbes.every((probe) => {
      if (process.platform === "darwin") {
        return probe.platform.includes("Mac");
      }
      if (process.platform === "win32") {
        return probe.platform.includes("Win");
      }
      return probe.platform.length > 0;
    }),
    timeZoneMatchesOs: firstPageProbes.every(
      (probe) => probe.timeZone === nodeTimeZone,
    ),
    localePresent: firstPageProbes.every(
      (probe) =>
        probe.language.length > 0 && probe.languages.includes(probe.language),
    ),
    identityFieldsStable:
      firstPageProbes.every(
        (probe) =>
          probe.userAgent === a1.first.userAgent &&
          probe.platform === a1.first.platform &&
          probe.timeZone === a1.first.timeZone &&
          probe.language === a1.first.language,
      ),
    webglValuesPresent: firstPageProbes.every(
      (probe) => probe.webglVendor.length > 0 && probe.webglRenderer.length > 0,
    ),
    webglValuesStable: firstPageProbes.every(
      (probe) =>
        probe.webglVendor === a1.first.webglVendor &&
        probe.webglRenderer === a1.first.webglRenderer,
    ),
  };

  const report: SmokeReport = {
    ok: Object.values(checks).every(Boolean),
    chrome: {
      version: chrome.version,
      source: chrome.source,
      executablePath: chrome.executablePath,
    },
    tempRoot: state.tempRoot,
    profiles: {
      a: profileA.id,
      b: profileB.id,
    },
    launches: {
      a1: {
        first: toFingerprintReport(
          a1.first,
          a1.key,
          a1.argsHasEnableAutomation,
          a1.argsHasAutomationControlDisabled,
        ),
        stagehand:
          a1.stagehand === null
            ? null
            : toFingerprintReport(
                a1.stagehand,
                a1.key,
                a1.argsHasEnableAutomation,
                a1.argsHasAutomationControlDisabled,
              ),
      },
      a2: {
        first: toFingerprintReport(
          a2.first,
          a2.key,
          a2.argsHasEnableAutomation,
          a2.argsHasAutomationControlDisabled,
        ),
        stagehand: null,
      },
      b: {
        first: toFingerprintReport(
          b.first,
          b.key,
          b.argsHasEnableAutomation,
          b.argsHasAutomationControlDisabled,
        ),
        stagehand: null,
      },
    },
    checks,
    webgl: {
      spoofed: false,
      reason:
        "Nilai WebGL asli dipertahankan karena tidak ada nilai pengganti yang dapat dipastikan cocok dengan GPU, platform, dan versi Chrome yang benar-benar berjalan.",
    },
  };

  return report;
}

async function cleanup(state: SmokeState): Promise<unknown> {
  let failure: unknown = null;

  for (const profileDir of state.profileDirs) {
    try {
      await waitForNoProcess(profileDir, "cleanup process check");
    } catch (error) {
      failure ??= error;
    }
  }

  try {
    await rm(state.tempRoot, { recursive: true, force: true });
    console.error(`cleanup: removed ${state.tempRoot}`);
  } catch (error) {
    failure ??= error;
  }

  return failure;
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const tempRoot = createTempRoot();
  const state: SmokeState = {
    tempRoot,
    appDataDir: join(tempRoot, "appdata"),
    executablePath: null,
    profileDirs: [],
  };

  let report: SmokeReport;
  try {
    report = await runSmoke(state);
  } catch (error) {
    report = {
      ok: false,
      chrome: {
        version: "",
        source: null,
        executablePath: state.executablePath ?? "",
      },
      tempRoot: state.tempRoot,
      profiles: { a: "", b: "" },
      launches: {
        a1: { first: emptyFingerprintReport(), stagehand: null },
        a2: { first: emptyFingerprintReport(), stagehand: null },
        b: { first: emptyFingerprintReport(), stagehand: null },
      },
      checks: {},
      webgl: {
        spoofed: false,
        reason:
          "Nilai WebGL asli dipertahankan karena tidak ada nilai pengganti yang dapat dipastikan cocok dengan GPU, platform, dan versi Chrome yang benar-benar berjalan.",
      },
      error: describeError(error),
    };
  }

  const cleanupError = await cleanup(state);
  if (cleanupError !== null) {
    report = {
      ...report,
      ok: false,
      cleanup: describeError(cleanupError),
    };
  }

  console.error(`duration: ${Date.now() - startedAt} ms`);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) {
    process.exitCode = 1;
  }
}

function emptyFingerprintReport(): FingerprintReport {
  return {
    key: "",
    webdriver: false,
    webdriverGetterNative: false,
    hardwareConcurrency: 0,
    hardwareConcurrencyGetterNative: false,
    canvasMethodsNative: false,
    windowArtifacts: [],
    webglVendor: "",
    webglRenderer: "",
    canvasHash: "",
    canvasImageDataHash: "",
    canvasImageDataStable: false,
    canvasImageDataConsistent: false,
    canvasDataUrlStable: false,
    argsHasEnableAutomation: false,
    argsHasAutomationControlDisabled: false,
    canvasWidth: 0,
    canvasHeight: 0,
    canvasType: "",
    userAgent: "",
    platform: "",
    timeZone: "",
    language: "",
    languages: [],
  };
}

void main();
