import { describe, expect, it, vi } from "vitest";
import type { ChromeInstallerState } from "../shared/chrome-installer";
import type { ProviderConfig, ProviderConfigRequest } from "../shared/provider";
import type { Session } from "../shared/session";
import { createApp, type ProfileService, type SessionService } from "./app";
import { createEventBus } from "./event-bus";
import { createEventStreamRegistry } from "./event-stream";
import { ProviderError } from "./provider-errors";
import { createTaskManager } from "./task-manager";

const token = "test-token";
const allowedOrigin = "http://127.0.0.1:5173";
const authorization = `Bearer ${token}`;
const fixedNow = "2026-10-25T10:00:00.000Z";
const apiKey = "client-secret-key";

const unconfigured: ProviderConfig = {
  provider: null,
  model: null,
  configured: false,
  updatedAt: null,
};

const configured: ProviderConfig = {
  provider: "gemini",
  model: "gemini-2.5-flash",
  configured: true,
  updatedAt: fixedNow,
};

const readyState: ChromeInstallerState = {
  status: "ready",
  source: "managed",
  version: "156.0.8078.47",
  progress: null,
  error: null,
};

const session: Session = {
  id: "s_0000000000000001",
  profileId: "p_0000000000000001",
  status: "ready",
  startedAt: fixedNow,
  endedAt: null,
  pid: null,
};

type ProvidersStub = {
  getConfig: () => ProviderConfig;
  setConfig: (input: ProviderConfigRequest) => Promise<ProviderConfig>;
};

function createHarness(initial: ProviderConfig = unconfigured) {
  let config = initial;
  const events = createEventBus();
  const sessions: SessionService = {
    start: async () => session,
    listActive: () => [session],
    get: (sessionId) => (sessionId === session.id ? session : null),
    close: async () => ({ ...session, status: "closed", endedAt: fixedNow }),
  };
  const profiles: ProfileService = {
    list: async () => [],
    create: async (name) => ({
      id: "p_0000000000000001",
      name,
      createdAt: fixedNow,
      lastUsedAt: null,
    }),
    delete: async () => undefined,
  };
  const providers: ProvidersStub = {
    getConfig: vi.fn(() => config),
    setConfig: vi.fn(async (input) => {
      config = {
        provider: "gemini",
        model: input.model,
        configured: true,
        updatedAt: fixedNow,
      };
      return config;
    }),
  };

  const app = createApp({
    token,
    allowedOrigin,
    chromeInstaller: {
      getState: () => readyState,
      start: async () => readyState,
      setLocalBinary: async () => ({ ok: true, path: "/tmp/chrome", version: "1" }),
      clearLocalBinary: async () => readyState,
    },
    profiles,
    profilePolicies: {
      get: async () => {
        throw new Error("Unused profile policy lookup.");
      },
      set: async () => {
        throw new Error("Unused profile policy update.");
      },
    },
    sessions,
    tasks: createTaskManager({ sessions, events, now: () => new Date(fixedNow) }),
    steps: { listByTask: () => [] },
    runner: {
      start: () => undefined,
      cancel: () => undefined,
    },
    actions: {
      execute: async () => {
        throw new Error("Unused action execution.");
      },
    },
    events,
    eventConnections: createEventStreamRegistry(),
    providers,
  });

  return { app, providers, setConfig: (next: ProviderConfig) => { config = next; } };
}

function withAuth(init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: { ...init.headers, Authorization: authorization },
  };
}

function jsonBody(method: string, body: unknown): RequestInit {
  return withAuth({
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /v1/providers", () => {
  it("returns the unconfigured shape without an error", async () => {
    const { app } = createHarness();
    const response = await app.request("/v1/providers", withAuth());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: unconfigured });
  });

  it("returns the configured shape without any key field", async () => {
    const { app } = createHarness(configured);
    const response = await app.request("/v1/providers", withAuth());
    const body = (await response.json()) as { data: ProviderConfig };

    expect(response.status).toBe(200);
    expect(body).toEqual({ data: configured });
    expect(Object.keys(body.data).sort()).toEqual([
      "configured",
      "model",
      "provider",
      "updatedAt",
    ]);
    expect(JSON.stringify(body)).not.toContain(apiKey);
  });

  it("requires the bearer token", async () => {
    const { app } = createHarness();
    const response = await app.request("/v1/providers");

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
  });
});

describe("PUT /v1/providers", () => {
  it("stores a valid configuration and returns it without the key", async () => {
    const { app, providers } = createHarness();
    const response = await app.request(
      "/v1/providers",
      jsonBody("PUT", {
        provider: "  gemini  ",
        model: "  gemini-2.5-flash  ",
        apiKey: `  ${apiKey}  `,
      }),
    );
    const body = (await response.json()) as { data: ProviderConfig };

    expect(response.status).toBe(200);
    expect(body.data).toEqual(configured);
    expect(JSON.stringify(body)).not.toContain(apiKey);
    expect(Object.keys(body.data).sort()).toEqual([
      "configured",
      "model",
      "provider",
      "updatedAt",
    ]);
    expect(providers.setConfig).toHaveBeenCalledWith({
      provider: "gemini",
      model: "gemini-2.5-flash",
      apiKey,
    });
  });

  it("rejects an unknown provider with 422 instead of a body error", async () => {
    const { app, providers } = createHarness();
    providers.setConfig = vi.fn(async () => {
      throw new ProviderError("provider_unknown");
    });
    const response = await app.request(
      "/v1/providers",
      jsonBody("PUT", { provider: "openai", model: "gpt-test", apiKey }),
    );

    expect(response.status).toBe(422);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    await expect(response.json()).resolves.toEqual({
      type: "about:blank",
      title: "Unprocessable Content",
      status: 422,
      detail: "Provider model tidak dikenal.",
    });
  });

  it("rejects a credential the provider refuses with 422", async () => {
    const { app, providers } = createHarness();
    providers.setConfig = vi.fn(async () => {
      throw new ProviderError(
        "provider_validation_failed",
        "API key Gemini ditolak atau tidak memiliki akses. Periksa kembali key dan izinnya.",
      );
    });
    const response = await app.request(
      "/v1/providers",
      jsonBody("PUT", { provider: "gemini", model: "gemini-2.5-flash", apiKey }),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      type: "about:blank",
      title: "Unprocessable Content",
      status: 422,
      detail:
        "API key Gemini ditolak atau tidak memiliki akses. Periksa kembali key dan izinnya.",
    });
  });

  it.each([
    {},
    { provider: "", model: "gemini-2.5-flash", apiKey },
    { provider: "gemini", model: "   ", apiKey },
    { provider: "gemini", model: "x".repeat(201), apiKey },
    { provider: "gemini", model: "gemini-2.5-flash", apiKey: "   " },
    { provider: "gemini", model: "gemini-2.5-flash", apiKey: "x".repeat(4097) },
    { provider: "gemini", model: "gemini-2.5-flash", apiKey, extra: true },
  ])("rejects an invalid body %j with 400", async (body) => {
    const { app, providers } = createHarness();
    const response = await app.request("/v1/providers", jsonBody("PUT", body));

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(providers.setConfig).not.toHaveBeenCalled();
  });

  it("returns a generic 500 when the write fails without leaking internal details", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { app, providers } = createHarness();
    providers.setConfig = vi.fn(async () => {
      throw new Error(`EACCES /Users/operator/${apiKey}/providers.json`);
    });
    const response = await app.request(
      "/v1/providers",
      jsonBody("PUT", { provider: "gemini", model: "gemini-2.5-flash", apiKey }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      type: "about:blank",
      title: "Internal Server Error",
      status: 500,
      detail: "Terjadi kesalahan internal.",
    });

    const logged = log.mock.calls.flat().join(" ");
    expect(logged).not.toContain(apiKey);
    expect(logged).not.toContain("/Users/operator");

    log.mockRestore();
  });

  it("requires the bearer token", async () => {
    const { app, providers } = createHarness();
    const response = await app.request("/v1/providers", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "gemini", model: "gemini-2.5-flash", apiKey }),
    });

    expect(response.status).toBe(401);
    expect(providers.setConfig).not.toHaveBeenCalled();
  });
});
