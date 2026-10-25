import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { crc32 } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  chromeInstallerStateSchema,
  type ChromeInstallerState,
} from "../shared/chrome-installer";
import { extractChromeArchive, sanitizeArchiveEntryPath } from "./chrome-archive";
import { hashFileInWorker } from "./chrome-checksum";
import type { ChromeFetch } from "./chrome-download";
import { ChromeFailure } from "./chrome-errors";
import {
  createChromeInstaller,
  type ChromeInstallerOptions,
} from "./chrome-installer";
import {
  isGoogleChromeStablePath,
  validateLocalChromeBinary,
} from "./chrome-local-binary";
import type { ChromeManifest, ChromePlatformManifest } from "./chrome-manifest";
import { chromeLocalOverrideFile, chromeTempDir } from "./chrome-paths";

const testRoot = resolve(
  process.cwd(),
  "..",
  "tmp",
  "testing",
  `e2-installer-${randomBytes(4).toString("hex")}`,
);

const executableRelativePath = "fake-root/Google Chrome for Testing";
const fakeVersion = "1.2.3.4";
const localVersionOutput = "Google Chrome for Testing 9.9.9.9";

type ZipEntryInput = {
  readonly name: string;
  readonly data: string | Buffer;
  readonly mode?: number;
  readonly symlink?: boolean;
};

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolveValue: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolveValue = resolvePromise;
  });
  return {
    promise,
    resolve: (value: T) => {
      if (resolveValue === undefined) {
        throw new Error("Deferred is not initialized.");
      }
      resolveValue(value);
    },
  };
}

function buildZip(entries: ZipEntryInput[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "utf8");
    const mode = entry.mode ?? (entry.symlink === true ? 0o120777 : 0o100644);
    const checksum = crc32(data) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function buildChromeZip(): Buffer {
  return buildZip([
    {
      name: executableRelativePath,
      data: "#!/bin/sh\necho \"Google Chrome for Testing 156.0.8078.47\"\n",
      mode: 0o100755,
    },
    { name: "fake-root/Resources/data.txt", data: "resource-data" },
    {
      name: "fake-root/current",
      data: "Resources/data.txt",
      symlink: true,
    },
  ]);
}

function fakeManifest(
  zip: Buffer,
  platformOverrides: Partial<ChromePlatformManifest> = {},
  version = fakeVersion,
): ChromeManifest {
  return {
    version,
    platforms: {
      "mac-arm64": {
        url: "https://example.test/chrome-mac-arm64.zip",
        sha256: sha256(zip),
        executableRelativePath,
        ...platformOverrides,
      },
    },
  };
}

function zipFetch(zip: Buffer, onCall?: () => void): ChromeFetch {
  return async () => {
    onCall?.();
    return new Response(new Uint8Array(zip), {
      status: 200,
      headers: { "content-length": String(zip.length) },
    });
  };
}

function createInstaller(overrides: Partial<ChromeInstallerOptions> = {}): {
  readonly appDataDir: string;
  readonly installer: ReturnType<typeof createChromeInstaller>;
} {
  const appDataDir = join(testRoot, `appdata-${randomBytes(4).toString("hex")}`);
  return {
    appDataDir,
    installer: createChromeInstaller({
      appDataDir,
      platform: "darwin",
      arch: "arm64",
      ...overrides,
    }),
  };
}

function executablePathOf(installer: ReturnType<typeof createChromeInstaller>): string {
  const executable = installer.getExecutablePath();
  if (executable === null) {
    throw new Error("Expected an executable path.");
  }
  return executable;
}

async function createLocalScript(contents: string): Promise<string> {
  const file = join(testRoot, `local-chrome-${randomBytes(4).toString("hex")}`);
  await writeFile(file, contents, { mode: 0o755 });
  await chmod(file, 0o755);
  return file;
}

beforeAll(async () => {
  await mkdir(testRoot, { recursive: true });
});

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

describe("chrome installer state machine", () => {
  it("walks absent to ready after verifying and extracting the archive", async () => {
    const zip = buildChromeZip();
    const states: ChromeInstallerState[] = [];
    const { appDataDir, installer } = createInstaller({
      manifest: fakeManifest(zip),
      fetchImpl: zipFetch(zip),
      onStateChange: (state) => states.push(state),
    });

    await installer.initialize();
    expect(installer.getState().status).toBe("absent");

    const result = await installer.start();
    const statuses = states
      .map((state) => state.status)
      .filter((status, index, all) => index === 0 || status !== all[index - 1]);

    expect(statuses).toEqual(["absent", "downloading", "verifying", "extracting", "ready"]);
    expect(result).toEqual({
      status: "ready",
      source: "managed",
      version: fakeVersion,
      progress: null,
      error: null,
    });
    for (const state of states) {
      chromeInstallerStateSchema.parse(state);
    }

    const executable = executablePathOf(installer);
    expect(executable).toBe(
      join(appDataDir, "browsers", "chrome-for-testing", fakeVersion, executableRelativePath),
    );
    expect((await stat(executable)).mode & 0o111).not.toBe(0);

    const marker: unknown = JSON.parse(
      await readFile(
        join(
          appDataDir,
          "browsers",
          "chrome-for-testing",
          fakeVersion,
          ".argus-install.json",
        ),
        "utf8",
      ),
    );
    expect(marker).toEqual({
      version: fakeVersion,
      platform: "mac-arm64",
      executable: executableRelativePath,
    });
    expect(await readdir(chromeTempDir(appDataDir))).toEqual([]);
  });

  it("reuses an installed version on start without downloading again", async () => {
    const zip = buildChromeZip();
    const first = createInstaller({
      manifest: fakeManifest(zip),
      fetchImpl: zipFetch(zip),
    });
    await first.installer.initialize();
    await first.installer.start();

    let fetchCalls = 0;
    const second = createInstaller({
      appDataDir: first.appDataDir,
      manifest: fakeManifest(zip),
      fetchImpl: zipFetch(zip, () => {
        fetchCalls += 1;
      }),
    });
    await second.installer.initialize();

    expect(second.installer.getState().status).toBe("ready");
    expect(fetchCalls).toBe(0);
    expect(second.installer.getExecutablePath()).toBe(executablePathOf(first.installer));

    await rm(executablePathOf(first.installer));
    const third = createInstaller({ appDataDir: first.appDataDir, manifest: fakeManifest(zip) });
    await third.installer.initialize();
    expect(third.installer.getState()).toEqual({
      status: "absent",
      source: null,
      version: null,
      progress: null,
      error: null,
    });
  });

  it("rejects a checksum mismatch without installing and cleans temporary files", async () => {
    const zip = buildChromeZip();
    const { appDataDir, installer } = createInstaller({
      manifest: fakeManifest(zip, { sha256: "0".repeat(64) }),
      fetchImpl: zipFetch(zip),
    });
    await installer.initialize();

    const result = await installer.start();

    expect(result.status).toBe("error");
    expect(result.source).toBe("managed");
    expect(result.version).toBe(fakeVersion);
    expect(result.error?.code).toBe("chrome_checksum_mismatch");
    expect(result.error?.message).not.toContain(appDataDir);
    expect(await readdir(chromeTempDir(appDataDir))).toEqual([]);
    await expect(
      stat(join(appDataDir, "browsers", "chrome-for-testing", fakeVersion)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports extraction failure for an invalid archive", async () => {
    const invalidArchive = Buffer.from("this is not a zip archive");
    const { installer } = createInstaller({
      manifest: fakeManifest(invalidArchive),
      fetchImpl: zipFetch(invalidArchive),
    });
    await installer.initialize();

    const result = await installer.start();

    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("chrome_extract_failed");
  });

  it("reports a missing executable after extraction", async () => {
    const zip = buildZip([{ name: "fake-root/README.txt", data: "no executable here" }]);
    const { installer } = createInstaller({
      manifest: fakeManifest(zip),
      fetchImpl: zipFetch(zip),
    });
    await installer.initialize();

    const result = await installer.start();

    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("chrome_executable_not_found");
  });

  it("retries failed downloads with exponential backoff and jitter", async () => {
    const zip = buildChromeZip();
    let attempts = 0;
    const delays: number[] = [];
    const fetchImpl: ChromeFetch = async () => {
      attempts += 1;
      if (attempts < 3) {
        return new Response("temporary failure", { status: 503 });
      }
      return new Response(new Uint8Array(zip), {
        status: 200,
        headers: { "content-length": String(zip.length) },
      });
    };
    const { installer } = createInstaller({
      manifest: fakeManifest(zip),
      fetchImpl,
      random: () => 0,
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
    });
    await installer.initialize();

    const result = await installer.start();

    expect(result.status).toBe("ready");
    expect(attempts).toBe(3);
    expect(delays).toEqual([500, 1000]);
  });

  it("stops after three download attempts and exposes an error state", async () => {
    const zip = buildChromeZip();
    let attempts = 0;
    const { installer } = createInstaller({
      manifest: fakeManifest(zip),
      fetchImpl: async () => {
        attempts += 1;
        return new Response("still failing", { status: 500 });
      },
      random: () => 0,
      sleep: async () => undefined,
    });
    await installer.initialize();

    const result = await installer.start();

    expect(attempts).toBe(3);
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("chrome_download_failed");
    expect(result.error?.message).toBe(
      "Unduhan Chrome for Testing gagal. Periksa koneksi internet lalu coba lagi.",
    );
  });

  it("returns the active download for a second start call", async () => {
    const zip = buildChromeZip();
    const started = deferred<void>();
    const responseGate = deferred<Response>();
    let fetchCalls = 0;
    const fetchImpl: ChromeFetch = () => {
      fetchCalls += 1;
      started.resolve();
      return responseGate.promise;
    };
    const { installer } = createInstaller({
      manifest: fakeManifest(zip),
      fetchImpl,
    });
    await installer.initialize();

    const first = installer.start();
    await started.promise;
    const second = installer.start();

    expect(second).toBe(first);
    expect(fetchCalls).toBe(1);

    responseGate.resolve(
      new Response(new Uint8Array(zip), {
        status: 200,
        headers: { "content-length": String(zip.length) },
      }),
    );
    await Promise.all([first, second]);

    expect(installer.getState().status).toBe("ready");
    expect(fetchCalls).toBe(1);
  });

  it("aborts an active download on shutdown without hanging", async () => {
    const firstChunk = deferred<void>();
    const fetchImpl: ChromeFetch = async (_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          init.signal.addEventListener(
            "abort",
            () => controller.error(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-length": "100" },
      });
    };
    const { appDataDir, installer } = createInstaller({
      manifest: fakeManifest(buildChromeZip()),
      fetchImpl,
      onStateChange: (state) => {
        if (state.status === "downloading" && state.progress.receivedBytes > 0) {
          firstChunk.resolve();
        }
      },
    });
    await installer.initialize();

    const pending = installer.start();
    await firstChunk.promise;
    await installer.shutdown();
    const result = await pending;

    expect(result.status).toBe("absent");
    expect(await readdir(chromeTempDir(appDataDir))).toEqual([]);
  });

  it("aborts immediately when shutdown follows start without waiting", async () => {
    const zip = buildChromeZip();
    let fetchCalls = 0;
    const { installer } = createInstaller({
      manifest: fakeManifest(zip),
      fetchImpl: zipFetch(zip, () => {
        fetchCalls += 1;
      }),
    });
    await installer.initialize();

    const pending = installer.start();
    await installer.shutdown();
    const result = await pending;

    expect(result.status).toBe("absent");
    expect(fetchCalls).toBe(0);
  });

  it("updates download progress at most four times per second", async () => {
    const zip = buildChromeZip();
    const chunkSize = Math.ceil(zip.length / 20);
    let clock = 0;
    const progressStates: ChromeInstallerState[] = [];
    const fetchImpl: ChromeFetch = async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let offset = 0; offset < zip.length; offset += chunkSize) {
            controller.enqueue(zip.subarray(offset, offset + chunkSize));
          }
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-length": String(zip.length) },
      });
    };
    const { installer } = createInstaller({
      manifest: fakeManifest(zip),
      fetchImpl,
      now: () => {
        clock += 50;
        return clock;
      },
      onStateChange: (state) => {
        if (state.status === "downloading" && state.progress.receivedBytes > 0) {
          progressStates.push(state);
        }
      },
    });
    await installer.initialize();

    const result = await installer.start();

    expect(result.status).toBe("ready");
    expect(progressStates.length).toBeGreaterThan(0);
    expect(progressStates.length).toBeLessThanOrEqual(5);
    for (const state of progressStates) {
      chromeInstallerStateSchema.parse(state);
    }
  });

  it("reports an unsupported platform", async () => {
    const { installer } = createInstaller({ platform: "linux", arch: "x64" });

    const result = await installer.initialize();

    expect(result.status).toBe("error");
    expect(result.source).toBeNull();
    expect(result.error?.code).toBe("chrome_platform_unsupported");
  });
});

describe("local Chrome for Testing binary", () => {
  it("accepts a valid local binary, persists it with mode 0600, and clears back to managed", async () => {
    const zip = buildChromeZip();
    const { appDataDir, installer } = createInstaller({
      manifest: fakeManifest(zip),
      fetchImpl: zipFetch(zip),
    });
    await installer.initialize();
    await installer.start();
    expect(installer.getState().source).toBe("managed");

    const script = await createLocalScript(
      `#!/bin/sh\necho "${localVersionOutput}"\n`,
    );
    const result = await installer.setLocalBinary(script);

    expect(result).toEqual({
      ok: true,
      path: await realpath(script),
      version: "9.9.9.9",
    });
    expect(installer.getState()).toEqual({
      status: "ready",
      source: "local",
      version: "9.9.9.9",
      progress: null,
      error: null,
    });
    expect(installer.getExecutablePath()).toBe(await realpath(script));

    const overrideFile = chromeLocalOverrideFile(appDataDir);
    expect((await stat(overrideFile)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(overrideFile, "utf8"))).toEqual({
      path: await realpath(script),
      version: "9.9.9.9",
    });

    const reopened = createInstaller({
      appDataDir,
      manifest: fakeManifest(zip),
      fetchImpl: zipFetch(zip),
    });
    await reopened.installer.initialize();
    expect(reopened.installer.getState().source).toBe("local");

    const cleared = await installer.clearLocalBinary();
    expect(cleared.status).toBe("ready");
    expect(cleared.source).toBe("managed");
    expect(installer.getExecutablePath()).toBe(executablePathOf(installer));
    await expect(stat(overrideFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects invalid, missing, directory, and Google Chrome stable paths", async () => {
    const zip = buildChromeZip();
    const { appDataDir, installer } = createInstaller({
      manifest: fakeManifest(zip),
      fetchImpl: zipFetch(zip),
    });
    await installer.initialize();
    await installer.start();
    const managedExecutable = executablePathOf(installer);

    const notChrome = await createLocalScript(
      "#!/bin/sh\necho \"Google Chrome 140.0.0.1\"\n",
    );
    await expect(installer.setLocalBinary(notChrome)).resolves.toMatchObject({
      ok: false,
      error: {
        code: "chrome_local_invalid",
        message: "Berkas yang dipilih bukan Chrome for Testing yang dapat dijalankan.",
      },
    });
    await expect(installer.setLocalBinary("relative/chrome")).resolves.toMatchObject({
      ok: false,
      error: { code: "chrome_local_invalid" },
    });
    await expect(
      installer.setLocalBinary(join(appDataDir, "missing-chrome")),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "chrome_local_missing" },
    });
    await expect(installer.setLocalBinary(testRoot)).resolves.toMatchObject({
      ok: false,
      error: { code: "chrome_local_invalid" },
    });
    await expect(
      installer.setLocalBinary(
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "chrome_local_invalid" },
    });

    expect(installer.getState().source).toBe("managed");
    expect(installer.getExecutablePath()).toBe(managedExecutable);
    await expect(stat(chromeLocalOverrideFile(appDataDir))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reports a stored override whose binary disappeared", async () => {
    const appDataDir = join(testRoot, `appdata-${randomBytes(4).toString("hex")}`);
    const overrideFile = chromeLocalOverrideFile(appDataDir);
    await mkdir(dirname(overrideFile), { recursive: true });
    await writeFile(
      overrideFile,
      JSON.stringify({ path: join(appDataDir, "gone"), version: "9.9.9.9" }),
      { mode: 0o600 },
    );

    const installer = createChromeInstaller({
      appDataDir,
      platform: "darwin",
      arch: "arm64",
    });
    const state = await installer.initialize();

    expect(state.status).toBe("error");
    expect(state.source).toBe("local");
    expect(state.version).toBe("9.9.9.9");
    expect(state.error?.code).toBe("chrome_local_missing");
    expect(state.error?.message).toBe("Chrome for Testing lokal tidak ditemukan.");
  });

  it("does not download while a broken local override is active", async () => {
    const zip = buildChromeZip();
    const appDataDir = join(testRoot, `appdata-${randomBytes(4).toString("hex")}`);
    const overrideFile = chromeLocalOverrideFile(appDataDir);
    await mkdir(dirname(overrideFile), { recursive: true });
    await writeFile(
      overrideFile,
      JSON.stringify({ path: join(appDataDir, "gone"), version: "9.9.9.9" }),
      { mode: 0o600 },
    );
    let fetchCalls = 0;
    const installer = createChromeInstaller({
      appDataDir,
      platform: "darwin",
      arch: "arm64",
      manifest: fakeManifest(zip),
      fetchImpl: zipFetch(zip, () => {
        fetchCalls += 1;
      }),
    });
    await installer.initialize();

    const result = await installer.start();

    expect(fetchCalls).toBe(0);
    expect(result.status).toBe("error");
    expect(result.source).toBe("local");
    expect(result.error?.code).toBe("chrome_local_missing");
    expect(installer.getExecutablePath()).toBeNull();
  });

  it("validates a local binary without requiring an installer state", async () => {
    const script = await createLocalScript(
      `#!/bin/sh\necho "${localVersionOutput}"\n`,
    );
    const result = await validateLocalChromeBinary(script, { platform: "darwin" });

    expect(result).toMatchObject({ ok: true, version: "9.9.9.9" });
  });

  it("recognizes Google Chrome stable installation directories", () => {
    expect(
      isGoogleChromeStablePath(
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "darwin",
        {},
      ),
    ).toBe(true);
    expect(
      isGoogleChromeStablePath(
        "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        "darwin",
        {},
      ),
    ).toBe(false);
    expect(
      isGoogleChromeStablePath(
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "win32",
        { ProgramFiles: "C:\\Program Files" },
      ),
    ).toBe(true);
    expect(
      isGoogleChromeStablePath(
        "C:\\Program Files\\Google\\Chrome for Testing\\chrome.exe",
        "win32",
        { ProgramFiles: "C:\\Program Files" },
      ),
    ).toBe(false);
  });
});

describe("chrome archive extraction", () => {
  it("extracts files, executable bits, and safe symlinks", async () => {
    const zip = buildChromeZip();
    const archive = join(testRoot, `archive-${randomBytes(4).toString("hex")}.zip`);
    const destination = join(testRoot, `extract-${randomBytes(4).toString("hex")}`);
    await writeFile(archive, zip);

    await extractChromeArchive(archive, destination, new AbortController().signal);

    const executable = join(destination, executableRelativePath);
    expect((await stat(executable)).mode & 0o111).not.toBe(0);
    const link = join(destination, "fake-root", "current");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    await expect(readlink(link)).resolves.toBe("Resources/data.txt");
    await expect(readFile(join(destination, "fake-root", "Resources", "data.txt"), "utf8")).resolves.toBe(
      "resource-data",
    );
  });

  it("rejects path traversal entries", async () => {
    expect(() => sanitizeArchiveEntryPath("../evil")).toThrow(ChromeFailure);
    expect(() => sanitizeArchiveEntryPath("/absolute")).toThrow(ChromeFailure);
    expect(() => sanitizeArchiveEntryPath("C:\\absolute")).toThrow(ChromeFailure);
    expect(() => sanitizeArchiveEntryPath("a/../../b")).toThrow(ChromeFailure);
    expect(() => sanitizeArchiveEntryPath("./a/b")).not.toThrow();

    const zip = buildZip([{ name: "../../outside.txt", data: "escaped" }]);
    const archive = join(testRoot, `zip-slip-${randomBytes(4).toString("hex")}.zip`);
    const destination = join(testRoot, `slip-dest-${randomBytes(4).toString("hex")}`);
    await writeFile(archive, zip);

    await expect(
      extractChromeArchive(archive, destination, new AbortController().signal),
    ).rejects.toMatchObject({ code: "chrome_extract_failed" });
    await expect(stat(join(testRoot, "outside.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects symlinks that escape the extraction root", async () => {
    const zip = buildZip([
      { name: "fake-root/link", data: "../../outside", symlink: true },
    ]);
    const archive = join(testRoot, `symlink-${randomBytes(4).toString("hex")}.zip`);
    const destination = join(testRoot, `symlink-dest-${randomBytes(4).toString("hex")}`);
    await writeFile(archive, zip);

    await expect(
      extractChromeArchive(archive, destination, new AbortController().signal),
    ).rejects.toMatchObject({ code: "chrome_extract_failed" });
  });
});

describe("checksum worker", () => {
  it("hashes a file in a worker thread", async () => {
    const file = join(testRoot, `hash-${randomBytes(4).toString("hex")}.bin`);
    const contents = Buffer.from("checksum worker payload");
    await writeFile(file, contents);

    await expect(hashFileInWorker(file)).resolves.toBe(sha256(contents));
  });
});
