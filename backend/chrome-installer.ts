import { randomBytes } from "node:crypto";
import { access, constants, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type {
  ChromeDownloadProgress,
  ChromeInstallerErrorCode,
  ChromeInstallerState,
} from "../shared/chrome-installer";
import { extractChromeArchive, findChromeExecutable } from "./chrome-archive";
import { hashFileInWorker } from "./chrome-checksum";
import {
  downloadFile,
  type ChromeFetch,
  type DownloadProgress,
} from "./chrome-download";
import {
  ChromeAbortError,
  ChromeFailure,
  CHROME_ERROR_MESSAGES,
  isAbortError,
  throwIfAborted,
} from "./chrome-errors";
import {
  checkLocalChromeOverride,
  readLocalChromeOverride,
  removeLocalChromeOverride,
  validateLocalChromeBinary,
  writeLocalChromeOverride,
  type ChromeLocalOverride,
  type ChromeLocalValidation,
} from "./chrome-local-binary";
import {
  chromeManifest,
  resolveChromePlatform,
  type ChromeManifest,
  type ChromePlatform,
} from "./chrome-manifest";
import { chromeInstallDir, chromeTempDir } from "./chrome-paths";

const INSTALL_MARKER_FILE = ".argus-install.json";
const PROGRESS_INTERVAL_MS = 250;
const MAX_DOWNLOAD_ATTEMPTS = 3;
const BASE_RETRY_DELAY_MS = 500;

const installMarkerSchema = z.strictObject({
  version: z.string().min(1),
  platform: z.enum(["mac-arm64", "win64"]),
  executable: z.string().min(1),
});

type InstallMarker = z.infer<typeof installMarkerSchema>;

export type ChromeInstallerOptions = {
  readonly appDataDir: string;
  readonly manifest?: ChromeManifest;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly fetchImpl?: ChromeFetch;
  readonly sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  readonly random?: () => number;
  readonly now?: () => number;
  readonly onStateChange?: (state: ChromeInstallerState) => void;
};

export type ChromeInstaller = {
  initialize(): Promise<ChromeInstallerState>;
  getState(): ChromeInstallerState;
  start(): Promise<ChromeInstallerState>;
  setLocalBinary(inputPath: string): Promise<ChromeLocalValidation>;
  clearLocalBinary(): Promise<ChromeInstallerState>;
  getExecutablePath(): string | null;
  shutdown(): Promise<void>;
};

function absentState(): ChromeInstallerState {
  return { status: "absent", source: null, version: null, progress: null, error: null };
}

function readyState(
  source: "managed" | "local",
  version: string | null,
): ChromeInstallerState {
  return { status: "ready", source, version, progress: null, error: null };
}

function downloadingState(
  version: string,
  progress: ChromeDownloadProgress = {
    receivedBytes: 0,
    totalBytes: null,
    percent: null,
  },
): ChromeInstallerState {
  return { status: "downloading", source: "managed", version, progress, error: null };
}

function verifyingState(version: string): ChromeInstallerState {
  return { status: "verifying", source: "managed", version, progress: null, error: null };
}

function extractingState(version: string): ChromeInstallerState {
  return { status: "extracting", source: "managed", version, progress: null, error: null };
}

function errorState(
  source: "managed" | "local" | null,
  version: string | null,
  code: ChromeInstallerErrorCode,
): ChromeInstallerState {
  return {
    status: "error",
    source,
    version,
    progress: null,
    error: { code, message: CHROME_ERROR_MESSAGES[code] },
  };
}

function toDownloadProgress(progress: DownloadProgress): ChromeDownloadProgress {
  const percent =
    progress.totalBytes !== null && progress.totalBytes > 0
      ? Math.min(
          100,
          Math.round((progress.receivedBytes / progress.totalBytes) * 1000) / 10,
        )
      : null;
  return {
    receivedBytes: progress.receivedBytes,
    totalBytes: progress.totalBytes,
    percent,
  };
}

function retryDelayMs(attempt: number, random: () => number): number {
  return BASE_RETRY_DELAY_MS * 2 ** (attempt - 1) + Math.floor(random() * BASE_RETRY_DELAY_MS);
}

function defaultSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveDelay, rejectDelay) => {
    if (signal.aborted) {
      rejectDelay(new ChromeAbortError());
      return;
    }

    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolveDelay();
    }, delayMs);

    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      rejectDelay(new ChromeAbortError());
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

class ChromeInstallerImpl implements ChromeInstaller {
  private readonly appDataDir: string;
  private readonly manifest: ChromeManifest;
  private readonly platform: NodeJS.Platform;
  private readonly platformId: ChromePlatform | null;
  private readonly fetchImpl: ChromeFetch | undefined;
  private readonly sleep: (delayMs: number, signal: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly onStateChange: ((state: ChromeInstallerState) => void) | undefined;

  private state: ChromeInstallerState = absentState();
  private executablePath: string | null = null;
  private localOverride: ChromeLocalOverride | null = null;
  private active: Promise<ChromeInstallerState> | null = null;
  private abortController: AbortController | null = null;
  private lastProgressAt = Number.NEGATIVE_INFINITY;

  constructor(options: ChromeInstallerOptions) {
    this.appDataDir = options.appDataDir;
    this.manifest = options.manifest ?? chromeManifest;
    this.platform = options.platform ?? process.platform;
    this.platformId = resolveChromePlatform(this.platform, options.arch ?? process.arch);
    this.fetchImpl = options.fetchImpl;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
    this.onStateChange = options.onStateChange;
  }

  getState(): ChromeInstallerState {
    return this.state;
  }

  getExecutablePath(): string | null {
    return this.executablePath;
  }

  async initialize(): Promise<ChromeInstallerState> {
    await rm(chromeTempDir(this.appDataDir), { recursive: true, force: true });
    this.localOverride = null;
    this.executablePath = null;

    if (this.platformSpecification() === null) {
      return this.setState(errorState(null, null, "chrome_platform_unsupported"));
    }

    const local = await readLocalChromeOverride(this.appDataDir);
    if (local !== null) {
      this.localOverride = local;
      return this.setState(await this.resolveLocalState());
    }

    const managed = await this.resolveManagedInstall();
    if (managed !== null) {
      this.executablePath = managed;
      return this.setState(readyState("managed", this.manifest.version));
    }

    this.executablePath = null;
    return this.setState(absentState());
  }

  start(): Promise<ChromeInstallerState> {
    if (this.active !== null) {
      return this.active;
    }
    if (this.state.status === "ready") {
      return Promise.resolve(this.state);
    }

    const abortController = new AbortController();
    this.abortController = abortController;
    const install = Promise.resolve().then(() => this.runInstall(abortController));
    const task = install.then(
      (state) => {
        this.active = null;
        if (this.abortController === abortController) {
          this.abortController = null;
        }
        return state;
      },
      (error: unknown) => {
        this.active = null;
        if (this.abortController === abortController) {
          this.abortController = null;
        }
        throw error;
      },
    );
    this.active = task;
    return task;
  }

  async setLocalBinary(inputPath: string): Promise<ChromeLocalValidation> {
    const result = await validateLocalChromeBinary(inputPath, { platform: this.platform });
    if (!result.ok) {
      return result;
    }

    const override = { path: result.path, version: result.version };
    await writeLocalChromeOverride(this.appDataDir, override);
    this.localOverride = override;
    this.executablePath = result.path;
    this.abortController?.abort();
    this.setState(readyState("local", result.version));
    return result;
  }

  async clearLocalBinary(): Promise<ChromeInstallerState> {
    await removeLocalChromeOverride(this.appDataDir);
    this.localOverride = null;

    const managed = await this.resolveManagedInstall();
    if (managed !== null) {
      this.executablePath = managed;
      return this.setState(readyState("managed", this.manifest.version));
    }

    this.executablePath = null;
    return this.setState(absentState());
  }

  async shutdown(): Promise<void> {
    this.abortController?.abort();
    if (this.active !== null) {
      await this.active.catch(() => undefined);
    }
  }

  private setState(state: ChromeInstallerState): ChromeInstallerState {
    this.state = state;
    this.onStateChange?.(state);
    return state;
  }

  private platformSpecification(): {
    readonly platform: ChromePlatform;
    readonly url: string;
    readonly sha256: string;
    readonly executableRelativePath: string;
  } | null {
    const platform = this.platformId;
    if (platform === null) {
      return null;
    }
    const specification = this.manifest.platforms[platform];
    if (specification === undefined) {
      return null;
    }
    return { platform, ...specification };
  }

  private async runInstall(abortController: AbortController): Promise<ChromeInstallerState> {
    const specification = this.platformSpecification();
    if (specification === null) {
      return this.setState(errorState(null, null, "chrome_platform_unsupported"));
    }

    const signal = abortController.signal;
    if (signal.aborted) {
      return this.recoverAfterAbort();
    }

    await rm(chromeTempDir(this.appDataDir), { recursive: true, force: true });
    if (signal.aborted) {
      return this.recoverAfterAbort();
    }

    if (this.localOverride !== null) {
      const localState = await this.resolveLocalState();
      if (signal.aborted) {
        return this.recoverAfterAbort();
      }
      return this.setState(localState);
    }

    const existing = await this.resolveManagedInstall();
    if (signal.aborted) {
      return this.recoverAfterAbort();
    }
    if (existing !== null) {
      this.executablePath = existing;
      return this.setState(readyState("managed", this.manifest.version));
    }

    const tempDir = join(chromeTempDir(this.appDataDir), randomBytes(8).toString("hex"));
    const archivePath = join(tempDir, "chrome.zip");
    const extractDir = join(tempDir, "extracted");
    const versionDir = join(chromeInstallDir(this.appDataDir), this.manifest.version);

    this.lastProgressAt = Number.NEGATIVE_INFINITY;
    this.setState(downloadingState(this.manifest.version));

    let stage: ChromeInstallerErrorCode = "chrome_download_failed";

    try {
      await mkdir(tempDir, { recursive: true, mode: 0o700 });
      await this.downloadWithRetry(specification.url, archivePath, signal);

      stage = "chrome_checksum_mismatch";
      this.setState(verifyingState(this.manifest.version));
      const actualHash = await hashFileInWorker(archivePath, signal);
      throwIfAborted(signal);
      if (actualHash.toLowerCase() !== specification.sha256.toLowerCase()) {
        throw new ChromeFailure("chrome_checksum_mismatch");
      }

      stage = "chrome_extract_failed";
      this.setState(extractingState(this.manifest.version));
      await extractChromeArchive(archivePath, extractDir, signal);
      throwIfAborted(signal);

      stage = "chrome_executable_not_found";
      await findChromeExecutable(
        extractDir,
        specification.executableRelativePath,
        specification.platform,
      );

      stage = "chrome_extract_failed";
      const marker: InstallMarker = {
        version: this.manifest.version,
        platform: specification.platform,
        executable: specification.executableRelativePath,
      };
      await writeFile(join(extractDir, INSTALL_MARKER_FILE), JSON.stringify(marker), {
        mode: 0o600,
      });

      await mkdir(chromeInstallDir(this.appDataDir), { recursive: true, mode: 0o700 });
      await rm(versionDir, { recursive: true, force: true });
      await rename(extractDir, versionDir);

      if (this.localOverride !== null) {
        return this.setState(await this.resolveLocalState());
      }

      this.executablePath = join(
        versionDir,
        ...specification.executableRelativePath.split("/"),
      );
      return this.setState(readyState("managed", this.manifest.version));
    } catch (error) {
      if (isAbortError(error)) {
        return this.recoverAfterAbort();
      }
      const code = error instanceof ChromeFailure ? error.code : stage;
      return this.setState(errorState("managed", this.manifest.version, code));
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async downloadWithRetry(
    url: string,
    destination: string,
    signal: AbortSignal,
  ): Promise<void> {
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt++) {
      throwIfAborted(signal);
      this.lastProgressAt = Number.NEGATIVE_INFINITY;
      this.setState(downloadingState(this.manifest.version));

      try {
        await downloadFile({
          url,
          destination,
          signal,
          fetchImpl: this.fetchImpl,
          onProgress: (progress) => this.reportProgress(progress),
        });
        return;
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        lastError = error;
        if (attempt === MAX_DOWNLOAD_ATTEMPTS) {
          break;
        }
        await this.sleep(retryDelayMs(attempt, this.random), signal);
      }
    }

    throw lastError instanceof Error ? lastError : new ChromeFailure("chrome_download_failed");
  }

  private reportProgress(progress: DownloadProgress): void {
    const now = this.now();
    if (now - this.lastProgressAt < PROGRESS_INTERVAL_MS) {
      return;
    }
    this.lastProgressAt = now;

    if (this.state.status !== "downloading") {
      return;
    }
    this.setState({ ...this.state, progress: toDownloadProgress(progress) });
  }

  private async recoverAfterAbort(): Promise<ChromeInstallerState> {
    if (this.localOverride !== null) {
      return this.setState(await this.resolveLocalState());
    }

    const managed = await this.resolveManagedInstall();
    if (managed !== null) {
      this.executablePath = managed;
      return this.setState(readyState("managed", this.manifest.version));
    }

    this.executablePath = null;
    return this.setState(absentState());
  }

  private async resolveLocalState(): Promise<ChromeInstallerState> {
    const local = this.localOverride;
    if (local === null) {
      return absentState();
    }

    const check = await checkLocalChromeOverride(local, this.platform);
    if (check === "ok") {
      this.executablePath = local.path;
      return readyState("local", local.version);
    }

    this.executablePath = null;
    return errorState(
      "local",
      local.version,
      check === "missing" ? "chrome_local_missing" : "chrome_local_invalid",
    );
  }

  private async resolveManagedInstall(): Promise<string | null> {
    const specification = this.platformSpecification();
    if (specification === null) {
      return null;
    }

    const versionDir = join(chromeInstallDir(this.appDataDir), this.manifest.version);
    let markerContents: string;
    try {
      markerContents = await readFile(join(versionDir, INSTALL_MARKER_FILE), "utf8");
    } catch {
      return null;
    }

    let marker: InstallMarker;
    try {
      const parsed = installMarkerSchema.safeParse(JSON.parse(markerContents));
      if (!parsed.success) {
        return null;
      }
      marker = parsed.data;
    } catch {
      return null;
    }

    if (
      marker.version !== this.manifest.version ||
      marker.platform !== specification.platform ||
      marker.executable !== specification.executableRelativePath
    ) {
      return null;
    }

    const executable = join(versionDir, ...marker.executable.split("/"));
    try {
      const stats = await stat(executable);
      if (!stats.isFile()) {
        return null;
      }
      await access(executable, constants.X_OK);
    } catch {
      return null;
    }

    return executable;
  }
}

export function createChromeInstaller(options: ChromeInstallerOptions): ChromeInstaller {
  return new ChromeInstallerImpl(options);
}
