import { randomBytes } from "node:crypto";
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ProviderError } from "./provider-errors";
import { providerKeyId } from "./provider-key-pool";
import { createProviderRegistry, type ProviderValidation } from "./provider-registry";
import { createProviderService } from "./provider-service";
import { PROVIDER_CONFIG_FILE } from "./provider-store";

const testRoot = resolve(
  process.cwd(),
  "..",
  "tmp",
  "testing",
  `provider-config-${randomBytes(4).toString("hex")}`,
);

const fixedNow = new Date("2026-10-25T10:00:00.000Z");
const later = new Date("2026-10-26T10:00:00.000Z");
const apiKey = "unit-test-secret-key-001";
const secondApiKey = "unit-test-secret-key-002";
const openRouterKey = "unit-test-openrouter-key";
const model = "gemini-2.5-flash";
const openRouterModel = "nvidia/nemotron-3.5-super-vl:free";

function newAppDataDir(): string {
  return join(testRoot, `appdata-${randomBytes(4).toString("hex")}`);
}

function readyKeys(...apiKeys: string[]) {
  return apiKeys.map((key) => ({
    id: providerKeyId(key),
    status: "ready" as const,
    cooldownUntil: null,
    lastUsedAt: null,
  }));
}

type Validator = (
  input: { readonly model: string; readonly apiKey: string },
) => Promise<ProviderValidation>;

function registryWith(options: {
  readonly gemini?: Validator;
  readonly openrouter?: Validator;
} = {}) {
  return createProviderRegistry({
    validateGemini: options.gemini ?? (async () => ({ ok: true })),
    validateOpenRouter: options.openrouter ?? (async () => ({ ok: true })),
  });
}

function acceptingRegistry() {
  return registryWith();
}

function providerFile(appDataDir: string): string {
  return join(appDataDir, PROVIDER_CONFIG_FILE);
}

beforeAll(async () => {
  await mkdir(testRoot, { recursive: true });
});

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("provider configuration service", () => {
  it("reports an unconfigured provider when the file is missing", async () => {
    const service = await createProviderService({
      appDataDir: newAppDataDir(),
      registry: acceptingRegistry(),
      now: () => fixedNow,
    });

    expect(service.getConfig()).toEqual({
      provider: null,
      model: null,
      configured: false,
      updatedAt: null,
      available: [],
      keys: [],
    });
    expect(service.getActive()).toBeNull();
  });

  it("treats invalid JSON as unconfigured and warns once without the contents", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const appDataDir = newAppDataDir();
    await mkdir(appDataDir, { recursive: true });
    await writeFile(
      providerFile(appDataDir),
      `{"provider":"gemini","model":"${model}","apiKey":"${apiKey}"`,
    );

    const service = await createProviderService({
      appDataDir,
      registry: acceptingRegistry(),
    });

    expect(service.getConfig()).toEqual({
      provider: null,
      model: null,
      configured: false,
      updatedAt: null,
      available: [],
      keys: [],
    });
    expect(service.getActive()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);

    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).not.toContain(apiKey);
    expect(logged).not.toContain("provider\":");
  });

  it("treats a schema mismatch as unconfigured without crashing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const appDataDir = newAppDataDir();
    await mkdir(appDataDir, { recursive: true });
    await writeFile(
      providerFile(appDataDir),
      JSON.stringify({
        provider: "openai",
        model,
        apiKey,
        updatedAt: fixedNow.toISOString(),
      }),
    );

    const service = await createProviderService({
      appDataDir,
      registry: acceptingRegistry(),
    });

    expect(service.getConfig().configured).toBe(false);
    expect(service.getConfig().available).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("writes the new multi-provider shape with mode 0600", async () => {
    const appDataDir = newAppDataDir();
    const service = await createProviderService({
      appDataDir,
      registry: acceptingRegistry(),
      now: () => fixedNow,
    });

    const config = await service.setConfig({
      provider: "gemini",
      model: `  ${model}  `,
      apiKey: `  ${apiKey}  `,
    });

    expect(config).toEqual({
      provider: "gemini",
      model,
      configured: true,
      updatedAt: fixedNow.toISOString(),
      available: ["gemini"],
      keys: readyKeys(apiKey),
    });

    const file = providerFile(appDataDir);
    const contents: unknown = JSON.parse(await readFile(file, "utf8"));

    expect(contents).toEqual({
      active: "gemini",
      configs: {
        gemini: { model, apiKeys: [apiKey], updatedAt: fixedNow.toISOString() },
      },
    });
    if (typeof contents !== "object" || contents === null) {
      throw new Error("providers.json must be an object.");
    }
    expect(Object.keys(contents).sort()).toEqual(["active", "configs"]);
  });

  it("stores OpenRouter without overwriting the saved Gemini configuration", async () => {
    const appDataDir = newAppDataDir();
    const validateOpenRouter = vi.fn<Validator>(async () => ({ ok: true }));
    const service = await createProviderService({
      appDataDir,
      registry: registryWith({ openrouter: validateOpenRouter }),
      now: () => fixedNow,
    });

    await service.setConfig({ provider: "gemini", model, apiKey });
    const config = await service.setConfig({
      provider: "openrouter",
      model: openRouterModel,
      apiKey: openRouterKey,
    });

    expect(validateOpenRouter).toHaveBeenCalledWith({
      model: openRouterModel,
      apiKey: openRouterKey,
    });
    expect(config).toEqual({
      provider: "openrouter",
      model: openRouterModel,
      configured: true,
      updatedAt: fixedNow.toISOString(),
      available: ["gemini", "openrouter"],
      keys: readyKeys(openRouterKey),
    });
    expect(service.getActive()).toEqual({
      provider: "openrouter",
      model: openRouterModel,
      apiKeys: [openRouterKey],
      updatedAt: fixedNow.toISOString(),
    });

    const contents: unknown = JSON.parse(await readFile(providerFile(appDataDir), "utf8"));
    expect(contents).toEqual({
      active: "openrouter",
      configs: {
        gemini: { model, apiKeys: [apiKey], updatedAt: fixedNow.toISOString() },
        openrouter: {
          model: openRouterModel,
          apiKeys: [openRouterKey],
          updatedAt: fixedNow.toISOString(),
        },
      },
    });
  });

  it("reactivates a stored provider without a new API key", async () => {
    const appDataDir = newAppDataDir();
    let now = fixedNow;
    const validateGemini = vi.fn<Validator>(async () => ({ ok: true }));
    const service = await createProviderService({
      appDataDir,
      registry: registryWith({ gemini: validateGemini }),
      now: () => now,
    });

    await service.setConfig({ provider: "gemini", model, apiKey });
    await service.setConfig({
      provider: "openrouter",
      model: openRouterModel,
      apiKey: openRouterKey,
    });

    now = later;
    const config = await service.setConfig({
      provider: "gemini",
      model: "gemini-2.5-pro",
    });

    expect(validateGemini).toHaveBeenLastCalledWith({
      model: "gemini-2.5-pro",
      apiKey,
    });
    expect(config).toEqual({
      provider: "gemini",
      model: "gemini-2.5-pro",
      configured: true,
      updatedAt: later.toISOString(),
      available: ["gemini", "openrouter"],
      keys: readyKeys(apiKey),
    });

    const contents: unknown = JSON.parse(await readFile(providerFile(appDataDir), "utf8"));
    expect(contents).toEqual({
      active: "gemini",
      configs: {
        gemini: {
          model: "gemini-2.5-pro",
          apiKeys: [apiKey],
          updatedAt: later.toISOString(),
        },
        openrouter: {
          model: openRouterModel,
          apiKeys: [openRouterKey],
          updatedAt: fixedNow.toISOString(),
        },
      },
    });
  });

  it("requires a stored API key when the request omits one", async () => {
    const appDataDir = newAppDataDir();
    const service = await createProviderService({
      appDataDir,
      registry: acceptingRegistry(),
    });

    await expect(
      service.setConfig({ provider: "gemini", model }),
    ).rejects.toMatchObject({
      name: "ProviderError",
      code: "provider_api_key_required",
      message: "API key wajib diisi untuk provider ini.",
    });
    await expect(access(providerFile(appDataDir))).rejects.toThrow();
    expect(service.getConfig().configured).toBe(false);
  });

  it("keeps the old configuration when credential validation fails", async () => {
    const appDataDir = newAppDataDir();
    const validate = vi.fn<Validator>(
      async (): Promise<ProviderValidation> => ({
        ok: false,
        message: "Model OpenRouter tidak mendukung structured output.",
      }),
    );
    const service = await createProviderService({
      appDataDir,
      registry: registryWith({ openrouter: validate }),
      now: () => fixedNow,
    });

    await service.setConfig({ provider: "gemini", model, apiKey });

    await expect(
      service.setConfig({
        provider: "openrouter",
        model: openRouterModel,
        apiKey: openRouterKey,
      }),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(service.getConfig()).toEqual({
      provider: "gemini",
      model,
      configured: true,
      updatedAt: fixedNow.toISOString(),
      available: ["gemini"],
      keys: readyKeys(apiKey),
    });

    const contents: unknown = JSON.parse(await readFile(providerFile(appDataDir), "utf8"));
    expect(contents).toEqual({
      active: "gemini",
      configs: {
        gemini: { model, apiKeys: [apiKey], updatedAt: fixedNow.toISOString() },
      },
    });
  });

  it("rejects an unknown provider without writing a file", async () => {
    const appDataDir = newAppDataDir();
    const service = await createProviderService({
      appDataDir,
      registry: acceptingRegistry(),
    });

    await expect(
      service.setConfig({
        provider: "openai",
        model: "gpt-test",
        apiKey,
      }),
    ).rejects.toMatchObject({
      name: "ProviderError",
      code: "provider_unknown",
    });
    await expect(access(providerFile(appDataDir))).rejects.toThrow();
    expect(service.getActive()).toBeNull();
  });

  it("reads two saved configurations back from a new service instance", async () => {
    const appDataDir = newAppDataDir();
    const first = await createProviderService({
      appDataDir,
      registry: acceptingRegistry(),
      now: () => fixedNow,
    });
    await first.setConfig({ provider: "gemini", model, apiKey });
    await first.setConfig({
      provider: "openrouter",
      model: openRouterModel,
      apiKey: openRouterKey,
    });

    const second = await createProviderService({
      appDataDir,
      registry: acceptingRegistry(),
    });

    expect(second.getConfig()).toEqual({
      provider: "openrouter",
      model: openRouterModel,
      configured: true,
      updatedAt: fixedNow.toISOString(),
      available: ["gemini", "openrouter"],
      keys: readyKeys(openRouterKey),
    });
    expect(second.getActive()).toEqual({
      provider: "openrouter",
      model: openRouterModel,
      apiKeys: [openRouterKey],
      updatedAt: fixedNow.toISOString(),
    });
  });

  it("migrates the legacy file in memory and writes the new shape on the next save", async () => {
    const appDataDir = newAppDataDir();
    await mkdir(appDataDir, { recursive: true });
    await writeFile(
      providerFile(appDataDir),
      JSON.stringify({
        provider: "gemini",
        model,
        apiKey,
        updatedAt: fixedNow.toISOString(),
      }),
    );

    const service = await createProviderService({
      appDataDir,
      registry: acceptingRegistry(),
      now: () => later,
    });

    expect(service.getConfig()).toEqual({
      provider: "gemini",
      model,
      configured: true,
      updatedAt: fixedNow.toISOString(),
      available: ["gemini"],
      keys: readyKeys(apiKey),
    });

    const contentsBefore: unknown = JSON.parse(
      await readFile(providerFile(appDataDir), "utf8"),
    );
    expect(contentsBefore).toHaveProperty("provider", "gemini");

    await service.setConfig({ provider: "gemini", model, apiKey: secondApiKey });

    const contentsAfter: unknown = JSON.parse(
      await readFile(providerFile(appDataDir), "utf8"),
    );
    expect(contentsAfter).toEqual({
      active: "gemini",
      configs: {
        gemini: {
          model,
          apiKeys: [secondApiKey],
          updatedAt: later.toISOString(),
        },
      },
    });
    expect(service.getConfig().keys).toEqual(readyKeys(secondApiKey));
  });

  it("does not update memory when the write fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const appDataFile = join(testRoot, `not-a-directory-${randomBytes(4).toString("hex")}`);
    await writeFile(appDataFile, "not a directory");

    const service = await createProviderService({
      appDataDir: appDataFile,
      registry: acceptingRegistry(),
    });

    await expect(
      service.setConfig({ provider: "gemini", model, apiKey }),
    ).rejects.toThrow();
    expect(service.getConfig().configured).toBe(false);
    expect(service.getActive()).toBeNull();
  });

  it("serializes concurrent writes so no key is mixed or file corrupted", async () => {
    const appDataDir = newAppDataDir();
    let releaseFirst: (() => void) | undefined;
    let firstEntered: (() => void) | undefined;
    const entered = new Promise<void>((resolveEntered) => {
      firstEntered = resolveEntered;
    });
    const validate = vi.fn<Validator>(
      async (input: { readonly model: string; readonly apiKey: string }) => {
        if (input.apiKey === apiKey) {
          firstEntered?.();
          await new Promise<void>((release) => {
            releaseFirst = release;
          });
        }
        return { ok: true } as const;
      },
    );
    const service = await createProviderService({
      appDataDir,
      registry: registryWith({ gemini: validate }),
      now: () => fixedNow,
    });

    const first = service.setConfig({ provider: "gemini", model: "model-one", apiKey });
    const second = service.setConfig({
      provider: "gemini",
      model: "model-two",
      apiKey: secondApiKey,
    });

    await entered;
    expect(validate).toHaveBeenCalledTimes(1);

    releaseFirst?.();
    await Promise.all([first, second]);

    expect(validate).toHaveBeenCalledTimes(2);
    expect(service.getConfig().model).toBe("model-two");
    expect(service.getActive()?.apiKeys).toEqual([secondApiKey]);

    const contents: unknown = JSON.parse(await readFile(providerFile(appDataDir), "utf8"));
    expect(contents).toEqual({
      active: "gemini",
      configs: {
        gemini: {
          model: "model-two",
          apiKeys: [secondApiKey],
          updatedAt: fixedNow.toISOString(),
        },
      },
    });

    const entries = await readdir(appDataDir);
    expect(entries.filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  it("never logs the API key or validation message", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const appDataDir = newAppDataDir();
    await mkdir(appDataDir, { recursive: true });
    await writeFile(
      providerFile(appDataDir),
      JSON.stringify({ provider: "gemini", model, apiKey, updatedAt: "bad" }),
    );

    const service = await createProviderService({
      appDataDir,
      registry: registryWith({
        gemini: async () => ({ ok: false, message: "Ditolak." }),
      }),
    });

    await expect(
      service.setConfig({ provider: "gemini", model, apiKey: secondApiKey }),
    ).rejects.toBeInstanceOf(ProviderError);

    const logged = [...warn.mock.calls, ...error.mock.calls, ...log.mock.calls]
      .flat()
      .join(" ");
    expect(logged).not.toContain(apiKey);
    expect(logged).not.toContain(secondApiKey);
    expect(logged).not.toContain("Ditolak.");
  });

  it("stores a deduped key pool and exposes stable opaque ids", async () => {
    const appDataDir = newAppDataDir();
    const validate = vi.fn<Validator>(async () => ({ ok: true }));
    const service = await createProviderService({
      appDataDir,
      registry: registryWith({ gemini: validate }),
      now: () => fixedNow,
    });

    const config = await service.setConfig({
      provider: "gemini",
      model,
      apiKeys: [apiKey, secondApiKey, apiKey],
    });

    expect(config.keys).toEqual(readyKeys(apiKey, secondApiKey));
    expect(validate).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(config)).not.toContain(apiKey);
    expect(JSON.stringify(config)).not.toContain(secondApiKey);

    const contents: unknown = JSON.parse(await readFile(providerFile(appDataDir), "utf8"));
    expect(contents).toEqual({
      active: "gemini",
      configs: {
        gemini: {
          model,
          apiKeys: [apiKey, secondApiKey],
          updatedAt: fixedNow.toISOString(),
        },
      },
    });

    const again = await createProviderService({
      appDataDir,
      registry: acceptingRegistry(),
    });
    expect(again.getConfig().keys.map((key) => key.id)).toEqual([
      providerKeyId(apiKey),
      providerKeyId(secondApiKey),
    ]);
  });

  it("stores a single apiKey as a one-element pool", async () => {
    const appDataDir = newAppDataDir();
    const service = await createProviderService({
      appDataDir,
      registry: acceptingRegistry(),
      now: () => fixedNow,
    });

    await service.setConfig({ provider: "gemini", model, apiKey });

    expect(service.getActive()?.apiKeys).toEqual([apiKey]);
    expect(service.getConfig().keys).toEqual(readyKeys(apiKey));
  });

  it("keeps the stored pool and file when any key fails validation", async () => {
    const appDataDir = newAppDataDir();
    const validate = vi.fn<Validator>(async (input) =>
      input.apiKey === secondApiKey
        ? { ok: false, message: "Kunci kedua ditolak." }
        : { ok: true },
    );
    const service = await createProviderService({
      appDataDir,
      registry: registryWith({ gemini: validate }),
      now: () => fixedNow,
    });

    await service.setConfig({ provider: "gemini", model, apiKeys: [apiKey] });
    const before = await readFile(providerFile(appDataDir), "utf8");

    const failure = await service
      .setConfig({ provider: "gemini", model, apiKeys: [apiKey, secondApiKey] })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      name: "ProviderError",
      code: "provider_validation_failed",
      message: "Kunci kedua ditolak.",
    });
    expect(String(failure)).not.toContain(secondApiKey);
    await expect(readFile(providerFile(appDataDir), "utf8")).resolves.toBe(before);
    expect(service.getConfig().keys).toEqual(readyKeys(apiKey));
  });

  it("selects keys in least-recently-used order and records lastUsedAt", async () => {
    const appDataDir = newAppDataDir();
    let current = fixedNow;
    const service = await createProviderService({
      appDataDir,
      registry: acceptingRegistry(),
      now: () => current,
    });

    await service.setConfig({
      provider: "gemini",
      model,
      apiKeys: [apiKey, secondApiKey],
    });

    expect(service.acquireKey("gemini")).toMatchObject({
      status: "selected",
      keyId: providerKeyId(apiKey),
      apiKey,
    });

    current = new Date(fixedNow.getTime() + 1_000);
    expect(service.acquireKey("gemini")).toMatchObject({
      status: "selected",
      keyId: providerKeyId(secondApiKey),
      apiKey: secondApiKey,
    });

    current = new Date(fixedNow.getTime() + 2_000);
    expect(service.acquireKey("gemini")).toMatchObject({
      status: "selected",
      keyId: providerKeyId(apiKey),
    });

    expect(service.getConfig().keys).toEqual([
      {
        id: providerKeyId(apiKey),
        status: "ready",
        cooldownUntil: null,
        lastUsedAt: new Date(fixedNow.getTime() + 2_000).toISOString(),
      },
      {
        id: providerKeyId(secondApiKey),
        status: "ready",
        cooldownUntil: null,
        lastUsedAt: new Date(fixedNow.getTime() + 1_000).toISOString(),
      },
    ]);
  });

  it("marks a key cool down and rejects a pool whose keys all failed auth", async () => {
    const appDataDir = newAppDataDir();
    const service = await createProviderService({
      appDataDir,
      registry: acceptingRegistry(),
      now: () => fixedNow,
    });

    await service.setConfig({ provider: "gemini", model, apiKeys: [apiKey] });
    service.acquireKey("gemini");
    service.markKeyFailure("gemini", providerKeyId(apiKey), "quota_exhausted", 90);

    expect(service.acquireKey("gemini")).toEqual({
      status: "cooldown",
      retryAfterSeconds: 90,
    });

    await service.setConfig({ provider: "gemini", model, apiKeys: [apiKey] });
    service.acquireKey("gemini");
    service.markKeyFailure("gemini", providerKeyId(apiKey), "auth_or_key", null);

    expect(service.acquireKey("gemini")).toEqual({ status: "rejected" });
  });

  it("resets every key status when a new pool is saved", async () => {
    const appDataDir = newAppDataDir();
    const service = await createProviderService({
      appDataDir,
      registry: acceptingRegistry(),
      now: () => fixedNow,
    });

    await service.setConfig({
      provider: "gemini",
      model,
      apiKeys: [apiKey, secondApiKey],
    });
    service.acquireKey("gemini");
    service.markKeyFailure("gemini", providerKeyId(apiKey), "quota_exhausted", 120);

    expect(service.getConfig().keys[0]?.status).toBe("cooldown");

    const config = await service.setConfig({
      provider: "gemini",
      model,
      apiKeys: [apiKey, secondApiKey],
    });

    expect(config.keys).toEqual(readyKeys(apiKey, secondApiKey));
  });

  it("does not persist key status across service instances", async () => {
    const appDataDir = newAppDataDir();
    const first = await createProviderService({
      appDataDir,
      registry: acceptingRegistry(),
      now: () => fixedNow,
    });

    await first.setConfig({
      provider: "gemini",
      model,
      apiKeys: [apiKey, secondApiKey],
    });
    first.acquireKey("gemini");
    first.markKeyFailure("gemini", providerKeyId(apiKey), "auth_or_key", null);
    expect(first.getConfig().keys[0]?.status).toBe("auth_failed");

    const second = await createProviderService({
      appDataDir,
      registry: acceptingRegistry(),
      now: () => fixedNow,
    });

    expect(second.getConfig().keys).toEqual(readyKeys(apiKey, secondApiKey));
  });
});
