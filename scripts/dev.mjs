import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const electronPath = require("electron");

const server = await createServer();
await server.listen();

const address = server.httpServer?.address();

if (!address || typeof address === "string") {
  await server.close();
  throw new Error("Vite dev server did not bind a TCP port.");
}

const devServerUrl = `http://127.0.0.1:${address.port}`;
const electron = spawn(electronPath, ["dist/node/electron/main.js"], {
  stdio: "inherit",
  env: { ...process.env, VITE_DEV_SERVER_URL: devServerUrl },
});

let electronExitCode = null;
const electronExit = new Promise((resolve) => {
  electron.once("exit", (code) => {
    electronExitCode = code ?? 0;
    resolve();
  });
});

let isStopping = false;

async function stop(requestedExitCode) {
  if (isStopping) {
    return;
  }
  isStopping = true;

  electron.kill("SIGTERM");

  const timeout = new Promise((resolve) => {
    setTimeout(resolve, 5000);
  });
  await Promise.race([electronExit, timeout]);

  if (electronExitCode === null) {
    electron.kill("SIGKILL");
  }

  await server.close();
  process.exit(electronExitCode ?? requestedExitCode);
}

electron.once("exit", () => {
  void stop(0);
});

process.on("SIGINT", () => {
  void stop(130);
});

process.on("SIGTERM", () => {
  void stop(143);
});
