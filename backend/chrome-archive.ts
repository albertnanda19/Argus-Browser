import { createWriteStream } from "node:fs";
import { access, chmod, constants, mkdir, rm, stat, symlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import StreamZip from "node-stream-zip";
import type { ChromePlatform } from "./chrome-manifest";
import { ChromeFailure, isAbortError, throwIfAborted } from "./chrome-errors";

const DEFAULT_FILE_MODE = 0o644;
const DEFAULT_DIRECTORY_MODE = 0o755;
const SYMLINK_FILE_TYPE = 0o120000;
const DIRECTORY_FILE_TYPE = 0o040000;
const MAX_SYMLINK_BYTES = 4096;

function extractFailure(): ChromeFailure {
  return new ChromeFailure("chrome_extract_failed");
}

export function sanitizeArchiveEntryPath(name: string): string {
  if (name.length === 0 || name.includes("\0") || name.includes("\\") || name.includes(":")) {
    throw extractFailure();
  }
  if (name.startsWith("/")) {
    throw extractFailure();
  }

  const segments = name.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0 || segments.some((segment) => segment === "..")) {
    throw extractFailure();
  }

  return segments.join("/");
}

function isInsideRoot(root: string, target: string): boolean {
  const relativePath = relative(root, target);
  return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

function resolveEntryTarget(root: string, relativePath: string): string {
  const target = resolve(root, ...relativePath.split("/"));
  if (!isInsideRoot(root, target)) {
    throw extractFailure();
  }
  return target;
}

function assertSafeSymlinkTarget(linkPath: string, linkTarget: string, root: string): void {
  if (
    linkTarget.length === 0 ||
    linkTarget.length > MAX_SYMLINK_BYTES ||
    linkTarget.includes("\0") ||
    linkTarget.includes("\\") ||
    linkTarget.includes(":") ||
    isAbsolute(linkTarget)
  ) {
    throw extractFailure();
  }

  const resolvedTarget = resolve(dirname(linkPath), linkTarget);
  if (!isInsideRoot(root, resolvedTarget)) {
    throw extractFailure();
  }
}

async function extractEntry(
  zip: StreamZip.StreamZipAsync,
  entry: StreamZip.ZipEntry,
  destination: string,
  signal: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);

  if (entry.encrypted) {
    throw extractFailure();
  }

  const relativePath = sanitizeArchiveEntryPath(entry.name);
  const target = resolveEntryTarget(destination, relativePath);
  const rawMode = entry.attr >>> 16;
  const fileType = rawMode & 0o170000;
  const permissions = rawMode & 0o777;

  if (entry.isDirectory || fileType === DIRECTORY_FILE_TYPE) {
    await mkdir(target, { recursive: true, mode: DEFAULT_DIRECTORY_MODE });
    return;
  }

  await mkdir(dirname(target), { recursive: true, mode: DEFAULT_DIRECTORY_MODE });

  if (fileType === SYMLINK_FILE_TYPE) {
    if (entry.size > MAX_SYMLINK_BYTES) {
      throw extractFailure();
    }
    const linkTarget = (await zip.entryData(entry)).toString("utf8");
    assertSafeSymlinkTarget(target, linkTarget, destination);
    await rm(target, { recursive: true, force: true });
    await symlink(linkTarget, target);
    return;
  }

  const mode = permissions === 0 ? DEFAULT_FILE_MODE : permissions;
  const source = Readable.from(await zip.stream(entry));

  await rm(target, { recursive: true, force: true });
  await pipeline(source, createWriteStream(target, { mode }), { signal });
  await chmod(target, mode);
}

export async function extractChromeArchive(
  archivePath: string,
  destination: string,
  signal: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  await mkdir(destination, { recursive: true, mode: 0o700 });

  const zip = new StreamZip.async({ file: archivePath, storeEntries: true });

  try {
    const entries = Object.values(await zip.entries());
    for (const entry of entries) {
      await extractEntry(zip, entry, destination, signal);
    }
  } catch (error) {
    if (error instanceof ChromeFailure || isAbortError(error)) {
      throw error;
    }
    throw extractFailure();
  } finally {
    await zip.close().catch(() => undefined);
  }
}

export async function findChromeExecutable(
  root: string,
  executableRelativePath: string,
  platform: ChromePlatform,
): Promise<string> {
  const relativePath = sanitizeArchiveEntryPath(executableRelativePath);
  const executable = resolveEntryTarget(root, relativePath);

  let stats;
  try {
    stats = await stat(executable);
  } catch {
    throw new ChromeFailure("chrome_executable_not_found");
  }

  if (!stats.isFile()) {
    throw new ChromeFailure("chrome_executable_not_found");
  }

  if (platform === "mac-arm64") {
    await chmod(executable, (stats.mode & 0o777) | 0o500);
  }

  try {
    await access(executable, constants.X_OK);
  } catch {
    throw new ChromeFailure("chrome_executable_not_found");
  }

  return executable;
}
