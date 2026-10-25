import { Worker } from "node:worker_threads";
import { ChromeAbortError } from "./chrome-errors";

const CHECKSUM_WORKER_SOURCE = `
const { createHash } = require("node:crypto");
const { createReadStream } = require("node:fs");
const { parentPort, workerData } = require("node:worker_threads");
const hash = createHash("sha256");
createReadStream(workerData.filePath)
  .on("data", (chunk) => hash.update(chunk))
  .on("error", (error) => { throw error; })
  .on("end", () => parentPort.postMessage(hash.digest("hex")));
`;

export function hashFileInWorker(filePath: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) {
    return Promise.reject(new ChromeAbortError());
  }

  return new Promise((resolve, reject) => {
    const worker = new Worker(CHECKSUM_WORKER_SOURCE, {
      eval: true,
      workerData: { filePath },
    });
    let settled = false;

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
    };

    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      worker.terminate().catch(() => undefined);
      reject(error);
    };

    const onAbort = () => {
      fail(new ChromeAbortError());
    };

    worker.on("message", (message: unknown) => {
      if (settled) {
        return;
      }
      if (typeof message !== "string" || !/^[0-9a-f]{64}$/.test(message)) {
        fail(new Error("Invalid checksum worker response."));
        return;
      }
      settled = true;
      cleanup();
      worker.terminate().catch(() => undefined);
      resolve(message);
    });

    worker.on("error", (error) => {
      fail(error instanceof Error ? error : new Error("Checksum worker failed."));
    });

    worker.on("exit", (code) => {
      if (!settled) {
        fail(new Error(`Checksum worker exited with code ${code}.`));
      }
    });

    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
    }
  });
}
