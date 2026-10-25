import { open, rm, type FileHandle } from "node:fs/promises";
import { ChromeAbortError, ChromeFailure, isAbortError } from "./chrome-errors";

export const CHROME_CONNECTION_TIMEOUT_MS = 15_000;
export const CHROME_IDLE_TIMEOUT_MS = 15_000;

export type ChromeFetch = (
  url: string,
  init: { signal: AbortSignal; redirect: "follow" },
) => Promise<Response>;

export type DownloadProgress = {
  readonly receivedBytes: number;
  readonly totalBytes: number | null;
};

export type DownloadFileOptions = {
  readonly url: string;
  readonly destination: string;
  readonly signal: AbortSignal;
  readonly onProgress?: (progress: DownloadProgress) => void;
  readonly fetchImpl?: ChromeFetch;
  readonly connectionTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
};

export type DownloadFileResult = {
  readonly receivedBytes: number;
  readonly totalBytes: number | null;
};

function parseContentLength(header: string | null): number | null {
  if (header === null) {
    return null;
  }
  const trimmed = header.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export async function downloadFile(options: DownloadFileOptions): Promise<DownloadFileResult> {
  const {
    url,
    destination,
    signal,
    onProgress,
    fetchImpl = fetch,
    connectionTimeoutMs = CHROME_CONNECTION_TIMEOUT_MS,
    idleTimeoutMs = CHROME_IDLE_TIMEOUT_MS,
  } = options;

  if (signal.aborted) {
    throw new ChromeAbortError();
  }

  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  signal.addEventListener("abort", abortFromCaller, { once: true });

  let timedOut = false;
  let connectionTimer: NodeJS.Timeout | undefined = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, connectionTimeoutMs);

  try {
    let response: Response;
    try {
      response = await fetchImpl(url, { signal: controller.signal, redirect: "follow" });
    } catch (error) {
      if (timedOut) {
        throw new ChromeFailure("chrome_download_failed");
      }
      if (signal.aborted) {
        throw new ChromeAbortError();
      }
      throw new ChromeFailure("chrome_download_failed");
    } finally {
      clearTimeout(connectionTimer);
      connectionTimer = undefined;
    }

    const body = response.body;
    if (!response.ok || body === null) {
      await body?.cancel().catch(() => undefined);
      throw new ChromeFailure("chrome_download_failed");
    }

    const totalBytes = parseContentLength(response.headers.get("content-length"));
    let handle: FileHandle;
    try {
      handle = await open(destination, "w", 0o600);
    } catch {
      await body.cancel().catch(() => undefined);
      throw new ChromeFailure("chrome_download_failed");
    }
    const reader = body.getReader();
    let receivedBytes = 0;

    try {
      while (true) {
        if (signal.aborted) {
          throw new ChromeAbortError();
        }
        if (timedOut) {
          throw new ChromeFailure("chrome_download_failed");
        }

        let idleTimer: NodeJS.Timeout | undefined = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, idleTimeoutMs);

        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await reader.read();
        } finally {
          clearTimeout(idleTimer);
          idleTimer = undefined;
        }

        if (result.done) {
          break;
        }

        const chunk = result.value;
        if (chunk.byteLength === 0) {
          continue;
        }

        await handle.write(chunk);
        receivedBytes += chunk.byteLength;
        onProgress?.({ receivedBytes, totalBytes });
      }

      await handle.close();
      return { receivedBytes, totalBytes };
    } catch (error) {
      controller.abort();
      await handle.close().catch(() => undefined);
      await rm(destination, { force: true }).catch(() => undefined);

      if (timedOut) {
        throw new ChromeFailure("chrome_download_failed");
      }
      if (signal.aborted) {
        throw new ChromeAbortError();
      }
      if (error instanceof ChromeFailure || isAbortError(error)) {
        throw error;
      }
      throw new ChromeFailure("chrome_download_failed");
    } finally {
      reader.releaseLock();
    }
  } finally {
    clearTimeout(connectionTimer);
    signal.removeEventListener("abort", abortFromCaller);
  }
}
