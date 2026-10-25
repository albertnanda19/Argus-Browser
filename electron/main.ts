import { fork, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import { readApiCredentials, resolveAppDataDir } from "../backend/app-data";
import { apiInfoSchema, sidecarReadyMessageSchema, type ApiInfo } from "../shared/contracts";

const READY_TIMEOUT_MS = 2000;
const STOP_TIMEOUT_MS = 3000;

let sidecarProcess: ChildProcess | null = null;
let stopPromise: Promise<void> | null = null;
let isQuitting = false;

app.setName("Argus");

function startSidecar(appDataDir: string, uiOrigin: string): Promise<ApiInfo> {
  return new Promise((resolve, reject) => {
    const child = fork(join(__dirname, "..", "backend", "sidecar.js"), {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        ARGUS_APP_DATA_DIR: appDataDir,
        ARGUS_UI_ORIGIN: uiOrigin,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });

    sidecarProcess = child;

    const readyTimeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Sidecar readiness timed out."));
    }, READY_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
      process.stdout.write(`[sidecar] ${chunk.toString()}`);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[sidecar] ${chunk.toString()}`);
    });

    child.on("message", (message: unknown) => {
      if (!sidecarReadyMessageSchema.safeParse(message).success) {
        return;
      }

      clearTimeout(readyTimeout);
      readApiCredentials(appDataDir)
        .then((credentials) => {
          resolve(
            apiInfoSchema.parse({
              baseUrl: `http://127.0.0.1:${credentials.port}`,
              token: credentials.token,
            }),
          );
        })
        .catch(reject);
    });

    child.on("error", (error) => {
      clearTimeout(readyTimeout);
      reject(error);
    });

    child.on("exit", (code, signal) => {
      clearTimeout(readyTimeout);
      if (sidecarProcess === child) {
        sidecarProcess = null;
      }
      reject(
        new Error(`Sidecar exited before ready (code=${String(code)}, signal=${String(signal)}).`),
      );
    });
  });
}

function stopSidecar(): Promise<void> {
  if (stopPromise) {
    return stopPromise;
  }

  const child = sidecarProcess;
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    sidecarProcess = null;
    return Promise.resolve();
  }

  stopPromise = new Promise((resolve) => {
    const forceKillTimeout = setTimeout(() => {
      child.kill("SIGKILL");
    }, STOP_TIMEOUT_MS);

    child.once("exit", () => {
      clearTimeout(forceKillTimeout);
      if (sidecarProcess === child) {
        sidecarProcess = null;
      }
      resolve();
    });

    child.kill("SIGTERM");
  });

  return stopPromise;
}

function createWindow(devServerUrl: string | undefined): void {
  const window = new BrowserWindow({
    width: 900,
    height: 600,
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

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  window.webContents.on("console-message", (details) => {
    console.log(`[renderer:${details.level}] ${details.message}`);
  });

  window.once("ready-to-show", () => {
    window.show();
    console.log(`Window ready: ${window.getTitle()}`);
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

const devServerUrl = process.env.VITE_DEV_SERVER_URL;

void app.whenReady().then(() => {
  const appDataDir = resolveAppDataDir();
  const uiOrigin = devServerUrl ? new URL(devServerUrl).origin : "null";

  const apiInfo = startSidecar(appDataDir, uiOrigin).catch((error: unknown) => {
    console.error("Sidecar unavailable:", error);
    return null;
  });

  ipcMain.handle("api:get-info", () => apiInfo);

  void apiInfo.then(() => {
    createWindow(devServerUrl);
  });
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", (event) => {
  if (isQuitting || !sidecarProcess) {
    return;
  }

  event.preventDefault();
  isQuitting = true;
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
