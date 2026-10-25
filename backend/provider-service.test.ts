import { randomBytes } from "node:crypto";
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ProviderError } from "./provider-errors";
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
const apiKey = "unit-test-secret-key-001";
const secondApiKey = "unit-test-secret-key-002";
const model = "gemini-2.5-flash";

function newAppDataDir(): string {
  return join(testRoot, `appdata-${randomBytes(4).toString("hex")}`);
}

function registryWith(
  validate: (input: { readonly model: string; readonly apiKey: string }) => Promise<ProviderValidation>,
) {
  return createProviderRegistry({ validateGemini: validate });
}

function acceptingRegistry() {
  return registryWith(async () => ({ ok: true }));
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

    expect(service.getConfig().configured).toBe(false);
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

    expect(service.getConfig()).toEqual({
      provider: null,
      model: null,
      configured: false,
      updatedAt: null,
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("writes the configuration atomically with mode 0600", async () => {
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
    });

    const file = providerFile(appDataDir);
    const contents: unknown = JSON.parse(await readFile(file, "utf8"));

    expect(contents).toEqual({
      provider: "gemini",
      model,
      apiKey,
      updatedAt: fixedNow.toISOString(),
    });
    if (typeof contents !== "object" || contents === null) {
      throw new Error("providers.json must be an object.");
    }
    expect(Object.keys(contents).sort()).toEqual(["apiKey", "model", "provider", "updatedAt"]);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(appDataDir)).mode & 0o777).toBe(0o700);
  });

  it("restores mode 0600 when overwriting an existing file", async () => {
    const appDataDir = newAppDataDir();
    const service = await createProviderService({
      appDataDir,
      registry: acceptingRegistry(),
      now: () => fixedNow,
    });
    const file = providerFile(appDataDir);

    await mkdir(appDataDir, { recursive: true });
    await writeFile(file, "stale", { mode: 0o644 });

    await service.setConfig({ provider: "gemini", model, apiKey });

    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("reads its saved configuration back from a new service instance", async () => {
    const appDataDir = newAppDataDir();
    const first = await createProviderService({
      appDataDir,
      registry: acceptingRegistry(),
      now: () => fixedNow,
    });
    await first.setConfig({ provider: "gemini", model, apiKey });

    const second = await createProviderService({
      appDataDir,
      registry: acceptingRegistry(),
    });

    expect(second.getConfig()).toEqual({
      provider: "gemini",
      model,
      configured: true,
      updatedAt: fixedNow.toISOString(),
    });
    expect(second.getActive()).toEqual({
      provider: "gemini",
      model,
      apiKey,
      updatedAt: fixedNow.toISOString(),
    });
  });

  it("rejects an unknown provider without writing a file", async () => {
    const appDataDir = newAppDataDir();
    const service = await createProviderService({
      appDataDir,
      registry: acceptingRegistry(),
    });

    const failure = service.setConfig({
      provider: "openai",
      model: "gpt-test",
      apiKey,
    });

    await expect(failure).rejects.toMatchObject({
      name: "ProviderError",
      code: "provider_unknown",
    });
    await expect(access(providerFile(appDataDir))).rejects.toThrow();
    expect(service.getActive()).toBeNull();
  });

  it("keeps the old configuration when credential validation fails", async () => {
    const appDataDir = newAppDataDir();
    const validate = vi.fn(
      async (): Promise<ProviderValidation> => ({
        ok: false,
        message: "API key Gemini ditolak atau tidak memiliki akses.",
      }),
    );
    const service = await createProviderService({
      appDataDir,
      registry: registryWith(validate),
      now: () => fixedNow,
    });

    await expect(
      service.setConfig({ provider: "gemini", model, apiKey: secondApiKey }),
    ).rejects.toBeInstanceOf(ProviderError);
    await expect(access(providerFile(appDataDir))).rejects.toThrow();
    expect(service.getConfig().configured).toBe(false);
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
    const validate = vi.fn(
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
      registry: registryWith(validate),
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
    expect(service.getActive()?.apiKey).toBe(secondApiKey);

    const contents: unknown = JSON.parse(await readFile(providerFile(appDataDir), "utf8"));
    expect(contents).toEqual({
      provider: "gemini",
      model: "model-two",
      apiKey: secondApiKey,
      updatedAt: fixedNow.toISOString(),
    });

    const entries = await readdir(appDataDir);
    expect(entries.filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  it("never logs the API key or file contents", async () => {
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
      registry: registryWith(async () => ({ ok: false, message: "Ditolak." })),
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
});
