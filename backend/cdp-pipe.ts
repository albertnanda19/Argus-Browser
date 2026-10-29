import { Readable, Writable } from "node:stream";
import { spawn } from "node:child_process";

const DEFAULT_BROWSER_CLOSE_TIMEOUT_MS = 5_000;
const DEFAULT_TERMINATE_TIMEOUT_MS = 1_000;
const DEFAULT_KILL_TIMEOUT_MS = 500;

export type CdpWireMessage = {
  readonly id?: number;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
  readonly sessionId?: string;
};

type WritablePipe = {
  write(chunk: Uint8Array): boolean;
  on?(event: "error", listener: (error: Error) => void): unknown;
};

type ReadablePipe = {
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  on(event: "end" | "close", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
};

export type CdpPipeTransportOptions = {
  readonly pid: number;
  readonly write: WritablePipe;
  readonly read: ReadablePipe;
  readonly kill: (signal: NodeJS.Signals) => void;
  readonly waitForExit: (timeoutMs: number) => Promise<boolean>;
  readonly browserCloseTimeoutMs?: number;
  readonly terminateTimeoutMs?: number;
  readonly killTimeoutMs?: number;
};

export type CdpPipe = {
  readonly pid: number;
  send(message: CdpWireMessage): void;
  onMessage(listener: (message: CdpWireMessage) => void): void;
  onClose(listener: (error?: Error) => void): void;
  close(): Promise<void>;
};

export type CdpPipeLaunchOptions = {
  readonly executablePath: string;
  readonly userDataDir: string;
  readonly args?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly browserCloseTimeoutMs?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWireMessage(value: unknown): value is CdpWireMessage {
  return (
    isRecord(value) &&
    (value.id === undefined || typeof value.id === "number") &&
    (value.method === undefined || typeof value.method === "string") &&
    (value.sessionId === undefined || typeof value.sessionId === "string")
  );
}

function toWireMessage(value: unknown): CdpWireMessage {
  if (!isWireMessage(value)) {
    throw new Error("CDP pipe received an invalid message.");
  }
  return value;
}

export class CdpPipeFrameDecoder {
  private pending = Buffer.alloc(0);

  push(chunk: Buffer): CdpWireMessage[] {
    this.pending = Buffer.concat([this.pending, chunk]);
    const messages: CdpWireMessage[] = [];

    for (;;) {
      const end = this.pending.indexOf(0);
      if (end === -1) {
        return messages;
      }

      const frame = this.pending.subarray(0, end);
      this.pending = this.pending.subarray(end + 1);
      if (frame.length === 0) {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(frame.toString("utf8"));
      } catch {
        throw new Error("CDP pipe received malformed JSON.");
      }
      messages.push(toWireMessage(parsed));
    }
  }
}

export function createCdpPipeTransport(options: CdpPipeTransportOptions): CdpPipe {
  const decoder = new CdpPipeFrameDecoder();
  const messageListeners = new Set<(message: CdpWireMessage) => void>();
  const closeListeners = new Set<(error?: Error) => void>();
  const browserCloseTimeoutMs =
    options.browserCloseTimeoutMs ?? DEFAULT_BROWSER_CLOSE_TIMEOUT_MS;
  const terminateTimeoutMs = options.terminateTimeoutMs ?? DEFAULT_TERMINATE_TIMEOUT_MS;
  const killTimeoutMs = options.killTimeoutMs ?? DEFAULT_KILL_TIMEOUT_MS;
  let isClosed = false;
  let isClosing = false;
  let closePromise: Promise<void> | null = null;

  const notifyClose = (error?: Error): void => {
    if (isClosed) {
      return;
    }
    isClosed = true;
    for (const listener of closeListeners) {
      listener(error);
    }
  };

  const fail = (error: Error): void => {
    notifyClose(error);
  };

  const writeFrame = (message: CdpWireMessage): void => {
    if (isClosed) {
      throw new Error("CDP pipe is closed.");
    }
    const frame = Buffer.from(`${JSON.stringify(message)}\0`, "utf8");
    try {
      options.write.write(frame);
    } catch {
      throw new Error("CDP pipe write failed.");
    }
  };

  options.read.on("data", (chunk) => {
    if (isClosed) {
      return;
    }
    try {
      for (const message of decoder.push(chunk)) {
        for (const listener of messageListeners) {
          listener(message);
        }
      }
    } catch (error) {
      fail(error instanceof Error ? error : new Error("CDP pipe read failed."));
    }
  });

  options.read.on("end", () => {
    notifyClose(isClosing ? undefined : new Error("CDP pipe closed."));
  });

  options.read.on("close", () => {
    notifyClose(isClosing ? undefined : new Error("CDP pipe closed."));
  });

  options.read.on("error", () => {
    notifyClose(new Error("CDP pipe read failed."));
  });

  options.write.on?.("error", () => {
    notifyClose(new Error("CDP pipe write failed."));
  });

  return {
    pid: options.pid,
    send(message) {
      writeFrame(message);
    },
    onMessage(listener) {
      messageListeners.add(listener);
    },
    onClose(listener) {
      closeListeners.add(listener);
    },
    close() {
      closePromise ??= (async () => {
        isClosing = true;
        if (!isClosed) {
          try {
            writeFrame({ id: 0, method: "Browser.close" });
          } catch {
            notifyClose(new Error("CDP pipe write failed."));
          }
        }

        if (await options.waitForExit(browserCloseTimeoutMs)) {
          notifyClose();
          return;
        }

        options.kill("SIGTERM");
        if (await options.waitForExit(terminateTimeoutMs)) {
          notifyClose();
          return;
        }

        options.kill("SIGKILL");
        await options.waitForExit(killTimeoutMs);
        notifyClose();
      })();
      return closePromise;
    },
  };
}

export async function launchCdpPipe(options: CdpPipeLaunchOptions): Promise<CdpPipe> {
  const args = [
    "--remote-debugging-pipe",
    `--user-data-dir=${options.userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",
    "--enable-unsafe-extension-debugging",
    ...(options.args ?? []),
    "about:blank",
  ];

  const child = spawn(options.executablePath, args, {
    env: options.env ?? process.env,
    stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
  });

  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    const onSpawn = (): void => {
      child.removeListener("error", onError);
      resolveSpawn();
    };
    const onError = (): void => {
      child.removeListener("spawn", onSpawn);
      rejectSpawn(new Error("Failed to launch Chrome for Testing."));
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });

  const pid = child.pid;
  const write = child.stdio[3];
  const read = child.stdio[4];
  if (
    pid === undefined ||
    !(write instanceof Writable) ||
    !(read instanceof Readable)
  ) {
    child.kill("SIGKILL");
    throw new Error("Chrome for Testing did not expose the debugging pipes.");
  }

  const pipe = child;
  return createCdpPipeTransport({
    pid,
    write,
    read,
    kill(signal) {
      try {
        pipe.kill(signal);
      } catch {
        return;
      }
    },
    waitForExit: (timeoutMs) =>
      new Promise<boolean>((resolveExit) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolveExit(true);
          return;
        }
        const timer = setTimeout(() => {
          child.removeListener("exit", onExit);
          resolveExit(false);
        }, timeoutMs);
        timer.unref?.();
        const onExit = (): void => {
          clearTimeout(timer);
          resolveExit(true);
        };
        child.once("exit", onExit);
      }),
    browserCloseTimeoutMs: options.browserCloseTimeoutMs,
  });
}
