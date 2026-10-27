import { randomBytes, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  appendAuditEntry,
  auditEntrySchema,
  type AuditEntry,
} from "./audit-log";

const testRoot = resolve(
  process.cwd(),
  "..",
  "tmp",
  "testing",
  `audit-log-${randomBytes(4).toString("hex")}`,
);

function newAppDataDir(): string {
  return join(testRoot, `appdata-${randomBytes(4).toString("hex")}`);
}

function auditDir(appDataDir: string): string {
  return join(appDataDir, "audit");
}

function auditFile(appDataDir: string): string {
  return join(auditDir(appDataDir), "audit.jsonl");
}

function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: randomUUID(),
    actor: "operator",
    action: "approval.requested",
    resource: "t_0123456789abcdef",
    metadata: {
      approvalId: "a_0123456789abcdef",
      actionKind: "submit_form",
      category: "irreversible",
    },
    createdAt: "2026-10-27T10:00:00.000Z",
    ...overrides,
  };
}

function parseLines(contents: string): AuditEntry[] {
  return contents
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => auditEntrySchema.parse(JSON.parse(line)));
}

beforeAll(async () => {
  await mkdir(testRoot, { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

describe("appendAuditEntry", () => {
  it("appends three entries as newline-delimited json in order", async () => {
    const appDataDir = newAppDataDir();
    const entries = [
      makeEntry({ action: "approval.requested" }),
      makeEntry({ action: "approval.approved" }),
      makeEntry({ action: "approval.rejected" }),
    ];

    for (const entry of entries) {
      await expect(appendAuditEntry(appDataDir, entry)).resolves.toEqual({ written: true });
    }

    const contents = await readFile(auditFile(appDataDir), "utf8");
    expect(contents.endsWith("\n")).toBe(true);
    expect(parseLines(contents)).toEqual(entries);
    expect(contents.split("\n").filter((line) => line.length > 0)).toHaveLength(3);
  });

  it("creates the audit directory and file with restrictive modes", async () => {
    const appDataDir = newAppDataDir();

    await expect(access(auditFile(appDataDir))).rejects.toMatchObject({ code: "ENOENT" });

    await expect(appendAuditEntry(appDataDir, makeEntry())).resolves.toEqual({ written: true });

    expect((await stat(auditDir(appDataDir))).mode & 0o777).toBe(0o700);
    expect((await stat(auditFile(appDataDir))).mode & 0o777).toBe(0o600);
  });

  it("serializes twenty concurrent appends without interleaving", async () => {
    const appDataDir = newAppDataDir();
    const entries = Array.from({ length: 20 }, (_, index) =>
      makeEntry({
        metadata: {
          approvalId: `a_${index.toString(16).padStart(16, "0")}`,
          actionKind: `action_${index}`,
          category: "irreversible",
        },
      }),
    );

    const results = await Promise.all(
      entries.map((entry) => appendAuditEntry(appDataDir, entry)),
    );

    expect(results).toEqual(Array.from({ length: 20 }, () => ({ written: true })));

    const contents = await readFile(auditFile(appDataDir), "utf8");
    expect(contents.endsWith("\n")).toBe(true);

    const parsed = parseLines(contents);
    expect(parsed).toHaveLength(20);
    expect(parsed.map((entry) => entry.metadata.actionKind)).toEqual(
      entries.map((entry) => entry.metadata.actionKind),
    );
    expect(new Set(parsed.map((entry) => entry.id)).size).toBe(20);
  });

  it("rejects entries with unknown fields before writing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const appDataDir = newAppDataDir();
    const entry = makeEntry();
    const withUnknownField = { ...entry, goal: "kirim pesan rahasia" };
    const withUnknownMetadataField = {
      ...entry,
      metadata: { ...entry.metadata, pageText: "isi halaman" },
    };

    expect(auditEntrySchema.safeParse(withUnknownField).success).toBe(false);
    expect(auditEntrySchema.safeParse(withUnknownMetadataField).success).toBe(false);

    await expect(appendAuditEntry(appDataDir, withUnknownField)).resolves.toEqual({
      written: false,
    });
    await expect(access(auditFile(appDataDir))).rejects.toMatchObject({ code: "ENOENT" });

    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).not.toContain("kirim pesan rahasia");
    expect(logged).not.toContain(entry.metadata.approvalId);
    expect(logged).not.toContain(entry.id);
  });

  it("returns written false without throwing when the audit directory cannot be created", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const appDataDir = newAppDataDir();
    const entry = makeEntry();
    await mkdir(appDataDir, { recursive: true });
    await writeFile(auditDir(appDataDir), "blocker");

    await expect(appendAuditEntry(appDataDir, entry)).resolves.toEqual({ written: false });

    expect(warn).toHaveBeenCalledTimes(1);
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).not.toContain(entry.id);
    expect(logged).not.toContain(entry.metadata.approvalId);
  });
});
