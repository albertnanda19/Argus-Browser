import { createHash } from "node:crypto";

const HARDWARE_CONCURRENCY_VALUES = [4, 6, 8, 10, 12, 16] as const;
const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;
const DEFAULT_TARGET_ATTACH_TIMEOUT_MS = 3_000;
const TARGET_POLL_INTERVAL_MS = 10;
const MAX_CANVAS_PIXELS = 4_000_000;

export type FingerprintProfile = {
  readonly key: string;
  readonly hardwareConcurrency: number;
  readonly canvasNoiseSeed: number;
};

export type FingerprintHardening = {
  close(): Promise<void>;
};

export type CdpTransport = {
  send(message: unknown): void;
  close(): void;
  onMessage(listener: (message: unknown) => void): void;
  onClose(listener: () => void): void;
};

export type FingerprintHardeningDependencies = {
  readonly fetchVersion?: (cdpUrl: string) => Promise<unknown>;
  readonly connect?: (webSocketUrl: string) => Promise<CdpTransport>;
  readonly commandTimeoutMs?: number;
  readonly targetAttachTimeoutMs?: number;
};

export type FingerprintHardeningOptions = {
  readonly cdpUrl: string;
  readonly profile: FingerprintProfile;
};

type PendingCommand = {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise<void>((resolveDelay) => {
    setTimeout(resolveDelay, timeoutMs);
  });
}

export function createFingerprintProfile(identity: string): FingerprintProfile {
  const digest = createHash("sha256").update(identity).digest();
  const selection = digest.readUInt32BE(0);
  const canvasNoiseSeed = digest.readUInt32BE(4);
  const hardwareConcurrency =
    HARDWARE_CONCURRENCY_VALUES[selection % HARDWARE_CONCURRENCY_VALUES.length] ?? 8;

  return {
    key: identity,
    hardwareConcurrency,
    canvasNoiseSeed,
  };
}

export function canvasNoiseOffset(index: number, seed: number): number {
  let value = (Math.imul(index, 0x9e3779b1) + seed) >>> 0;
  value = (value ^ (value >>> 16)) >>> 0;
  value = Math.imul(value, 0x21f0aaad) >>> 0;
  value = (value ^ (value >>> 15)) >>> 0;
  value = Math.imul(value, 0x735a2d97) >>> 0;
  value = (value ^ (value >>> 15)) >>> 0;
  return (value % 3) - 1;
}

export function buildFingerprintInitScript(profile: FingerprintProfile): string {
  const config = JSON.stringify({
    hardwareConcurrency: profile.hardwareConcurrency,
    canvasNoiseSeed: profile.canvasNoiseSeed,
    maxCanvasPixels: MAX_CANVAS_PIXELS,
  });

  return `(() => {
  const config = ${config};
  const marker = Symbol.for("argus.fingerprint");
  if (globalThis[marker] === true) {
    return;
  }
  Object.defineProperty(globalThis, marker, { value: true });
  const noiseOffset = ${canvasNoiseOffset.toString()};
  const applyNoise = (data) => {
    for (let index = 0; index < data.length; index += 4) {
      const offset = noiseOffset(index / 4, config.canvasNoiseSeed);
      data[index] += offset;
      data[index + 1] += offset;
      data[index + 2] += offset;
    }
  };
  const originalGetImageData = CanvasRenderingContext2D.prototype.getImageData;
  const originalPutImageData = CanvasRenderingContext2D.prototype.putImageData;
  const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
  const originalToBlob = HTMLCanvasElement.prototype.toBlob;
  const createNoisyCopy = (canvas) => {
    const width = canvas.width;
    const height = canvas.height;
    const pixelCount = width * height;
    if (pixelCount === 0 || pixelCount > config.maxCanvasPixels) {
      return null;
    }
    const copy = document.createElement("canvas");
    copy.width = width;
    copy.height = height;
    const context = copy.getContext("2d");
    if (context === null) {
      return null;
    }
    context.drawImage(canvas, 0, 0);
    const image = originalGetImageData.call(context, 0, 0, width, height);
    applyNoise(image.data);
    originalPutImageData.call(context, image, 0, 0);
    return copy;
  };
  try {
    if (navigator.webdriver === true) {
      Object.defineProperty(Navigator.prototype, "webdriver", {
        get: () => false,
        configurable: true,
      });
    }
  } catch {}
  try {
    Object.defineProperty(Navigator.prototype, "hardwareConcurrency", {
      get: () => config.hardwareConcurrency,
      configurable: true,
    });
  } catch {}
  HTMLCanvasElement.prototype.toDataURL = function (...args) {
    try {
      const copy = createNoisyCopy(this);
      return originalToDataURL.apply(copy ?? this, args);
    } catch {
      return originalToDataURL.apply(this, args);
    }
  };
  HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
    try {
      const copy = createNoisyCopy(this);
      return originalToBlob.call(copy ?? this, callback, ...args);
    } catch {
      return originalToBlob.call(this, callback, ...args);
    }
  };
  CanvasRenderingContext2D.prototype.getImageData = function (...args) {
    const image = originalGetImageData.apply(this, args);
    applyNoise(image.data);
    return image;
  };
})();`;
}

function resolveWebSocketUrl(value: unknown): string {
  if (!isRecord(value) || typeof value.webSocketDebuggerUrl !== "string") {
    throw new Error("CDP version endpoint did not provide a WebSocket URL.");
  }

  const webSocketUrl = value.webSocketDebuggerUrl.trim();
  if (webSocketUrl.length === 0) {
    throw new Error("CDP version endpoint did not provide a WebSocket URL.");
  }
  return webSocketUrl;
}

function pageTargetIds(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.targetInfos)) {
    return [];
  }

  const ids: string[] = [];
  for (const targetInfo of value.targetInfos) {
    if (
      isRecord(targetInfo) &&
      targetInfo.type === "page" &&
      typeof targetInfo.targetId === "string"
    ) {
      ids.push(targetInfo.targetId);
    }
  }
  return ids;
}

async function fetchCdpVersion(cdpUrl: string): Promise<unknown> {
  const response = await fetch(`${cdpUrl}/json/version`, {
    signal: AbortSignal.timeout(DEFAULT_COMMAND_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`CDP version endpoint returned ${response.status}.`);
  }
  return await response.json();
}

async function openWebSocketTransport(webSocketUrl: string): Promise<CdpTransport> {
  const socket = new WebSocket(webSocketUrl);
  await new Promise<void>((resolveOpen, rejectOpen) => {
    const timer = setTimeout(() => {
      socket.close();
      rejectOpen(new Error("CDP WebSocket did not open in time."));
    }, DEFAULT_COMMAND_TIMEOUT_MS);
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolveOpen();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        rejectOpen(new Error("CDP WebSocket failed to open."));
      },
      { once: true },
    );
  });

  const messageListeners = new Set<(message: unknown) => void>();
  const closeListeners = new Set<() => void>();

  socket.addEventListener("message", (event) => {
    let message: unknown;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    for (const listener of messageListeners) {
      listener(message);
    }
  });
  socket.addEventListener("close", () => {
    for (const listener of closeListeners) {
      listener();
    }
  });

  return {
    send(message) {
      socket.send(JSON.stringify(message));
    },
    close() {
      socket.close();
    },
    onMessage(listener) {
      messageListeners.add(listener);
    },
    onClose(listener) {
      closeListeners.add(listener);
    },
  };
}

export async function installFingerprintHardening(
  options: FingerprintHardeningOptions,
  dependencies: FingerprintHardeningDependencies = {},
): Promise<FingerprintHardening> {
  const webSocketUrl = resolveWebSocketUrl(
    await (dependencies.fetchVersion ?? fetchCdpVersion)(options.cdpUrl),
  );
  const transport = await (dependencies.connect ?? openWebSocketTransport)(webSocketUrl);
  const commandTimeoutMs = dependencies.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const targetAttachTimeoutMs =
    dependencies.targetAttachTimeoutMs ?? DEFAULT_TARGET_ATTACH_TIMEOUT_MS;
  const initScript = buildFingerprintInitScript(options.profile);
  const pending = new Map<number, PendingCommand>();
  const attachedTargets = new Set<string>();
  const processedTargets = new Set<string>();
  const failedTargets = new Map<string, Error>();
  const tasks = new Set<Promise<void>>();
  let nextId = 0;
  let isClosed = false;

  const rejectPending = (error: Error): void => {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.reject(error);
    }
  };

  const send = (
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<unknown> => {
    if (isClosed) {
      return Promise.reject(new Error("Fingerprint hardening connection is closed."));
    }

    const id = nextId++;
    return new Promise<unknown>((resolveCommand, rejectCommand) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectCommand(new Error(`CDP command timed out: ${method}`));
      }, commandTimeoutMs);
      pending.set(id, { resolve: resolveCommand, reject: rejectCommand, timer });

      try {
        transport.send({
          id,
          method,
          params,
          ...(sessionId === undefined ? {} : { sessionId }),
        });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        rejectCommand(
          error instanceof Error ? error : new Error("CDP transport failed to send."),
        );
      }
    });
  };

  const markProcessed = (targetId: string): void => {
    processedTargets.add(targetId);
  };

  const installOnTarget = async (
    sessionId: string,
    targetId: string | null,
  ): Promise<void> => {
    try {
      await send("Page.enable", {}, sessionId);
      await send(
        "Page.addScriptToEvaluateOnNewDocument",
        { source: initScript, runImmediately: true },
        sessionId,
      );
    } catch (error) {
      const failure =
        error instanceof Error ? error : new Error("Fingerprint injection failed.");
      if (targetId !== null) {
        failedTargets.set(targetId, failure);
      }
      console.warn(`Fingerprint injection failed: ${targetId ?? "unknown"} (${failure.name})`);
    } finally {
      await send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => undefined);
      if (targetId !== null) {
        markProcessed(targetId);
      }
    }
  };

  const handleAttached = (params: unknown): void => {
    if (
      !isRecord(params) ||
      typeof params.sessionId !== "string" ||
      !isRecord(params.targetInfo)
    ) {
      return;
    }

    const sessionId = params.sessionId;
    const targetInfo = params.targetInfo;
    const targetId =
      typeof targetInfo.targetId === "string" ? targetInfo.targetId : null;

    if (targetInfo.type !== "page") {
      void send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => undefined);
      return;
    }

    if (targetId !== null) {
      if (attachedTargets.has(targetId)) {
        void send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => undefined);
        return;
      }
      attachedTargets.add(targetId);
    }

    const task = installOnTarget(sessionId, targetId);
    tasks.add(task);
    void task.finally(() => tasks.delete(task));
  };

  const handleClose = (): void => {
    isClosed = true;
    rejectPending(new Error("CDP connection closed."));
  };

  transport.onMessage((message) => {
    if (!isRecord(message)) {
      return;
    }

    if (typeof message.id === "number") {
      const entry = pending.get(message.id);
      if (entry !== undefined) {
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (isRecord(message.error)) {
          const detail =
            typeof message.error.message === "string"
              ? message.error.message
              : "CDP command rejected.";
          entry.reject(new Error(detail));
        } else {
          entry.resolve(message.result);
        }
      }
      return;
    }

    if (message.method === "Target.attachedToTarget") {
      handleAttached(message.params);
    }
  });
  transport.onClose(handleClose);

  try {
    const targetSnapshot = await send("Target.getTargets");
    const expectedTargets = pageTargetIds(targetSnapshot);

    await send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: [{ type: "page" }],
    });

    const deadline = Date.now() + targetAttachTimeoutMs;
    for (;;) {
      if (isClosed) {
        throw new Error("CDP connection closed during fingerprint hardening.");
      }

      const missing = expectedTargets.filter((targetId) => !processedTargets.has(targetId));
      if (missing.length === 0) {
        const failure = expectedTargets
          .map((targetId) => failedTargets.get(targetId))
          .find((error) => error !== undefined);
        if (failure !== undefined) {
          throw failure;
        }
        break;
      }

      if (Date.now() >= deadline) {
        const currentSnapshot = await send("Target.getTargets");
        const currentTargets = new Set(pageTargetIds(currentSnapshot));
        const stillMissing = missing.filter((targetId) => currentTargets.has(targetId));
        if (stillMissing.length === 0) {
          break;
        }
        throw new Error(
          `Fingerprint hardening did not attach to ${stillMissing.length} page target(s).`,
        );
      }

      await delay(TARGET_POLL_INTERVAL_MS);
    }
  } catch (error) {
    handleClose();
    transport.close();
    throw error;
  }

  return {
    async close() {
      if (isClosed) {
        return;
      }
      handleClose();
      transport.close();
    },
  };
}
