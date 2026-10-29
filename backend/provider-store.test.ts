import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PROVIDER_CONFIG_FILE,
  readStoredProviderConfig,
  writeStoredProviderConfig,
  type StoredProviderFile,
} from "./provider-store";

const testRoot = resolve(
  process.cwd(),
  "..",
  "tmp",
  "testing",
  `provider-store-${randomBytes(4).toString("hex")}`,
);
const updatedAt = "2026-10-25T10:00:00.000Z";
const geminiKey = "unit-test-gemini-key";
const openRouterKey = "unit-test-openrouter-key";

function newAppDataDir(): string {
  return join(testRoot, `appdata-${randomBytes(4).toString("hex")}`);
}

function providerFile(appDataDir: string): string {
  return join(appDataDir, PROVIDER_CONFIG_FILE);
}

const twoConfigs: StoredProviderFile = {
  active: "openrouter",
  configs: {
    gemini: {
      model: "gemini-2.5-flash",
      apiKeys: [geminiKey],
      updatedAt,
    },
    openrouter: {
      model: "nvidia/nemotron-3.5-super-vl:free",
      apiKeys: [openRouterKey],
      updatedAt,
    },
  },
};

beforeAll(async () => {
  await mkdir(testRoot, { recursive: true });
});

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

describe("provider store", () => {
  it("reports a missing file without creating one", async () => {
    await expect(readStoredProviderConfig(newAppDataDir())).resolves.toEqual({
      status: "missing",
    });
  });

  it("reads the multi-provider shape with two configurations", async () => {
    const appDataDir = newAppDataDir();
    await mkdir(appDataDir, { recursive: true });
    await writeFile(providerFile(appDataDir), JSON.stringify(twoConfigs));

    await expect(readStoredProviderConfig(appDataDir)).resolves.toEqual({
      status: "ok",
      config: twoConfigs,
    });
  });

  it("migrates the legacy single-provider shape in memory", async () => {
    const appDataDir = newAppDataDir();
    await mkdir(appDataDir, { recursive: true });
    await writeFile(
      providerFile(appDataDir),
      JSON.stringify({
        provider: "gemini",
        model: "gemini-2.5-flash",
        apiKey: geminiKey,
        updatedAt,
      }),
    );

    const read = await readStoredProviderConfig(appDataDir);

    expect(read).toEqual({
      status: "ok",
      config: {
        active: "gemini",
        configs: {
          gemini: {
            model: "gemini-2.5-flash",
            apiKeys: [geminiKey],
            updatedAt,
          },
        },
      },
    });

    if (read.status !== "ok") {
      throw new Error("Expected a migrated configuration.");
    }

    await writeStoredProviderConfig(appDataDir, read.config);

    const contents: unknown = JSON.parse(await readFile(providerFile(appDataDir), "utf8"));
    expect(contents).toEqual({
      active: "gemini",
      configs: {
        gemini: {
          model: "gemini-2.5-flash",
          apiKeys: [geminiKey],
          updatedAt,
        },
      },
    });
  });

  it("migrates a multi-provider entry with a single apiKey to a one-key pool", async () => {
    const appDataDir = newAppDataDir();
    await mkdir(appDataDir, { recursive: true });
    await writeFile(
      providerFile(appDataDir),
      JSON.stringify({
        active: "openrouter",
        configs: {
          gemini: { model: "gemini-2.5-flash", apiKey: geminiKey, updatedAt },
          openrouter: {
            model: "nvidia/nemotron-3.5-super-vl:free",
            apiKey: openRouterKey,
            updatedAt,
          },
        },
      }),
    );

    await expect(readStoredProviderConfig(appDataDir)).resolves.toEqual({
      status: "ok",
      config: twoConfigs,
    });
  });

  it("rejects an active provider without a configuration", async () => {
    const appDataDir = newAppDataDir();
    await mkdir(appDataDir, { recursive: true });
    await writeFile(
      providerFile(appDataDir),
      JSON.stringify({
        active: "openrouter",
        configs: {
          gemini: { model: "gemini-2.5-flash", apiKey: geminiKey, updatedAt },
        },
      }),
    );

    await expect(readStoredProviderConfig(appDataDir)).resolves.toEqual({
      status: "invalid",
    });
  });

  it("rejects unknown fields at every level", async () => {
    const cases = [
      { ...twoConfigs, extra: true },
      { ...twoConfigs, configs: { ...twoConfigs.configs, openai: {} } },
      {
        ...twoConfigs,
        configs: {
          ...twoConfigs.configs,
          gemini: { ...twoConfigs.configs.gemini, extra: true },
        },
      },
    ];

    for (const value of cases) {
      const appDataDir = newAppDataDir();
      await mkdir(appDataDir, { recursive: true });
      await writeFile(providerFile(appDataDir), JSON.stringify(value));

      await expect(readStoredProviderConfig(appDataDir)).resolves.toEqual({
        status: "invalid",
      });
    }
  });

  it("rejects an unknown provider in the legacy shape", async () => {
    const appDataDir = newAppDataDir();
    await mkdir(appDataDir, { recursive: true });
    await writeFile(
      providerFile(appDataDir),
      JSON.stringify({
        provider: "openai",
        model: "gpt-test",
        apiKey: geminiKey,
        updatedAt,
      }),
    );

    await expect(readStoredProviderConfig(appDataDir)).resolves.toEqual({
      status: "invalid",
    });
  });

  it("rejects malformed JSON", async () => {
    const appDataDir = newAppDataDir();
    await mkdir(appDataDir, { recursive: true });
    await writeFile(providerFile(appDataDir), "{");

    await expect(readStoredProviderConfig(appDataDir)).resolves.toEqual({
      status: "invalid",
    });
  });

  it("writes atomically with mode 0600 and no temporary file", async () => {
    const appDataDir = newAppDataDir();

    await writeStoredProviderConfig(appDataDir, twoConfigs);

    const file = providerFile(appDataDir);
    const contents: unknown = JSON.parse(await readFile(file, "utf8"));

    expect(contents).toEqual(twoConfigs);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(appDataDir)).mode & 0o777).toBe(0o700);
    expect((await readdir(appDataDir)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  it("restores mode 0600 when overwriting an existing file", async () => {
    const appDataDir = newAppDataDir();
    await mkdir(appDataDir, { recursive: true });
    await writeFile(providerFile(appDataDir), "stale", { mode: 0o644 });

    await writeStoredProviderConfig(appDataDir, twoConfigs);

    expect((await stat(providerFile(appDataDir))).mode & 0o777).toBe(0o600);
  });
});
