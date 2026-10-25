import { randomBytes } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
  profileIdSchema,
  profileNameSchema,
  profileSchema,
  type Profile,
} from "../shared/profile";

const PROFILES_DIR = "profiles";
const METADATA_FILE = "profile.json";

const MESSAGES = {
  notFound: "Profil tidak ditemukan.",
  invalidName: "Nama profil harus 1 sampai 80 karakter dan tidak mengandung karakter kontrol.",
  corruptMetadata: "Metadata profil rusak dan tidak dapat dibaca.",
} as const;

export type ProfileStoreErrorCode =
  | "profile_not_found"
  | "invalid_profile_name"
  | "corrupt_profile_metadata";

export class ProfileStoreError extends Error {
  readonly code: ProfileStoreErrorCode;

  constructor(code: ProfileStoreErrorCode, message: string) {
    super(message);
    this.name = "ProfileStoreError";
    this.code = code;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function notFoundError(): ProfileStoreError {
  return new ProfileStoreError("profile_not_found", MESSAGES.notFound);
}

function corruptMetadataError(): ProfileStoreError {
  return new ProfileStoreError("corrupt_profile_metadata", MESSAGES.corruptMetadata);
}

function createProfileId(): string {
  return `p_${randomBytes(8).toString("hex")}`;
}

export function resolveProfileDir(appDataDir: string, profileId: string): string {
  if (!profileIdSchema.safeParse(profileId).success) {
    throw notFoundError();
  }

  const profilesRoot = resolve(appDataDir, PROFILES_DIR);
  const profileDir = resolve(profilesRoot, profileId);
  if (!profileDir.startsWith(`${profilesRoot}${sep}`)) {
    throw notFoundError();
  }

  return profileDir;
}

async function writeProfileMetadata(profileDir: string, profile: Profile): Promise<void> {
  const metadataFile = join(profileDir, METADATA_FILE);
  const tempFile = join(profileDir, `.${METADATA_FILE}-${randomBytes(4).toString("hex")}.tmp`);
  const contents = JSON.stringify(profileSchema.parse(profile));

  try {
    await writeFile(tempFile, contents, { mode: 0o600 });
    await chmod(tempFile, 0o600);
    await rename(tempFile, metadataFile);
  } catch (error) {
    await rm(tempFile, { force: true }).catch(() => {
      console.warn(`Failed to remove temporary profile metadata: ${profile.id}`);
    });
    throw error;
  }
}

async function readProfileMetadata(profileDir: string, profileId: string): Promise<Profile> {
  let stats: Stats;
  try {
    stats = await lstat(profileDir);
  } catch (error) {
    if (isMissing(error)) {
      throw notFoundError();
    }
    throw error;
  }

  if (!stats.isDirectory()) {
    throw corruptMetadataError();
  }

  let contents: string;
  try {
    contents = await readFile(join(profileDir, METADATA_FILE), "utf8");
  } catch (error) {
    if (isMissing(error)) {
      throw corruptMetadataError();
    }
    throw error;
  }

  let profile: Profile;
  try {
    profile = profileSchema.parse(JSON.parse(contents));
  } catch {
    throw corruptMetadataError();
  }

  if (profile.id !== profileId) {
    throw corruptMetadataError();
  }

  return profile;
}

export async function createProfile(appDataDir: string, name: string): Promise<Profile> {
  const parsedName = profileNameSchema.safeParse(name);
  if (!parsedName.success) {
    throw new ProfileStoreError("invalid_profile_name", MESSAGES.invalidName);
  }

  const profilesRoot = resolve(appDataDir, PROFILES_DIR);
  await mkdir(profilesRoot, { recursive: true, mode: 0o700 });

  const profileId = createProfileId();
  const profileDir = resolveProfileDir(appDataDir, profileId);
  await mkdir(profileDir, { mode: 0o700 });

  const profile: Profile = {
    id: profileId,
    name: parsedName.data,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };

  try {
    await writeProfileMetadata(profileDir, profile);
  } catch (error) {
    await rm(profileDir, { recursive: true, force: true }).catch(() => {
      console.warn(`Failed to clean up profile directory after metadata write failure: ${profileId}`);
    });
    throw error;
  }

  return profile;
}

export async function listProfiles(appDataDir: string): Promise<Profile[]> {
  const profilesRoot = resolve(appDataDir, PROFILES_DIR);

  let entries: Dirent[];
  try {
    entries = await readdir(profilesRoot, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) {
      return [];
    }
    throw error;
  }

  const profiles: Profile[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !profileIdSchema.safeParse(entry.name).success) {
      continue;
    }

    try {
      const profileDir = resolveProfileDir(appDataDir, entry.name);
      profiles.push(await readProfileMetadata(profileDir, entry.name));
    } catch (error) {
      if (error instanceof ProfileStoreError && error.code === "corrupt_profile_metadata") {
        console.warn(`Skipping profile with corrupt metadata: ${entry.name}`);
        continue;
      }
      if (error instanceof ProfileStoreError && error.code === "profile_not_found") {
        continue;
      }
      throw error;
    }
  }

  profiles.sort((left, right) => {
    if (left.createdAt !== right.createdAt) {
      return left.createdAt < right.createdAt ? -1 : 1;
    }
    if (left.id === right.id) {
      return 0;
    }
    return left.id < right.id ? -1 : 1;
  });

  return profiles;
}

export async function getProfile(appDataDir: string, profileId: string): Promise<Profile> {
  const profileDir = resolveProfileDir(appDataDir, profileId);
  return readProfileMetadata(profileDir, profileId);
}

export async function deleteProfile(appDataDir: string, profileId: string): Promise<void> {
  const profileDir = resolveProfileDir(appDataDir, profileId);

  let stats: Stats;
  try {
    stats = await lstat(profileDir);
  } catch (error) {
    if (isMissing(error)) {
      throw notFoundError();
    }
    throw error;
  }

  if (!stats.isDirectory()) {
    throw corruptMetadataError();
  }

  await rm(profileDir, { recursive: true, force: true });
}

export async function updateLastUsedAt(
  appDataDir: string,
  profileId: string,
  usedAt: Date = new Date(),
): Promise<Profile> {
  const profileDir = resolveProfileDir(appDataDir, profileId);
  const profile = await readProfileMetadata(profileDir, profileId);
  const updated: Profile = { ...profile, lastUsedAt: usedAt.toISOString() };
  await writeProfileMetadata(profileDir, updated);
  return updated;
}
