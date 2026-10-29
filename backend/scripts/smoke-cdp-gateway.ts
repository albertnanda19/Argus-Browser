import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, appendFile, constants, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { join, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import type { Browser, ConnectOverCDPTransport } from "playwright-core";
import WebSocket, { type ClientOptions, type RawData } from "ws";
import { resolveAppDataDir } from "../app-data";
import { chromeInstallDir } from "../chrome-paths";
import {
  launchCdpPipe,
  type CdpPipe,
  type CdpWireMessage,
} from "../cdp-pipe";
import {
  createCdpRouter,
  type CdpClientSink,
  type CdpRouter,
  type CdpRouterClient,
} from "../cdp-router";
import { startCdpGateway, type CdpGateway } from "../cdp-gateway";

const execFileAsync = promisify(execFile);
const PROCESS_TIMEOUT_MS = 10_000;
const PROCESS_POLL_MS = 100;
const CONNECT_TIMEOUT_MS = 30_000;
const STAGEHAND_INIT_TIMEOUT_MS = 90_000;
const STAGEHAND_CLOSE_TIMEOUT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 15_000;
const AUTHORIZATION_TIMEOUT_MS = 5_000;
const LATENCY_SAMPLES = 50;
const MARKER_SCRIPT = "window.__argusCdpGatewayMarker = 'present';";
const ORIGIN_HTML = `<!doctype html>
<html>
  <body>
    <main>
      <h1>Argus CDP gateway smoke</h1>
      <button id="go" type="button">Lanjut</button>
      <div id="result">idle</div>
    </main>
    <script>
      document.getElementById("go").addEventListener("click", () => {
        document.getElementById("result").textContent = "clicked";
      });
    </script>
  </body>
</html>`;

type StagehandPage = {
  goto(url: string, options?: { readonly waitUntil?: "domcontentloaded"; readonly timeout?: number }): Promise<unknown>;
  snapshot(options?: { readonly timeout?: number }): Promise<{ readonly formattedTree: string }>;
  click(x: number, y: number): Promise<void>;
  evaluate<Result = unknown>(expression: string): Promise<Result>;
};

type StagehandInstance = {
  readonly browser: {
    readonly context: {
      pages(): Promise<StagehandPage[]>;
      newPage(url?: string): Promise<StagehandPage>;
    };
  };
  close(): Promise<void>;
};

type Session = {
  readonly pipe: CdpPipe;
  readonly router: CdpRouter;
  readonly gateway: CdpGateway;
  readonly apiToken: string;
  browser: Browser | null;
};

type OriginServer = {
  readonly url: string;
  close(): Promise<void>;
};

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

function redact(value: string, secrets: readonly string[]): string {
  let output = value;
  for (const secret of secrets) {
    if (secret.length > 0) {
      output = output.split(secret).join("[redacted]");
    }
  }
  return output;
}

function describeError(error: unknown, secrets: readonly string[]): string {
  const message = error instanceof Error ? error.message : String(error);
  return redact(message, secrets).replace(/\s+/g, " ").trim().slice(0, 500);
}

function createTempRoot(): string {
  const workspaceRoot = resolve(__dirname, "../../../../..");
  return join(workspaceRoot, "tmp", "testing", `cdp-gateway-${randomBytes(4).toString("hex")}`);
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
    throw new Error(`${label}: gateway port ${port} is still reachable.`);
  }
}

async function resolveChromeForTesting(): Promise<{ readonly executablePath: string; readonly version: string }> {
  const appDataDir = resolveAppDataDir();
  const installDir = chromeInstallDir(appDataDir);
  const localFile = join(installDir, "local.json");
  try {
    const parsed: unknown = JSON.parse(await readFile(localFile, "utf8"));
    if (isRecord(parsed) && typeof parsed.path === "string" && parsed.path.length > 0) {
      await access(parsed.path, constants.X_OK);
      return {
        executablePath: parsed.path,
        version: typeof parsed.version === "string" ? parsed.version : "local",
      };
    }
  } catch {}

  const entries = await readdir(installDir, { withFileTypes: true });
  const versions = entries
    .filter((entry) => entry.isDirectory() && /^\d+\./.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));

  for (const version of versions) {
    const versionDir = join(installDir, version);
    const markerFile = join(versionDir, ".argus-install.json");
    try {
      const parsed: unknown = JSON.parse(await readFile(markerFile, "utf8"));
      if (isRecord(parsed) && typeof parsed.executable === "string" && parsed.executable.length > 0) {
        const executablePath = join(versionDir, parsed.executable);
        await access(executablePath, constants.X_OK);
        return { executablePath, version };
      }
    } catch {
      continue;
    }
  }

  throw new Error("Chrome for Testing is not installed in Argus app data; this smoke test does not download it.");
}

async function startOriginServer(): Promise<OriginServer> {
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(ORIGIN_HTML);
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", rejectListen);
      resolveListen();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Origin server did not receive a TCP port.");
  }

  return {
    url: `http://127.0.0.1:${address.port}/`,
    close() {
      return new Promise<void>((resolveClose) => {
        server.closeAllConnections();
        server.close(() => resolveClose());
      });
    },
  };
}

function toWireCommand(message: object): CdpWireMessage {
  if (
    !("id" in message) ||
    typeof message.id !== "number" ||
    !("method" in message) ||
    typeof message.method !== "string" ||
    ("sessionId" in message && typeof message.sessionId !== "string")
  ) {
    throw new Error("Playwright sent an invalid CDP message.");
  }
  const params = "params" in message ? message.params : undefined;
  const sessionId =
    "sessionId" in message && typeof message.sessionId === "string" ? message.sessionId : undefined;
  return {
    id: message.id,
    method: message.method,
    ...(params === undefined ? {} : { params }),
    ...(sessionId === undefined ? {} : { sessionId }),
  };
}

async function connectPlaywright(router: CdpRouter): Promise<{ browser: Browser; client: CdpRouterClient }> {
  const { chromium } = await import("playwright-core");
  let client: CdpRouterClient | null = null;
  const transport: ConnectOverCDPTransport = {
    send(message) {
      if (client === null) {
        throw new Error("Playwright CDP client is not ready.");
      }
      client.send(toWireCommand(message));
    },
    close() {
      if (client !== null) {
        void client.close();
      }
    },
  };

  const sink: CdpClientSink = {
    send(message) {
      transport.onmessage?.(message);
      return true;
    },
    close() {
      transport.onclose?.("closed");
    },
  };

  client = await router.addClient(sink);
  const browser = await chromium.connectOverCDP(transport, { timeout: CONNECT_TIMEOUT_MS });
  return { browser, client };
}

class GatewayWebSocketClient {
  private readonly socket: WebSocket;
  private readonly pending = new Map<
    number,
    {
      readonly resolve: (value: unknown) => void;
      readonly reject: (error: Error) => void;
      readonly timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly events: CdpWireMessage[] = [];
  private nextId = 1;
  private isClosed = false;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("message", (data) => this.handleMessage(data));
    socket.on("close", () => this.handleClose());
    socket.on("error", () => this.handleClose());
  }

  static async connect(url: string, options?: ClientOptions): Promise<GatewayWebSocketClient> {
    return await new Promise<GatewayWebSocketClient>((resolveClient, rejectClient) => {
      const socket = new WebSocket(url, options);
      const timer = setTimeout(() => {
        socket.terminate();
        rejectClient(new Error("CDP WebSocket did not open in time."));
      }, AUTHORIZATION_TIMEOUT_MS);
      socket.once("open", () => {
        clearTimeout(timer);
        resolveClient(new GatewayWebSocketClient(socket));
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        rejectClient(error);
      });
    });
  }

  static async expectRejected(url: string, options?: ClientOptions): Promise<number> {
    return await new Promise<number>((resolveStatus, rejectStatus) => {
      const socket = new WebSocket(url, options);
      const timer = setTimeout(() => {
        socket.terminate();
        rejectStatus(new Error("Unauthenticated WebSocket was not rejected in time."));
      }, AUTHORIZATION_TIMEOUT_MS);
      socket.once("unexpected-response", (_request, response) => {
        clearTimeout(timer);
        const status = response.statusCode ?? 0;
        socket.terminate();
        resolveStatus(status);
      });
      socket.once("open", () => {
        clearTimeout(timer);
        socket.terminate();
        rejectStatus(new Error("Unauthenticated WebSocket unexpectedly opened."));
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        rejectStatus(error);
      });
    });
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<unknown> {
    if (this.isClosed) {
      return Promise.reject(new Error("CDP WebSocket is closed."));
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolveCommand, rejectCommand) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectCommand(new Error("CDP WebSocket command timed out."));
      }, COMMAND_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { resolve: resolveCommand, reject: rejectCommand, timer });
      try {
        this.socket.send(
          JSON.stringify({
            id,
            method,
            params,
            ...(sessionId === undefined ? {} : { sessionId }),
          }),
        );
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        rejectCommand(new Error("CDP WebSocket send failed."));
      }
    });
  }

  onEvent(listener: (message: CdpWireMessage) => void): void {
    this.eventListener = listener;
    for (const event of this.events.splice(0)) {
      listener(event);
    }
  }

  close(): void {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;
    this.socket.terminate();
    this.rejectAll(new Error("CDP WebSocket closed."));
  }

  private eventListener: ((message: CdpWireMessage) => void) | null = null;

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
    if (!isRecord(parsed)) {
      return;
    }
    if (typeof parsed.id === "number") {
      const entry = this.pending.get(parsed.id);
      if (entry === undefined) {
        return;
      }
      this.pending.delete(parsed.id);
      clearTimeout(entry.timer);
      if (isRecord(parsed.error)) {
        entry.reject(new Error("CDP WebSocket command failed."));
        return;
      }
      entry.resolve(parsed.result);
      return;
    }
    if (typeof parsed.method !== "string") {
      return;
    }
    const message: CdpWireMessage = {
      method: parsed.method,
      ...(parsed.params === undefined ? {} : { params: parsed.params }),
      ...(typeof parsed.sessionId === "string" ? { sessionId: parsed.sessionId } : {}),
    };
    if (this.eventListener !== null) {
      this.eventListener(message);
      return;
    }
    this.events.push(message);
    if (this.events.length > 1_000) {
      this.events.shift();
    }
  }

  private handleClose(): void {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;
    this.rejectAll(new Error("CDP WebSocket closed."));
  }

  private rejectAll(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }
}

async function openSession(
  profileDir: string,
  executablePath: string,
  capabilityToken?: string,
): Promise<Session> {
  const pipe = await launchCdpPipe({ executablePath, userDataDir: profileDir });
  let router: CdpRouter | null = null;
  let gateway: CdpGateway | null = null;
  try {
    router = createCdpRouter(pipe, {
      requestTimeoutMs: 30_000,
      attachTimeoutMs: 20_000,
      maxQueueMessages: 10_000,
    });
    const apiToken = randomBytes(32).toString("base64url");
    gateway = await startCdpGateway({ router, apiToken, capabilityToken });
    const connected = await connectPlaywright(router);
    return {
      pipe,
      router,
      gateway,
      apiToken,
      browser: connected.browser,
    };
  } catch (error) {
    await gateway?.close().catch(() => undefined);
    await router?.close().catch(() => undefined);
    await pipe.close().catch(() => undefined);
    throw error;
  }
}

async function closePlaywright(session: Session): Promise<void> {
  if (session.browser === null) {
    return;
  }
  const browser = session.browser;
  session.browser = null;
  await browser.close();
}

async function closeSession(session: Session, profileDir: string, label: string): Promise<void> {
  await closePlaywright(session);
  await session.gateway.close();
  const closeStartedAt = performance.now();
  await session.router.close();
  const closeMs = performance.now() - closeStartedAt;
  assert(closeMs <= 8_000, `${label}: close exceeded 8 s (${closeMs.toFixed(0)} ms).`);
  await waitForNoProcess(profileDir, `${label} process check`);
  await waitForProcessExit(session.pipe.pid, label);
  await assertPortClosed(session.gateway.port, label);
  console.log(`${label}: close ${closeMs.toFixed(0)} ms`);
}

async function assertNoTcpCdp(pid: number): Promise<void> {
  const command = (
    await runAllowFailure("ps", ["-ww", "-p", String(pid), "-o", "command="])
  ).trim();
  assert(command.length > 0, "The Chrome process is not running.");
  assert(command.includes("--remote-debugging-pipe"), "Chrome is not using --remote-debugging-pipe.");
  assert(!command.includes("--remote-debugging-port"), "Chrome has a --remote-debugging-port argument.");
  assert(!command.includes("--remote-allow-origins"), "Chrome has a --remote-allow-origins argument.");

  const listeners = (
    await runAllowFailure("lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN"])
  ).trim();
  assert(listeners.length === 0, "Chrome has a listening TCP socket.");
  console.log(`chrome pid: ${pid}; listening TCP sockets: none`);
}

async function assertUnauthenticated(gateway: CdpGateway): Promise<void> {
  const response = await fetch(`${gateway.httpUrl}/json/version`);
  assert(response.status === 401, "Unauthenticated HTTP request was not rejected with 401.");
  const body = await response.text();
  assert(!body.includes(gateway.capabilityToken), "Unauthenticated HTTP body contains the capability token.");

  const status = await GatewayWebSocketClient.expectRejected(
    `ws://127.0.0.1:${gateway.port}/devtools/browser/unauthenticated`,
  );
  assert(status === 401, "Unauthenticated WebSocket request was not rejected with 401.");
}

async function measureLatency(client: GatewayWebSocketClient): Promise<{ p50: number; p95: number }> {
  const samples: number[] = [];
  for (let index = 0; index < LATENCY_SAMPLES; index += 1) {
    const startedAt = performance.now();
    await client.send("Target.getTargets");
    samples.push(performance.now() - startedAt);
  }
  samples.sort((a, b) => a - b);
  const p50 = samples[Math.floor(samples.length * 0.5)] ?? 0;
  const p95 = samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)] ?? 0;
  return { p50, p95 };
}

async function run(secrets: string[]): Promise<void> {
  const tempRoot = createTempRoot();
  const profileDir = join(tempRoot, "profile");
  assertInside(profileDir, tempRoot, "profile directory");
  const portFile = join(tempRoot, "port.txt");
  await mkdir(profileDir, { recursive: true, mode: 0o700 });

  const capabilityOverride = process.env.ARGUS_SMOKE_CAPABILITY_TOKEN;
  if (capabilityOverride !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(capabilityOverride)) {
    throw new Error("ARGUS_SMOKE_CAPABILITY_TOKEN must be 32 random bytes encoded as base64url.");
  }

  const chrome = await resolveChromeForTesting();
  console.log(`tmp root: ${tempRoot}`);
  console.log(`chrome version: ${chrome.version}`);
  console.log("chrome source: app data (read-only)");

  const origin = await startOriginServer();
  const originPort = Number(new URL(origin.url).port);
  let first: Session | null = null;
  let second: Session | null = null;
  let extensionClient: GatewayWebSocketClient | null = null;
  let stagehand: StagehandInstance | null = null;

  try {
    first = await openSession(profileDir, chrome.executablePath, capabilityOverride);
    secrets.push(first.gateway.capabilityToken, first.apiToken);
    await writeFile(portFile, `gateway=${first.gateway.port}\norigin=${originPort}\n`);

    console.log("step 1: reject unauthenticated HTTP and WebSocket clients");
    await assertUnauthenticated(first.gateway);
    console.log("GATE e PASS unauthenticated HTTP and WebSocket return 401");

    console.log("step 2: Playwright over the in-process router");
    const context = first.browser?.contexts()[0];
    assert(context !== undefined, "Playwright did not expose a default browser context.");
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(origin.url, { waitUntil: "domcontentloaded", timeout: 15_000 });
    await page.click("#go", { timeout: 10_000 });
    const clickResult = (await page.locator("#result").textContent())?.trim() ?? "";
    assert(clickResult === "clicked", "Playwright click did not update the page result.");
    await context.addCookies([
      {
        name: "argus_gateway_cookie",
        value: "persisted",
        url: origin.url,
        expires: Math.floor(Date.now() / 1000) + 3_600,
      },
    ]);
    const cookiesBefore = await context.cookies(origin.url);
    assert(
      cookiesBefore.some((cookie) => cookie.name === "argus_gateway_cookie" && cookie.value === "persisted"),
      "The smoke cookie was not written.",
    );
    console.log("GATE b PASS Playwright navigate, click, and cookie write");

    console.log("step 3: prove Chrome has no TCP CDP listener");
    await assertNoTcpCdp(first.pipe.pid);
    console.log("GATE a PASS no --remote-debugging-port, no --remote-allow-origins, no TCP listener");

    console.log("step 4: authenticated WebSocket client with child-session injection");
    extensionClient = await GatewayWebSocketClient.connect(first.gateway.webSocketDebuggerUrl);
    const existingTargets = (await extensionClient.send("Target.getTargets")) as {
      targetInfos?: Array<{ targetId?: string }>;
    };
    const existingTargetIds = new Set(
      (existingTargets.targetInfos ?? [])
        .map((target) => target.targetId)
        .filter((targetId): targetId is string => typeof targetId === "string"),
    );
    let markerSessionId: string | null = null;
    let markerError: Error | null = null;
    let isMarkerArmed = false;

    extensionClient.onEvent((message) => {
      if (message.method !== "Target.attachedToTarget" || !isRecord(message.params)) {
        return;
      }
      const params = message.params;
      const targetInfo = isRecord(params.targetInfo) ? params.targetInfo : null;
      const sessionId = typeof params.sessionId === "string" ? params.sessionId : null;
      const targetId = typeof targetInfo?.targetId === "string" ? targetInfo.targetId : null;
      if (targetInfo?.type !== "page" || sessionId === null) {
        return;
      }

      if (isMarkerArmed && targetId !== null && !existingTargetIds.has(targetId)) {
        isMarkerArmed = false;
        markerSessionId = sessionId;
        void (async () => {
          try {
            await extensionClient?.send("Page.enable", {}, sessionId);
            await extensionClient?.send(
              "Page.addScriptToEvaluateOnNewDocument",
              { source: MARKER_SCRIPT, runImmediately: true },
              sessionId,
            );
            await extensionClient?.send("Runtime.runIfWaitingForDebugger", {}, sessionId);
          } catch (error) {
            markerError = error instanceof Error ? error : new Error("Marker injection failed.");
          }
        })();
        return;
      }

      void extensionClient?.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => undefined);
    });

    await extensionClient.send("Target.setAutoAttach", {
      autoAttach: true,
      flatten: true,
      waitForDebuggerOnStart: true,
      filter: [{ type: "page" }],
    });
    await delay(200);

    isMarkerArmed = true;
    const markerPagePromise = context.newPage();
    const markerDeadline = Date.now() + 15_000;
    while (markerSessionId === null && markerError === null) {
      if (Date.now() >= markerDeadline) {
        throw new Error("The WebSocket client did not attach to the new page.");
      }
      await delay(20);
    }
    assert(markerError === null, "Marker injection failed.");
    const markerPage = await markerPagePromise;
    await markerPage.goto(origin.url, { waitUntil: "domcontentloaded", timeout: 15_000 });
    const markerBeforeReload = await markerPage.evaluate(
      "window.__argusCdpGatewayMarker ?? null",
    );
    assert(markerBeforeReload === "present", "The injected marker is missing before reload.");
    await markerPage.reload({ waitUntil: "domcontentloaded", timeout: 15_000 });
    const markerAfterReload = await markerPage.evaluate(
      "window.__argusCdpGatewayMarker ?? null",
    );
    assert(markerAfterReload === "present", "The injected marker is missing after reload.");
    console.log("GATE c PASS isolated child session marker survived reload");

    console.log("step 5: Stagehand create through the gateway");
    const stagehandModule = await import("@browserbasehq/stagehand");
    const stagehandBrowser = await withTimeout(
      stagehandModule.localBrowser.connect({
        cdpUrl: first.gateway.httpUrl,
        headers: { Authorization: `Bearer ${first.apiToken}` },
        extensionCdpUrl: first.gateway.webSocketDebuggerUrl,
      }),
      STAGEHAND_INIT_TIMEOUT_MS,
      "Stagehand browser connection timed out.",
    );
    stagehand = await withTimeout(
      stagehandModule.Stagehand.create({
        browser: stagehandBrowser,
        logging: { level: "off" },
      }),
      STAGEHAND_INIT_TIMEOUT_MS,
      "Stagehand initialization timed out.",
    );
    const stagehandPages = await stagehand.browser.context.pages();
    const stagehandPage =
      stagehandPages.at(-1) ?? (await stagehand.browser.context.newPage("about:blank"));
    await stagehandPage.goto(origin.url, { waitUntil: "domcontentloaded", timeout: 15_000 });
    const snapshot = await stagehandPage.snapshot({ timeout: 20_000 });
    assert(snapshot.formattedTree.trim().length > 0, "Stagehand snapshot returned an empty tree.");
    const point = await stagehandPage.evaluate<{ x: number; y: number }>(`(() => {
      const element = document.querySelector("#go");
      if (!element) {
        throw new Error("The click target is missing.");
      }
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    await stagehandPage.click(point.x, point.y);
    const stagehandResult = await stagehandPage.evaluate<string>(
      "document.querySelector('#result')?.textContent ?? ''",
    );
    assert(stagehandResult === "clicked", "Stagehand click did not update the page result.");
    console.log(
      `GATE d PASS Stagehand snapshot ${snapshot.formattedTree.trim().length} chars, goto, click`,
    );

    console.log("step 6: measure CDP round-trip latency through the authenticated gateway");
    const latency = await measureLatency(extensionClient);
    console.log(
      `GATE h PASS p50=${latency.p50.toFixed(2)} ms p95=${latency.p95.toFixed(2)} ms n=${LATENCY_SAMPLES}`,
    );

    console.log("step 7: close Stagehand without closing Chrome");
    if (stagehand !== null) {
      const currentStagehand = stagehand;
      stagehand = null;
      try {
        await withTimeout(
          currentStagehand.close(),
          STAGEHAND_CLOSE_TIMEOUT_MS,
          "Stagehand close timed out.",
        );
        console.log("stagehand close: PASS");
      } catch (error) {
        console.log(
          `stagehand close: lifecycle owner rejected Browser.close (${describeError(
            error,
            secrets,
          )})`,
        );
      }
    }
    assert(isProcessAlive(first.pipe.pid), "Chrome exited after Stagehand close.");

    console.log("step 8: disconnect Playwright while the WebSocket client stays alive");
    const playwrightPid = first.pipe.pid;
    await closePlaywright(first);
    const targetsAfterPlaywrightClose = (await extensionClient.send("Target.getTargets")) as {
      targetInfos?: unknown[];
    };
    assert(Array.isArray(targetsAfterPlaywrightClose.targetInfos), "The remaining client is unresponsive.");
    assert(isProcessAlive(playwrightPid), "Chrome exited after the Playwright client closed.");
    console.log("GATE f PASS one client closed; Chrome and the other client stay alive");

    extensionClient.close();
    extensionClient = null;

    console.log("step 9: close the first session");
    await closeSession(first, profileDir, "first session");
    first = null;
    console.log("GATE g PASS first Chrome exited, no orphan, gateway port free");

    console.log("step 10: respawn with the same user-data-dir and verify the cookie");
    second = await openSession(profileDir, chrome.executablePath);
    secrets.push(second.gateway.capabilityToken, second.apiToken);
    await appendFile(portFile, `gateway2=${second.gateway.port}\n`);
    const secondContext = second.browser?.contexts()[0];
    assert(secondContext !== undefined, "Playwright did not expose a context after respawn.");
    const cookiesAfter = await secondContext.cookies(origin.url);
    assert(
      cookiesAfter.some((cookie) => cookie.name === "argus_gateway_cookie" && cookie.value === "persisted"),
      "The smoke cookie did not persist across a Chrome restart.",
    );
    console.log("GATE b PASS cookie persisted after close and respawn");

    await closeSession(second, profileDir, "second session");
    second = null;
    console.log("GATE g PASS second Chrome exited, no orphan, gateway port free");

    await origin.close();
    await rm(profileDir, { recursive: true, force: true });
    console.log(`port file: ${portFile}`);
  } finally {
    if (stagehand !== null) {
      await withTimeout(stagehand.close(), STAGEHAND_CLOSE_TIMEOUT_MS, "Stagehand cleanup timed out.").catch(
        (error: unknown) => {
          console.error(`cleanup: stagehand close failed (${describeError(error, secrets)})`);
        },
      );
    }
    extensionClient?.close();
    if (second !== null) {
      await closeSession(second, profileDir, "second session cleanup").catch((error: unknown) => {
        console.error(`cleanup: second session close failed (${describeError(error, secrets)})`);
      });
    }
    if (first !== null) {
      await closeSession(first, profileDir, "first session cleanup").catch((error: unknown) => {
        console.error(`cleanup: first session close failed (${describeError(error, secrets)})`);
      });
    }
    await origin.close().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const secrets: string[] = [];
  try {
    await run(secrets);
    console.log(`duration: ${Date.now() - startedAt} ms`);
    console.log("SMOKE PASS");
  } catch (error) {
    process.exitCode = 1;
    console.error(`duration: ${Date.now() - startedAt} ms`);
    console.error(`SMOKE FAILED: ${describeError(error, secrets)}`);
  }
}

void main();
