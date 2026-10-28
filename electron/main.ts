import { fork, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import { readApiCredentials, resolveAppDataDir } from "../backend/app-data";
import {
  apiInfoSchema,
  sidecarReadyMessageSchema,
  sidecarStateSchema,
  type SidecarState,
} from "../shared/contracts";
import { RestartPolicy } from "../shared/restart-policy";

const READY_TIMEOUT_MS = 2000;
const STOP_TIMEOUT_MS = 10_000;

type StartMode = "supervised" | "manual";

const appDataDir = resolve(resolveAppDataDir());
mkdirSync(appDataDir, { recursive: true, mode: 0o700 });

app.setName("Argus");
app.setPath("userData", appDataDir);

const devServerUrl = process.env.VITE_DEV_SERVER_URL;
const restartPolicy = new RestartPolicy();

let sidecarProcess: ChildProcess | null = null;
let sidecarState: SidecarState = { status: "starting" };
let mainWindow: BrowserWindow | null = null;
let isQuitting = false;
let isStartingSidecar = false;
let isStoppingSidecar = false;
let isManualRestarting = false;
let restartTimer: NodeJS.Timeout | null = null;

function setSidecarState(state: SidecarState): void {
  sidecarState = state;
}

function clearRestartTimer(): void {
  if (!restartTimer) {
    return;
  }

  clearTimeout(restartTimer);
  restartTimer = null;
}

function openWindow(): void {
  if (mainWindow) {
    return;
  }

  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    title: "Argus",
    backgroundColor: "#0f172a",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow = window;

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  window.webContents.on("console-message", (details) => {
    console.log(`[renderer:${details.level}] ${details.message}`);
  });

  window.once("ready-to-show", () => {
    window.show();
    console.log(`Window ready: ${window.getTitle()}`);
  });

  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  if (devServerUrl) {
    void window.loadURL(devServerUrl).catch((error: unknown) => {
      console.error("Failed to load renderer:", error);
    });
  } else {
    void window.loadFile(join(__dirname, "../../renderer/index.html")).catch((error: unknown) => {
      console.error("Failed to load renderer:", error);
    });
  }
}

function focusWindow(): void {
  if (!mainWindow) {
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.show();
  mainWindow.focus();
}

function scheduleRestart(): void {
  if (isQuitting || isStoppingSidecar || restartTimer) {
    return;
  }

  const decision = restartPolicy.next();

  if (decision.action === "exhausted") {
    setSidecarState({ status: "error" });
    console.error("Sidecar restart limit reached; manual restart required.");
    openWindow();
    return;
  }

  setSidecarState({ status: "starting" });
  console.warn(`Sidecar restart scheduled in ${decision.delayMs} ms.`);

  restartTimer = setTimeout(() => {
    restartTimer = null;
    startSidecar("supervised");
  }, decision.delayMs);
}

function startSidecar(mode: StartMode): void {
  if (isQuitting || isStartingSidecar) {
    return;
  }

  isStartingSidecar = true;
  setSidecarState({ status: "starting" });

  let child: ChildProcess;

  try {
    child = fork(join(__dirname, "..", "backend", "sidecar.js"), {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        ARGUS_APP_DATA_DIR: appDataDir,
        ARGUS_UI_ORIGIN: devServerUrl ? new URL(devServerUrl).origin : "null",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
  } catch (error: unknown) {
    isStartingSidecar = false;
    console.error("Failed to spawn sidecar:", error);

    if (mode === "manual") {
      setSidecarState({ status: "error" });
      openWindow();
      return;
    }

    scheduleRestart();
    return;
  }

  sidecarProcess = child;

  let isReady = false;
  let hasConnected = false;
  let hasExited = false;
  let forceKillTimeout: NodeJS.Timeout | null = null;

  const readyTimeout = setTimeout(() => {
    if (hasExited) {
      return;
    }

    console.error("Sidecar readiness timed out.");
    child.kill("SIGTERM");
    forceKillTimeout = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, STOP_TIMEOUT_MS);
    forceKillTimeout.unref();
  }, READY_TIMEOUT_MS);

  child.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(`[sidecar] ${chunk.toString()}`);
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[sidecar] ${chunk.toString()}`);
  });

  const handleGone = (reason: string): void => {
    if (hasExited) {
      return;
    }

    hasExited = true;
    clearTimeout(readyTimeout);

    if (forceKillTimeout) {
      clearTimeout(forceKillTimeout);
    }

    isStartingSidecar = false;

    if (sidecarProcess === child) {
      sidecarProcess = null;
    }

    if (isQuitting || isStoppingSidecar) {
      return;
    }

    console.error(reason);

    if (mode === "manual" && !hasConnected) {
      setSidecarState({ status: "error" });
      console.error("Manual sidecar start failed; manual restart required.");
      openWindow();
      return;
    }

    scheduleRestart();
  };

  child.on("message", (message: unknown) => {
    if (isReady || !sidecarReadyMessageSchema.safeParse(message).success) {
      return;
    }

    isReady = true;
    clearTimeout(readyTimeout);

    readApiCredentials(appDataDir)
      .then((credentials) => {
        if (isQuitting || sidecarProcess !== child) {
          return;
        }

        hasConnected = true;
        isStartingSidecar = false;
        setSidecarState({
          status: "connected",
          apiInfo: apiInfoSchema.parse({
            baseUrl: `http://127.0.0.1:${credentials.port}`,
            token: credentials.token,
          }),
        });
        openWindow();
      })
      .catch(() => {
        console.error("Failed to read sidecar credentials.");

        if (hasExited || child.exitCode !== null || child.signalCode !== null) {
          return;
        }

        if (forceKillTimeout) {
          clearTimeout(forceKillTimeout);
        }

        child.kill("SIGTERM");
        forceKillTimeout = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
        }, STOP_TIMEOUT_MS);
        forceKillTimeout.unref();
      });
  });

  child.on("error", (error) => {
    handleGone(`Sidecar process error: ${error.message}`);
  });

  child.on("exit", (code, signal) => {
    handleGone(
      `Sidecar exited unexpectedly (code=${String(code)}, signal=${String(signal)}).`,
    );
  });
}

function stopSidecar(): Promise<void> {
  const child = sidecarProcess;

  if (!child || child.exitCode !== null || child.signalCode !== null) {
    sidecarProcess = null;
    return Promise.resolve();
  }

  isStoppingSidecar = true;

  return new Promise((resolve) => {
    const forceKillTimeout = setTimeout(() => {
      console.error("Sidecar did not stop in time; killing it.");
      child.kill("SIGKILL");
    }, STOP_TIMEOUT_MS);

    child.once("exit", () => {
      clearTimeout(forceKillTimeout);
      isStoppingSidecar = false;

      if (sidecarProcess === child) {
        sidecarProcess = null;
      }

      resolve();
    });

    child.kill("SIGTERM");
  });
}

async function restartSidecarManually(): Promise<void> {
  if (isQuitting || isManualRestarting) {
    return;
  }

  isManualRestarting = true;

  try {
    console.log("Manual sidecar restart requested.");
    clearRestartTimer();
    restartPolicy.reset();
    setSidecarState({ status: "starting" });

    await stopSidecar();

    if (!isQuitting) {
      startSidecar("manual");
    }
  } finally {
    isManualRestarting = false;
  }
}

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", (event) => {
  if (isQuitting) {
    return;
  }

  isQuitting = true;
  clearRestartTimer();

  if (!sidecarProcess) {
    return;
  }

  event.preventDefault();
  void stopSidecar().finally(() => {
    app.quit();
  });
});

process.on("SIGTERM", () => {
  app.quit();
});

process.on("SIGINT", () => {
  app.quit();
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    console.log("Second instance detected; focusing the existing window.");
    openWindow();
    focusWindow();
  });

  void app.whenReady().then(() => {
    ipcMain.handle("api:get-state", () => sidecarStateSchema.parse(sidecarState));
    ipcMain.handle("api:restart", () => restartSidecarManually());

    startSidecar("supervised");
  });
}
