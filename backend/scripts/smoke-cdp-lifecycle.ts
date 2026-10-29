import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createConnection } from "node:net";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import WebSocket, { type RawData } from "ws";
import type { ChromeInstallerState } from "../../shared/chrome-installer";
import { resolveAppDataDir } from "../app-data";
import { createChromeInstaller } from "../chrome-installer";
import { chromeLocalOverrideFile } from "../chrome-paths";
import { createProfile, resolveProfileDir } from "../profile-store";
import { CLOSE_BUDGET_MS } from "../browser-launcher";
import { createSessionManager, type ChromeExecutableSource, type SessionManager } from "../session-manager";

const execFileAsync = promisify(execFile);
const PROCESS_TIMEOUT_MS = 10_000;
const PROCESS_POLL_MS = 100;
const SCENARIO_CLOSE_LIMIT_MS = 8_500;
const COMMAND_TIMEOUT_MS = 5_000;
const CYCLE_COUNT = 10;
const FDS_ALLOWED_GROWTH = 8;

type ScenarioResult = {
  readonly name: string;
  readonly durationMs: number;
  readonly evidence: string;
};

type Credentials = {
  readonly bearerToken: string;
  readonly extensionCdpUrl: string;
  readonly gatewayUrl: string;
};

type GatewayClose = {
  readonly code: number;
  readonly reason: string;
};

class GatewayClient {
  private readonly socket: WebSocket;
  private readonly pending = new Map<
    number,
    {
      readonly resolve: (value: unknown) => void;
      readonly reject: (error: Error) => void;
      readonly timer: ReturnType<typeof setTimeout>;
    }
  >();
  private nextId = 1;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("message", (data) => this.handleMessage(data));
    socket.on("close", () => this.rejectAll(new Error("CDP gateway socket closed.")));
    socket.on("error", () => this.rejectAll(new Error("CDP gateway socket failed.")));
  }

  static async connect(url: string): Promise<GatewayClient> {
    return await new Promise<GatewayClient>((resolveClient, rejectClient) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        socket.terminate();
        rejectClient(new Error("CDP gateway socket did not open in time."));
      }, COMMAND_TIMEOUT_MS);
      timer.unref?.();
      socket.once("open", () => {
        clearTimeout(timer);
        resolveClient(new GatewayClient(socket));
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        rejectClient(error);
      });
    });
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolveCommand, rejectCommand) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectCommand(new Error("CDP gateway command timed out."));
      }, COMMAND_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { resolve: resolveCommand, reject: rejectCommand, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        rejectCommand(new Error("CDP gateway send failed."));
      }
    });
  }

  close(): void {
    this.socket.terminate();
    this.rejectAll(new Error("CDP gateway client closed."));
  }

  waitForClose(timeoutMs: number): Promise<GatewayClose> {
    return waitForSocketClose(this.socket, timeoutMs);
  }

  private handleMessage(data: RawData): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        typeof data === "string"
          ? data
          : Array.isArray(data)
            ? Buffer.concat(data).toString("utf8")
            : data instanceof ArrayBuffer
              ? Buffer.from(data).toString("utf8")
              : data.toString("utf8"),
      );
    } catch {
      return;
    }
    if (!isRecord(parsed) || typeof parsed.id !== "number") {
      return;
    }
    const entry = this.pending.get(parsed.id);
    if (entry === undefined) {
      return;
    }
    this.pending.delete(parsed.id);
    clearTimeout(entry.timer);
    if (isRecord(parsed.error)) {
      entry.reject(new Error("CDP gateway command failed."));
      return;
    }
    entry.resolve(parsed.result);
  }

  private rejectAll(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }
}

const secrets: string[] = [];
const rawLogLines: string[] = [];
const unhandledRejections: string[] = [];
const ownedPids = new Set<number>();
const sidecarOutputs: string[] = [];

process.on("unhandledRejection", (reason) => {
  unhandledRejections.push(describeError(reason, secrets));
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise<void>((resolveDelay) => {
    setTimeout(resolveDelay, timeoutMs);
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(message)), timeoutMs);
    timer.unref?.();
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

function redact(value: string, redactions: readonly string[]): string {
  let output = value;
  for (const secret of redactions) {
    if (secret.length > 0) {
      output = output.split(secret).join("[redacted]");
    }
  }
  return output;
}

function describeError(error: unknown, redactions: readonly string[]): string {
  const message = error instanceof Error ? error.message : String(error);
  return redact(message, redactions).replace(/\s+/g, " ").trim().slice(0, 500);
}

function log(line: string): void {
  rawLogLines.push(line);
  console.log(redact(line, secrets));
}

function createTempRoot(): string {
  const workspaceRoot = resolve(__dirname, "../../../../..");
  return join(workspaceRoot, "tmp", "testing", `cdp-lifecycle-${randomBytes(4).toString("hex")}`);
}

function assertInside(childPath: string, parentPath: string, label: string): void {
  const child = resolve(childPath);
  const parent = resolve(parentPath);
  if (!child.startsWith(`${parent}${sep}`)) {
    throw new Error(`${label} is outside the expected directory.`);
  }
}

async function runAllowFailure(command: string, args: readonly string[]): Promise<string> {
  try {
    const result = await execFileAsync(command, [...args], { maxBuffer: 16 * 1024 * 1024 });
    return result.stdout;
  } catch (error) {
    if (isRecord(error) && typeof error.stdout === "string") {
      return error.stdout;
    }
    throw error;
  }
}

async function listProcessesContaining(needle: string): Promise<string[]> {
  const stdout = await runAllowFailure("ps", ["-axo", "pid=,command="]);
  return stdout.split("\n").filter((line) => line.includes(needle));
}

async function waitForNoProcess(needle: string, label: string): Promise<void> {
  const deadline = Date.now() + PROCESS_TIMEOUT_MS;
  for (;;) {
    const matches = await listProcessesContaining(needle);
    if (matches.length === 0) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`${label}: ${matches.length} matching process(es) are still running.`);
    }
    await delay(PROCESS_POLL_MS);
  }
}

async function countProcesses(needle: string): Promise<number> {
  return (await listProcessesContaining(needle)).length;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number, label: string): Promise<void> {
  const deadline = Date.now() + PROCESS_TIMEOUT_MS;
  for (;;) {
    if (!isProcessAlive(pid)) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`${label}: Chrome process ${pid} is still running.`);
    }
    await delay(PROCESS_POLL_MS);
  }
}

async function findChromePid(profileDir: string): Promise<number> {
  const matches = (await listProcessesContaining(profileDir)).filter(
    (line) => line.includes("--remote-debugging-pipe") && !line.includes("--type="),
  );
  assert(matches.length === 1, `Expected one Chrome main process for ${profileDir}.`);
  const rawPid = matches[0]?.trim().split(/\s+/)[0];
  const pid = Number(rawPid);
  assert(Number.isInteger(pid) && pid > 0, "Chrome main process PID is invalid.");
  ownedPids.add(pid);
  return pid;
}

async function listListeningSockets(pid: number): Promise<string[]> {
  if (process.platform !== "darwin") {
    return [];
  }
  const stdout = await runAllowFailure("lsof", [
    "-nP",
    "-a",
    "-p",
    String(pid),
    "-iTCP",
    "-sTCP:LISTEN",
  ]);
  return stdout.split("\n").filter((line) => line.trim().length > 0 && !line.startsWith("COMMAND"));
}

async function assertNoTcpCdp(pid: number, label: string): Promise<string> {
  const command = (await runAllowFailure("ps", ["-ww", "-p", String(pid), "-o", "command="])).trim();
  assert(command.length > 0, `${label}: the Chrome process is not running.`);
  assert(command.includes("--remote-debugging-pipe"), `${label}: Chrome is not using the pipe.`);
  assert(!command.includes("--remote-debugging-port"), `${label}: Chrome has a TCP CDP port.`);
  assert(!command.includes("--remote-allow-origins"), `${label}: Chrome allows remote origins.`);
  if (process.platform === "darwin") {
    const listeners = await listListeningSockets(pid);
    assert(listeners.length === 0, `${label}: Chrome has a listening TCP socket.`);
  }
  return `${label}: 0 TCP listeners`;
}

function isPortReachable(port: number): Promise<boolean> {
  return new Promise<boolean>((resolvePort) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const settle = (reachable: boolean): void => {
      socket.destroy();
      resolvePort(reachable);
    };
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.setTimeout(1_000, () => settle(false));
  });
}

async function assertPortClosed(port: number, label: string): Promise<void> {
  if (await isPortReachable(port)) {
    throw new Error(`${label}: port ${port} is still reachable.`);
  }
}

function gatewayPort(credentials: Credentials): number {
  return Number(new URL(credentials.gatewayUrl).port);
}

function capabilityToken(extensionCdpUrl: string): string {
  return new URL(extensionCdpUrl).searchParams.get("token") ?? "";
}

function trackCredentials(credentials: Credentials): void {
  secrets.push(credentials.bearerToken, capabilityToken(credentials.extensionCdpUrl));
}

function readyInstaller(executablePath: string): ChromeExecutableSource {
  const state: ChromeInstallerState = {
    status: "ready",
    source: "local",
    version: "local",
    progress: null,
    error: null,
  };
  return {
    getState: () => state,
    getExecutablePath: () => executablePath,
  };
}

function createManager(appDataDir: string, executablePath: string): SessionManager {
  return createSessionManager({
    appDataDir,
    chromeInstaller: readyInstaller(executablePath),
  });
}

async function waitForStatus(
  manager: SessionManager,
  sessionId: string,
  status: string,
  timeoutMs: number,
): Promise<{ readonly sessionId: string; readonly status: string; readonly durationMs: number }> {
  const startedAt = performance.now();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const session = manager.get(sessionId);
    if (session === null) {
      throw new Error("Session disappeared while waiting for a status.");
    }
    if (session.status === status) {
      return { sessionId, status, durationMs: performance.now() - startedAt };
    }
    if (Date.now() >= deadline) {
      throw new Error(`Session did not reach ${status} in ${timeoutMs} ms.`);
    }
    await delay(20);
  }
}

async function resolveChromeForTesting(): Promise<{ readonly executablePath: string; readonly version: string }> {
  const appDataDir = resolveAppDataDir();
  const installer = createChromeInstaller({ appDataDir });
  const state = await installer.initialize();
  const executablePath = installer.getExecutablePath();
  assert(state.status === "ready", "Chrome for Testing is not installed in Argus app data.");
  assert(executablePath !== null, "Chrome for Testing is ready without an executable path.");
  log(`chrome version: ${state.version ?? "local"}`);
  log("chrome source: app data (read-only)");
  return { executablePath, version: state.version ?? "local" };
}

async function waitForSocketClose(socket: WebSocket, timeoutMs: number): Promise<GatewayClose> {
  if (socket.readyState === WebSocket.CLOSED) {
    return { code: 0, reason: "" };
  }
  return await new Promise<GatewayClose>((resolveClose, rejectClose) => {
    const timer = setTimeout(() => {
      socket.terminate();
      rejectClose(new Error("CDP gateway socket did not close in time."));
    }, timeoutMs);
    timer.unref?.();
    socket.once("close", (code, reason) => {
      clearTimeout(timer);
      resolveClose({ code, reason: reason.toString() });
    });
  });
}

async function measureFds(pid: number): Promise<number> {
  if (process.platform !== "darwin") {
    return 0;
  }
  const stdout = await runAllowFailure("lsof", ["-nP", "-p", String(pid)]);
  return stdout.split("\n").filter((line) => line.trim().length > 0).length;
}

async function countProcessListeners(pid: number): Promise<number> {
  return (await listListeningSockets(pid)).length;
}

function rssMb(): number {
  return process.memoryUsage().rss / (1024 * 1024);
}

async function runKillScenario(
  tempRoot: string,
  executablePath: string,
  portFile: string,
): Promise<ScenarioResult> {
  const startedAt = performance.now();
  const appDataDir = join(tempRoot, "kill-appdata");
  await mkdir(appDataDir, { recursive: true, mode: 0o700 });
  const profile = await createProfile(appDataDir, "Kill lifecycle");
  const manager = createManager(appDataDir, executablePath);
  const profileDir = resolveProfileDir(appDataDir, profile.id);
  let sessionId = "";
  let unexpectedCloses = 0;
  const originalWarn = console.warn;

  try {
    const session = await manager.start(profile.id);
    sessionId = session.id;
    const credentials = manager.getCdpCredentials(session.id);
    assert(credentials !== null, "Kill scenario has no credentials.");
    trackCredentials(credentials);
    const port = gatewayPort(credentials);
    await appendFile(portFile, `kill-gateway=${port}\n`);

    const pid = await findChromePid(profileDir);
    const listenerEvidence = await assertNoTcpCdp(pid, "kill");

    console.warn = (...args: unknown[]) => {
      const text = args.map(String).join(" ");
      if (text.includes(`Session closed unexpectedly: ${session.id}`)) {
        unexpectedCloses += 1;
        return;
      }
      originalWarn(...args);
    };

    process.kill(pid, "SIGKILL");
    const killed = await waitForStatus(manager, session.id, "closed", 5_000);
    const closeStartedAt = performance.now();
    const [first, second] = await Promise.all([
      manager.close(session.id),
      manager.close(session.id),
    ]);
    const closeMs = performance.now() - closeStartedAt;

    assert(first.status === "closed", "Close after SIGKILL did not return closed.");
    assert(second.status === "closed", "Second close after SIGKILL did not return closed.");
    assert(manager.getCdpCredentials(session.id) === null, "Credentials survived close.");
    await waitForProcessExit(pid, "kill");
    await waitForNoProcess(profileDir, "kill process");
    await assertPortClosed(port, "kill");
    assert(unexpectedCloses === 1, "The unexpected close transition ran more than once.");

    return {
      name: "2. Chrome SIGKILL + EOF",
      durationMs: performance.now() - startedAt,
      evidence: `closed in ${killed.durationMs.toFixed(0)} ms; close ${closeMs.toFixed(0)} ms; transitions=1; ${listenerEvidence}; port closed`,
    };
  } finally {
    console.warn = originalWarn;
    await manager.shutdown().catch(() => undefined);
    if (sessionId.length > 0) {
      await manager.close(sessionId).catch(() => undefined);
    }
  }
}

async function runHangScenario(
  tempRoot: string,
  executablePath: string,
  portFile: string,
): Promise<ScenarioResult> {
  const startedAt = performance.now();
  const appDataDir = join(tempRoot, "hang-appdata");
  await mkdir(appDataDir, { recursive: true, mode: 0o700 });
  const profile = await createProfile(appDataDir, "Hang lifecycle");
  const manager = createManager(appDataDir, executablePath);
  const profileDir = resolveProfileDir(appDataDir, profile.id);
  let pid = 0;
  let isStopped = false;

  try {
    const session = await manager.start(profile.id);
    const credentials = manager.getCdpCredentials(session.id);
    assert(credentials !== null, "Hang scenario has no credentials.");
    trackCredentials(credentials);
    const port = gatewayPort(credentials);
    await appendFile(portFile, `hang-gateway=${port}\n`);

    pid = await findChromePid(profileDir);
    const listenerEvidence = await assertNoTcpCdp(pid, "hang");
    process.kill(pid, "SIGSTOP");
    isStopped = true;

    const closeStartedAt = performance.now();
    const closed = await withTimeout(
      manager.close(session.id),
      SCENARIO_CLOSE_LIMIT_MS,
      "Close did not finish while Chrome was stopped.",
    );
    const closeMs = performance.now() - closeStartedAt;

    assert(closeMs <= CLOSE_BUDGET_MS, `Hang close exceeded the budget: ${closeMs.toFixed(0)} ms.`);
    assert(closed.status === "closed", "Hang close did not return closed.");
    await waitForProcessExit(pid, "hang");
    isStopped = false;
    await waitForNoProcess(profileDir, "hang process");
    await assertPortClosed(port, "hang");
    assert(manager.getCdpCredentials(session.id) === null, "Hang credentials survived close.");

    return {
      name: "3. Chrome SIGSTOP (hang)",
      durationMs: performance.now() - startedAt,
      evidence: `close ${closeMs.toFixed(0)} ms of ${CLOSE_BUDGET_MS} ms budget; SIGKILL reached; ${listenerEvidence}; port closed`,
    };
  } finally {
    if (isStopped && pid > 0 && isProcessAlive(pid)) {
      try {
        process.kill(pid, "SIGCONT");
      } catch {}
    }
    await manager.shutdown().catch(() => undefined);
  }
}

async function runGatewayClientScenario(
  tempRoot: string,
  executablePath: string,
  portFile: string,
): Promise<ScenarioResult> {
  const startedAt = performance.now();
  const appDataDir = join(tempRoot, "gateway-appdata");
  await mkdir(appDataDir, { recursive: true, mode: 0o700 });
  const profile = await createProfile(appDataDir, "Gateway lifecycle");
  const manager = createManager(appDataDir, executablePath);
  const profileDir = resolveProfileDir(appDataDir, profile.id);
  let client: GatewayClient | null = null;

  try {
    const session = await manager.start(profile.id);
    const credentials = manager.getCdpCredentials(session.id);
    assert(credentials !== null, "Gateway scenario has no credentials.");
    trackCredentials(credentials);
    const port = gatewayPort(credentials);
    await appendFile(portFile, `gateway-client=${port}\n`);
    const pid = await findChromePid(profileDir);

    client = await GatewayClient.connect(credentials.extensionCdpUrl);
    const targets = await client.send("Target.getTargets");
    assert(isRecord(targets) && Array.isArray(targets.targetInfos), "Gateway command failed.");

    const closeStartedAt = performance.now();
    const socketClose = client.waitForClose(3_000);
    const closed = await withTimeout(
      manager.close(session.id),
      SCENARIO_CLOSE_LIMIT_MS,
      "Close with a connected gateway client timed out.",
    );
    const closeMs = performance.now() - closeStartedAt;
    const socketResult = await socketClose;

    assert(closed.status === "closed", "Gateway close did not return closed.");
    assert(!socketResult.reason.includes(credentials.bearerToken), "Close reason contains a token.");
    assert(
      !socketResult.reason.includes(capabilityToken(credentials.extensionCdpUrl)),
      "Close reason contains a capability token.",
    );
    await waitForProcessExit(pid, "gateway");
    await waitForNoProcess(profileDir, "gateway process");
    await assertPortClosed(port, "gateway");

    return {
      name: "4. Gateway close with client",
      durationMs: performance.now() - startedAt,
      evidence: `client served, socket ${socketResult.code} "${socketResult.reason}", session close ${closeMs.toFixed(0)} ms, port closed`,
    };
  } finally {
    client?.close();
    await manager.shutdown().catch(() => undefined);
  }
}

async function readApiInfo(
  appDataDir: string,
): Promise<{ readonly port: number; readonly token: string }> {
  const file = join(appDataDir, "api.json");
  const deadline = Date.now() + PROCESS_TIMEOUT_MS;
  for (;;) {
    try {
      const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
      if (
        isRecord(parsed) &&
        typeof parsed.port === "number" &&
        Number.isInteger(parsed.port) &&
        parsed.port > 0 &&
        typeof parsed.token === "string" &&
        parsed.token.length > 0
      ) {
        return { port: parsed.port, token: parsed.token };
      }
    } catch {}
    if (Date.now() >= deadline) {
      throw new Error("Sidecar did not write api.json in time.");
    }
    await delay(PROCESS_POLL_MS);
  }
}

async function apiRequest(
  port: number,
  token: string,
  path: string,
  init: RequestInit,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await fetch(`http://127.0.0.1:${port}/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS),
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text.length === 0 ? null : JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

function waitForChildExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      rejectExit(new Error("Sidecar did not exit in time."));
    }, timeoutMs);
    timer.unref?.();
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });
}

async function runSidecarScenario(
  tempRoot: string,
  executablePath: string,
  version: string,
  portFile: string,
): Promise<ScenarioResult> {
  const startedAt = performance.now();
  const appDataDir = join(tempRoot, "sidecar-appdata");
  const profileDirRoot = join(appDataDir, "profiles");
  await mkdir(join(appDataDir, "browsers", "chrome-for-testing"), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(
    chromeLocalOverrideFile(appDataDir),
    JSON.stringify({ path: executablePath, version }),
    { mode: 0o600 },
  );

  const child = spawn(process.execPath, [join(__dirname, "..", "sidecar.js")], {
    env: {
      ...process.env,
      ARGUS_APP_DATA_DIR: appDataDir,
      ARGUS_UI_ORIGIN: "http://127.0.0.1:59999",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (data: Buffer) => sidecarOutputs.push(data.toString("utf8")));
  child.stderr?.on("data", (data: Buffer) => sidecarOutputs.push(data.toString("utf8")));

  try {
    const api = await readApiInfo(appDataDir);
    secrets.push(api.token);
    await appendFile(portFile, `sidecar-api=${api.port}\n`);

    const profileResponse = await apiRequest(api.port, api.token, "/profiles", {
      method: "POST",
      body: JSON.stringify({ name: "Sidecar lifecycle" }),
    });
    assert(profileResponse.status === 201, "Sidecar profile creation failed.");
    assert(
      isRecord(profileResponse.body) &&
        isRecord(profileResponse.body.data) &&
        typeof profileResponse.body.data.id === "string",
      "Sidecar profile response is invalid.",
    );
    const profileId = profileResponse.body.data.id;

    const sessionResponse = await apiRequest(api.port, api.token, "/sessions", {
      method: "POST",
      body: JSON.stringify({ profileId }),
    });
    assert(sessionResponse.status === 201, "Sidecar session creation failed.");
    assert(
      isRecord(sessionResponse.body) &&
        isRecord(sessionResponse.body.data) &&
        sessionResponse.body.data.status === "ready",
      "Sidecar session is not ready.",
    );

    const profileDir = join(profileDirRoot, profileId);
    assertInside(profileDir, profileDirRoot, "sidecar profile");
    const chromePid = await findChromePid(profileDir);
    await assertNoTcpCdp(chromePid, "sidecar");
    const listeningBefore = await listListeningSockets(child.pid ?? 0);
    assert(listeningBefore.length > 0, "Sidecar has no listening sockets before shutdown.");
    const ports = listeningBefore
      .map((line) => /:(\d+)\s+\(LISTEN\)/.exec(line)?.[1])
      .filter((port): port is string => port !== undefined)
      .map(Number);
    for (const port of ports) {
      await appendFile(portFile, `sidecar-listener=${port}\n`);
    }

    const shutdownStartedAt = performance.now();
    child.kill("SIGTERM");
    child.kill("SIGTERM");
    const exit = await waitForChildExit(child, CLOSE_BUDGET_MS);
    const shutdownMs = performance.now() - shutdownStartedAt;

    assert(exit.code === 0, `Sidecar exited with code ${String(exit.code)}.`);
    assert(shutdownMs <= CLOSE_BUDGET_MS, `Sidecar shutdown exceeded the budget: ${shutdownMs.toFixed(0)} ms.`);
    await waitForNoProcess(profileDir, "sidecar process");
    for (const port of ports) {
      await assertPortClosed(port, "sidecar");
    }

    return {
      name: "5. Sidecar SIGTERM with session",
      durationMs: performance.now() - startedAt,
      evidence: `exit ${String(exit.code)} in ${shutdownMs.toFixed(0)} ms of ${CLOSE_BUDGET_MS} ms, double SIGTERM, ${ports.length} listener(s) closed, Chrome exited`,
    };
  } finally {
    if (isProcessAlive(child.pid ?? 0)) {
      child.kill("SIGKILL");
      await waitForChildExit(child, 5_000).catch(() => undefined);
    }
  }
}

async function runCycleScenario(
  tempRoot: string,
  executablePath: string,
  portFile: string,
): Promise<ScenarioResult> {
  const startedAt = performance.now();
  const appDataDir = join(tempRoot, "cycle-appdata");
  await mkdir(appDataDir, { recursive: true, mode: 0o700 });
  const profile = await createProfile(appDataDir, "Cycle lifecycle");
  const manager = createManager(appDataDir, executablePath);
  const profileDir = resolveProfileDir(appDataDir, profile.id);
  const initialProcesses = await countProcesses(profileDir);
  const initialListeners = await countProcessListeners(process.pid);
  const initialFds = await measureFds(process.pid);
  const initialRss = rssMb();
  let firstFds = 0;
  let firstRss = 0;

  try {
    for (let cycle = 1; cycle <= CYCLE_COUNT; cycle += 1) {
      const session = await manager.start(profile.id);
      const credentials = manager.getCdpCredentials(session.id);
      assert(credentials !== null, `Cycle ${cycle} has no credentials.`);
      trackCredentials(credentials);
      const port = gatewayPort(credentials);
      await appendFile(portFile, `cycle-${cycle}-gateway=${port}\n`);
      const pid = await findChromePid(profileDir);
      await assertNoTcpCdp(pid, `cycle ${cycle}`);

      const closed = await withTimeout(
        manager.close(session.id),
        SCENARIO_CLOSE_LIMIT_MS,
        `Cycle ${cycle} close timed out.`,
      );
      assert(closed.status === "closed", `Cycle ${cycle} did not close.`);
      await waitForProcessExit(pid, `cycle ${cycle}`);
      await waitForNoProcess(profileDir, `cycle ${cycle} process`);
      await assertPortClosed(port, `cycle ${cycle}`);

      if (cycle === 1) {
        firstFds = await measureFds(process.pid);
        firstRss = rssMb();
      }
    }

    const finalProcesses = await countProcesses(profileDir);
    const finalListeners = await countProcessListeners(process.pid);
    const finalFds = await measureFds(process.pid);
    const finalRss = rssMb();

    assert(initialProcesses === 0, "Cycle baseline already had Chrome processes.");
    assert(finalProcesses === 0, "Chrome processes remain after the cycle run.");
    assert(finalListeners === initialListeners, "Listener count grew after the cycle run.");
    assert(
      finalFds - firstFds <= FDS_ALLOWED_GROWTH,
      `File descriptors grew by ${finalFds - firstFds}.`,
    );

    return {
      name: "6. Ten start/close cycles",
      durationMs: performance.now() - startedAt,
      evidence: `processes ${initialProcesses}→${finalProcesses}, listeners ${initialListeners}→${finalListeners}, fds ${initialFds}→${firstFds}→${finalFds}, RSS ${initialRss.toFixed(0)}→${firstRss.toFixed(0)}→${finalRss.toFixed(0)} MB`,
    };
  } finally {
    await manager.shutdown().catch(() => undefined);
  }
}

async function runIsolationScenario(
  tempRoot: string,
  executablePath: string,
  portFile: string,
): Promise<ScenarioResult> {
  const startedAt = performance.now();
  const appDataDir = join(tempRoot, "isolation-appdata");
  await mkdir(appDataDir, { recursive: true, mode: 0o700 });
  const firstProfile = await createProfile(appDataDir, "Isolation first");
  const secondProfile = await createProfile(appDataDir, "Isolation second");
  const manager = createManager(appDataDir, executablePath);
  const firstDir = resolveProfileDir(appDataDir, firstProfile.id);
  const secondDir = resolveProfileDir(appDataDir, secondProfile.id);
  let clientB: GatewayClient | null = null;

  try {
    const first = await manager.start(firstProfile.id);
    const second = await manager.start(secondProfile.id);
    const firstCredentials = manager.getCdpCredentials(first.id);
    const secondCredentials = manager.getCdpCredentials(second.id);
    assert(firstCredentials !== null, "First isolation session has no credentials.");
    assert(secondCredentials !== null, "Second isolation session has no credentials.");
    trackCredentials(firstCredentials);
    trackCredentials(secondCredentials);
    const firstPort = gatewayPort(firstCredentials);
    const secondPort = gatewayPort(secondCredentials);
    await appendFile(portFile, `isolation-a-gateway=${firstPort}\nisolation-b-gateway=${secondPort}\n`);

    const firstPid = await findChromePid(firstDir);
    const secondPid = await findChromePid(secondDir);
    await assertNoTcpCdp(firstPid, "isolation a");
    await assertNoTcpCdp(secondPid, "isolation b");

    clientB = await GatewayClient.connect(secondCredentials.extensionCdpUrl);
    const beforeKill = await clientB.send("Target.getTargets");
    assert(isRecord(beforeKill) && Array.isArray(beforeKill.targetInfos), "Second gateway failed.");

    process.kill(firstPid, "SIGKILL");
    await waitForStatus(manager, first.id, "closed", 5_000);
    assert(manager.get(second.id)?.status === "ready", "The second session did not stay ready.");
    assert(manager.getCdpCredentials(first.id) === null, "Dead session kept credentials.");

    const contextB = manager.getContext(second.id);
    assert(contextB !== null, "The second session has no context.");
    const page = contextB.pages().at(-1) ?? (await contextB.newPage());
    await page.goto(`data:text/html,${encodeURIComponent("<h1>ok</h1>")}`, {
      timeout: 10_000,
    });
    const heading = await page.locator("h1").innerText({ timeout: 5_000 });
    assert(heading.trim() === "ok", "The second session cannot navigate after the first died.");

    const afterKill = await clientB.send("Target.getTargets");
    assert(isRecord(afterKill) && Array.isArray(afterKill.targetInfos), "Second gateway stopped serving.");

    await waitForProcessExit(firstPid, "isolation a");
    await waitForNoProcess(firstDir, "isolation a process");
    await assertPortClosed(firstPort, "isolation a");

    const secondClosed = await manager.close(second.id);
    assert(secondClosed.status === "closed", "The second session did not close.");
    await waitForProcessExit(secondPid, "isolation b");
    await waitForNoProcess(secondDir, "isolation b process");
    await assertPortClosed(secondPort, "isolation b");

    return {
      name: "7. Two sessions, one killed",
      durationMs: performance.now() - startedAt,
      evidence: "dead session closed; survivor ready, navigated, gateway served; both ports closed",
    };
  } finally {
    clientB?.close();
    await manager.shutdown().catch(() => undefined);
  }
}

function assertNoSecretLeak(): void {
  const haystacks = [rawLogLines.join("\n"), ...sidecarOutputs];
  for (const secret of secrets) {
    if (secret.length === 0) {
      continue;
    }
    for (const haystack of haystacks) {
      assert(!haystack.includes(secret), "A token was written to the smoke log.");
    }
  }
  const tokenPattern = /token=[A-Za-z0-9_-]{20,}/;
  for (const haystack of haystacks) {
    assert(!tokenPattern.test(haystack), "A capability URL was written to the smoke log.");
  }
  log("secret leak check: 0");
}

function printTable(results: readonly ScenarioResult[]): void {
  log("scenario | duration | evidence");
  for (const result of results) {
    log(`${result.name} | ${result.durationMs.toFixed(0)} ms | ${result.evidence}`);
  }
  const worstClose = Math.max(
    ...results
      .filter((result) => result.name.startsWith("3."))
      .map((result) => result.durationMs),
    0,
  );
  log(`worst close scenario: ${worstClose.toFixed(0)} ms (budget ${CLOSE_BUDGET_MS} ms)`);
}

async function run(): Promise<void> {
  const tempRoot = createTempRoot();
  const portFile = join(tempRoot, "port.txt");
  await mkdir(tempRoot, { recursive: true, mode: 0o700 });
  await writeFile(portFile, `tmp-root=${tempRoot}\n`, { mode: 0o600 });
  log(`tmp root: ${tempRoot}`);
  const chrome = await resolveChromeForTesting();
  const results: ScenarioResult[] = [];
  let failure: unknown = null;

  try {
    results.push(await runKillScenario(tempRoot, chrome.executablePath, portFile));
    results.push(await runHangScenario(tempRoot, chrome.executablePath, portFile));
    results.push(await runGatewayClientScenario(tempRoot, chrome.executablePath, portFile));
    results.push(await runSidecarScenario(tempRoot, chrome.executablePath, chrome.version, portFile));
    results.push(await runCycleScenario(tempRoot, chrome.executablePath, portFile));
    results.push(await runIsolationScenario(tempRoot, chrome.executablePath, portFile));
    await delay(100);
    assertNoSecretLeak();
    assert(unhandledRejections.length === 0, `Unhandled rejections: ${unhandledRejections.length}.`);
    log("unhandled rejections: 0");
  } catch (error) {
    failure = error;
  } finally {
    for (const pid of ownedPids) {
      if (isProcessAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
    await rm(tempRoot, { recursive: true, force: true });
    log(`cleanup: removed ${tempRoot}`);
  }

  printTable(results);
  if (failure !== null) {
    throw failure;
  }
  log("SMOKE PASS");
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  try {
    await run();
    log(`duration: ${Date.now() - startedAt} ms`);
  } catch (error) {
    process.exitCode = 1;
    log(`duration: ${Date.now() - startedAt} ms`);
    log(`SMOKE FAILED: ${describeError(error, secrets)}`);
    for (const rejection of unhandledRejections) {
      log(`unhandled rejection: ${rejection}`);
    }
  }
}

void main();
