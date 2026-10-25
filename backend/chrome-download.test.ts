import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { createServer, type RequestListener } from "node:http";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { downloadFile, type DownloadProgress } from "./chrome-download";
import { ChromeFailure } from "./chrome-errors";

const testRoot = resolve(
  process.cwd(),
  "..",
  "tmp",
  "testing",
  `e2-download-${randomBytes(4).toString("hex")}`,
);

type TestServer = {
  readonly url: string;
  readonly close: () => Promise<void>;
};

async function startServer(handler: RequestListener): Promise<TestServer> {
  const server = createServer(handler);
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected a TCP server address.");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error === undefined) {
            resolveClose();
            return;
          }
          rejectClose(error);
        });
      });
    },
  };
}

function destinationFile(): string {
  return join(testRoot, `download-${randomBytes(4).toString("hex")}.bin`);
}

async function expectDownloadFailure(download: Promise<unknown>): Promise<void> {
  const error = await download.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ChromeFailure);
  if (error instanceof ChromeFailure) {
    expect(error.code).toBe("chrome_download_failed");
  }
}

beforeAll(async () => {
  await mkdir(testRoot, { recursive: true });
});

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

describe("downloadFile", () => {
  it("streams the response to disk and reports content length", async () => {
    const payload = Buffer.from("chrome-for-testing-download-payload");
    const server = await startServer((_request, response) => {
      response.writeHead(200, { "content-length": String(payload.length) });
      response.end(payload);
    });
    const destination = destinationFile();
    const progress: DownloadProgress[] = [];
    const controller = new AbortController();

    try {
      const result = await downloadFile({
        url: `${server.url}/chrome.zip`,
        destination,
        signal: controller.signal,
        onProgress: (update) => progress.push(update),
      });

      expect(result).toEqual({
        receivedBytes: payload.length,
        totalBytes: payload.length,
      });
      await expect(readFile(destination)).resolves.toEqual(payload);
      expect(progress.at(-1)).toEqual({
        receivedBytes: payload.length,
        totalBytes: payload.length,
      });
    } finally {
      await server.close();
    }
  });

  it("reports a null total when content length is absent", async () => {
    const payload = Buffer.from("chunked response");
    const server = await startServer((_request, response) => {
      response.writeHead(200);
      response.end(payload);
    });

    try {
      const result = await downloadFile({
        url: server.url,
        destination: destinationFile(),
        signal: new AbortController().signal,
      });

      expect(result.receivedBytes).toBe(payload.length);
      expect(result.totalBytes).toBeNull();
    } finally {
      await server.close();
    }
  });

  it("fails when the connection does not return headers within the timeout", async () => {
    const server = await startServer(() => undefined);

    try {
      await expectDownloadFailure(
        downloadFile({
          url: server.url,
          destination: destinationFile(),
          signal: new AbortController().signal,
          connectionTimeoutMs: 30,
        }),
      );
    } finally {
      await server.close();
    }
  });

  it("fails when the response stalls between chunks", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { "content-length": "100" });
      response.flushHeaders();
      response.write("start");
    });

    try {
      await expectDownloadFailure(
        downloadFile({
          url: server.url,
          destination: destinationFile(),
          signal: new AbortController().signal,
          idleTimeoutMs: 30,
        }),
      );
    } finally {
      await server.close();
    }
  });

  it("removes the partial file when the caller aborts", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { "content-length": "100" });
      response.flushHeaders();
      response.write("first-chunk");
    });
    const destination = destinationFile();
    const controller = new AbortController();

    try {
      const download = downloadFile({
        url: server.url,
        destination,
        signal: controller.signal,
        onProgress: () => controller.abort(),
      });

      await expect(download).rejects.toMatchObject({ name: "AbortError" });
      await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await server.close();
    }
  });

  it("fails immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const destination = destinationFile();

    await expect(
      downloadFile({
        url: "http://127.0.0.1:1/unreachable",
        destination,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("wraps a non-success response as a download failure", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(404);
      response.end("not found");
    });

    try {
      await expectDownloadFailure(
        downloadFile({
          url: server.url,
          destination: destinationFile(),
          signal: new AbortController().signal,
        }),
      );
    } finally {
      await server.close();
    }
  });
});
