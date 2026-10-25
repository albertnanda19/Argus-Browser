import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { profileSchema, type Profile } from "../shared/profile";
import {
  createProfile,
  deleteProfile,
  getProfile,
  listProfiles,
  resolveProfileDir,
  updateLastUsedAt,
} from "./profile-store";

const testRoot = resolve(
  process.cwd(),
  "..",
  "tmp",
  "testing",
  `profile-store-${randomBytes(4).toString("hex")}`,
);

function newAppDataDir(): string {
  return join(testRoot, `appdata-${randomBytes(4).toString("hex")}`);
}

async function seedProfile(appDataDir: string, profile: Profile): Promise<void> {
  const profileDir = resolveProfileDir(appDataDir, profile.id);
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  await writeFile(join(profileDir, "profile.json"), JSON.stringify(profile), { mode: 0o600 });
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

describe("createProfile", () => {
  it("creates a profile directory and metadata with restrictive modes", async () => {
    const appDataDir = newAppDataDir();

    const profile = await createProfile(appDataDir, "  Kerja Utama  ");

    expect(profile.id).toMatch(/^p_[0-9a-f]{16}$/);
    expect(profile.name).toBe("Kerja Utama");
    expect(profile.lastUsedAt).toBeNull();
    expect(profile.createdAt.endsWith("Z")).toBe(true);

    const profileDir = resolveProfileDir(appDataDir, profile.id);
    expect((await stat(profileDir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(appDataDir, "profiles"))).mode & 0o777).toBe(0o700);

    const metadataFile = join(profileDir, "profile.json");
    expect((await stat(metadataFile)).mode & 0o777).toBe(0o600);
    expect(await readdir(profileDir)).toEqual(["profile.json"]);

    const stored: unknown = JSON.parse(await readFile(metadataFile, "utf8"));
    expect(profileSchema.parse(stored)).toEqual(profile);
  });

  it("generates unique ids", async () => {
    const appDataDir = newAppDataDir();

    const first = await createProfile(appDataDir, "Pertama");
    const second = await createProfile(appDataDir, "Kedua");

    expect(first.id).not.toBe(second.id);
  });

  it("accepts a name of exactly 80 characters after trimming", async () => {
    const appDataDir = newAppDataDir();
    const name = "a".repeat(80);

    const profile = await createProfile(appDataDir, `  ${name}  `);

    expect(profile.name).toBe(name);
  });

  it.each([
    ["empty", ""],
    ["whitespace only", "   "],
    ["too long", "a".repeat(81)],
    ["newline", "Kerja\nUtama"],
    ["null character", "Kerja\u0000Utama"],
    ["tab", "Kerja\tUtama"],
  ])("rejects an invalid name: %s", async (_label, name) => {
    const appDataDir = newAppDataDir();

    await expect(createProfile(appDataDir, name)).rejects.toMatchObject({
      name: "ProfileStoreError",
      code: "invalid_profile_name",
    });
  });
});

describe("listProfiles", () => {
  it("returns an empty list when the profiles root does not exist", async () => {
    await expect(listProfiles(newAppDataDir())).resolves.toEqual([]);
  });

  it("sorts by createdAt and then by id", async () => {
    const appDataDir = newAppDataDir();
    const base = { name: "Profil", lastUsedAt: null };

    await seedProfile(appDataDir, {
      ...base,
      id: "p_cccccccccccccccc",
      createdAt: "2026-01-02T00:00:00.000Z",
    });
    await seedProfile(appDataDir, {
      ...base,
      id: "p_bbbbbbbbbbbbbbbb",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await seedProfile(appDataDir, {
      ...base,
      id: "p_aaaaaaaaaaaaaaaa",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const profiles = await listProfiles(appDataDir);

    expect(profiles.map((profile) => profile.id)).toEqual([
      "p_aaaaaaaaaaaaaaaa",
      "p_bbbbbbbbbbbbbbbb",
      "p_cccccccccccccccc",
    ]);
  });

  it("skips corrupt metadata with an id-only log and does not delete it", async () => {
    const appDataDir = newAppDataDir();
    const valid = await createProfile(appDataDir, "Valid");
    const corruptId = "p_dddddddddddddddd";
    const corruptDir = resolveProfileDir(appDataDir, corruptId);
    await mkdir(corruptDir, { recursive: true, mode: 0o700 });
    await writeFile(
      join(corruptDir, "profile.json"),
      JSON.stringify({ id: corruptId, name: "Nama Rahasia" }),
      { mode: 0o600 },
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const profiles = await listProfiles(appDataDir);

    expect(profiles.map((profile) => profile.id)).toEqual([valid.id]);
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = String(warn.mock.calls[0]?.[0]);
    expect(logged).toContain(corruptId);
    expect(logged).not.toContain("Nama Rahasia");
    expect((await stat(corruptDir)).isDirectory()).toBe(true);
  });

  it("ignores entries that are not profile directories", async () => {
    const appDataDir = newAppDataDir();
    const valid = await createProfile(appDataDir, "Valid");
    const profilesRoot = join(appDataDir, "profiles");
    await writeFile(join(profilesRoot, "notes.txt"), "bukan profil");
    await mkdir(join(profilesRoot, "bukan-id"), { mode: 0o700 });

    const profiles = await listProfiles(appDataDir);

    expect(profiles.map((profile) => profile.id)).toEqual([valid.id]);
  });
});

describe("getProfile", () => {
  it("returns a created profile", async () => {
    const appDataDir = newAppDataDir();
    const created = await createProfile(appDataDir, "Kerja");

    await expect(getProfile(appDataDir, created.id)).resolves.toEqual(created);
  });

  it("rejects an unknown id with profile_not_found", async () => {
    const appDataDir = newAppDataDir();

    await expect(getProfile(appDataDir, "p_eeeeeeeeeeeeeeee")).rejects.toMatchObject({
      name: "ProfileStoreError",
      code: "profile_not_found",
      message: "Profil tidak ditemukan.",
    });
  });

  it("rejects an id that escapes the profiles root with profile_not_found", async () => {
    const appDataDir = newAppDataDir();

    await expect(getProfile(appDataDir, "../outside")).rejects.toMatchObject({
      code: "profile_not_found",
    });
    expect(() => resolveProfileDir(appDataDir, "../../etc/passwd")).toThrow(
      "Profil tidak ditemukan.",
    );
  });

  it("rejects corrupt metadata with corrupt_profile_metadata and keeps the files", async () => {
    const appDataDir = newAppDataDir();
    const profileId = "p_ffffffffffffffff";
    const profileDir = resolveProfileDir(appDataDir, profileId);
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    const metadataFile = join(profileDir, "profile.json");
    await writeFile(metadataFile, "{not-json", { mode: 0o600 });

    await expect(getProfile(appDataDir, profileId)).rejects.toMatchObject({
      name: "ProfileStoreError",
      code: "corrupt_profile_metadata",
      message: "Metadata profil rusak dan tidak dapat dibaca.",
    });
    await expect(readFile(metadataFile, "utf8")).resolves.toBe("{not-json");
  });

  it("rejects a profile directory without metadata as corrupt", async () => {
    const appDataDir = newAppDataDir();
    const profileId = "p_1111111111111111";
    await mkdir(resolveProfileDir(appDataDir, profileId), { recursive: true, mode: 0o700 });

    await expect(getProfile(appDataDir, profileId)).rejects.toMatchObject({
      code: "corrupt_profile_metadata",
    });
  });
});

describe("deleteProfile", () => {
  it("removes the whole profile directory including nested data", async () => {
    const appDataDir = newAppDataDir();
    const profile = await createProfile(appDataDir, "Hapus");
    const profileDir = resolveProfileDir(appDataDir, profile.id);
    const nestedDir = join(profileDir, "Default", "Cookies");
    await mkdir(nestedDir, { recursive: true });
    await writeFile(join(nestedDir, "cookie.db"), "data");

    await deleteProfile(appDataDir, profile.id);

    await expect(stat(profileDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(getProfile(appDataDir, profile.id)).rejects.toMatchObject({
      code: "profile_not_found",
    });
  });

  it("rejects an unknown id with profile_not_found", async () => {
    await expect(deleteProfile(newAppDataDir(), "p_2222222222222222")).rejects.toMatchObject({
      code: "profile_not_found",
    });
  });

  it("does not delete anything outside the profiles root", async () => {
    const appDataDir = newAppDataDir();
    const outsideDir = join(appDataDir, "outside");
    await mkdir(outsideDir, { recursive: true });
    await writeFile(join(outsideDir, "keep.txt"), "keep");

    await expect(deleteProfile(appDataDir, "../outside")).rejects.toMatchObject({
      code: "profile_not_found",
    });
    await expect(readFile(join(outsideDir, "keep.txt"), "utf8")).resolves.toBe("keep");
  });
});

describe("updateLastUsedAt", () => {
  it("updates lastUsedAt atomically and keeps metadata mode 0600", async () => {
    const appDataDir = newAppDataDir();
    const created = await createProfile(appDataDir, "Sesi");
    const usedAt = new Date("2026-02-03T04:05:06.789Z");

    const updated = await updateLastUsedAt(appDataDir, created.id, usedAt);

    expect(updated.lastUsedAt).toBe("2026-02-03T04:05:06.789Z");
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.name).toBe(created.name);

    const profileDir = resolveProfileDir(appDataDir, created.id);
    expect(await readdir(profileDir)).toEqual(["profile.json"]);
    expect((await stat(join(profileDir, "profile.json"))).mode & 0o777).toBe(0o600);

    const stored: unknown = JSON.parse(await readFile(join(profileDir, "profile.json"), "utf8"));
    expect(profileSchema.parse(stored).lastUsedAt).toBe("2026-02-03T04:05:06.789Z");
  });

  it("rejects an unknown id with profile_not_found", async () => {
    await expect(
      updateLastUsedAt(newAppDataDir(), "p_3333333333333333"),
    ).rejects.toMatchObject({ code: "profile_not_found" });
  });

  it("rejects corrupt metadata without overwriting it", async () => {
    const appDataDir = newAppDataDir();
    const profileId = "p_4444444444444444";
    const profileDir = resolveProfileDir(appDataDir, profileId);
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    const metadataFile = join(profileDir, "profile.json");
    await writeFile(metadataFile, "rusak", { mode: 0o600 });

    await expect(updateLastUsedAt(appDataDir, profileId)).rejects.toMatchObject({
      code: "corrupt_profile_metadata",
    });
    await expect(readFile(metadataFile, "utf8")).resolves.toBe("rusak");
  });
});
