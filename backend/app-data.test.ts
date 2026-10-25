import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveAppDataDir, writeApiCredentials } from "./app-data";

const testRoot = resolve(
  process.cwd(),
  "..",
  "tmp",
  "testing",
  `e1-shell-${randomBytes(4).toString("hex")}`,
);

beforeAll(async () => {
  await mkdir(testRoot, { recursive: true });
});

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

describe("writeApiCredentials", () => {
  it("writes only port and token with mode 0600", async () => {
    const appDataDir = join(testRoot, "appdata");

    await writeApiCredentials(appDataDir, { port: 54321, token: "unit-test-token" });

    const file = join(appDataDir, "api.json");
    const contents: unknown = JSON.parse(await readFile(file, "utf8"));

    expect(contents).toEqual({ port: 54321, token: "unit-test-token" });
    if (typeof contents !== "object" || contents === null) {
      throw new Error("api.json must be an object");
    }
    expect(Object.keys(contents).sort()).toEqual(["port", "token"]);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("restores mode 0600 when overwriting an existing file", async () => {
    const appDataDir = join(testRoot, "appdata-existing");
    const file = join(appDataDir, "api.json");

    await mkdir(appDataDir, { recursive: true });
    await writeFile(file, JSON.stringify({ port: 1, token: "old" }), { mode: 0o644 });

    await writeApiCredentials(appDataDir, { port: 60000, token: "new-token" });

    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await expect(readFile(file, "utf8")).resolves.toBe(
      JSON.stringify({ port: 60000, token: "new-token" }),
    );
  });
});

describe("resolveAppDataDir", () => {
  it("uses the environment override when present", () => {
    expect(resolveAppDataDir({ ARGUS_APP_DATA_DIR: "/custom/argus" })).toBe("/custom/argus");
  });

  it.skipIf(process.platform !== "darwin")("defaults to Argus inside the user app data", () => {
    expect(resolveAppDataDir({})).toBe(join(homedir(), "Library", "Application Support", "Argus"));
  });
});
