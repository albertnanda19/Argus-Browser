import { describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import type { ChromeInstallerState } from "../shared/chrome-installer";
import type { ChromeLocalValidation } from "./chrome-local-binary";
import type { Profile } from "../shared/profile";
import type { Session, SessionStatus } from "../shared/session";
import { createApp } from "./app";
import { createEventBus } from "./event-bus";
import { createEventStreamRegistry } from "./event-stream";
import { ProfileStoreError } from "./profile-store";
import { SessionError } from "./session-errors";
import { createTaskManager } from "./task-manager";

const token = "test-token";
const allowedOrigin = "http://127.0.0.1:5173";
const authorization = `Bearer ${token}`;
const now = "2026-10-25T10:00:00.000Z";

const readyState: ChromeInstallerState = {
  status: "ready",
  source: "managed",
  version: "156.0.8078.47",
  progress: null,
  error: null,
};

const downloadingState: ChromeInstallerState = {
  status: "downloading",
  source: "managed",
  version: "156.0.8078.47",
  progress: { receivedBytes: 1024, totalBytes: null, percent: null },
  error: null,
};

const absentState: ChromeInstallerState = {
  status: "absent",
  source: null,
  version: null,
  progress: null,
  error: null,
};

let profileSequence = 0;

function nextProfileId(): string {
  profileSequence += 1;
  return `p_${profileSequence.toString(16).padStart(16, "0")}`;
}

function makeProfile(name = "Kerja"): Profile {
  return { id: nextProfileId(), name, createdAt: now, lastUsedAt: null };
}

function createFakeInstaller(initial: ChromeInstallerState = readyState) {
  let state = initial;

  const service = {
    getState: vi.fn((): ChromeInstallerState => state),
    start: vi.fn(async (): Promise<ChromeInstallerState> => state),
    setLocalBinary: vi.fn(
      async (): Promise<ChromeLocalValidation> => ({
        ok: true,
        path: "/tmp/chrome-for-testing",
        version: "156.0.8078.47",
      }),
    ),
    clearLocalBinary: vi.fn(async (): Promise<ChromeInstallerState> => {
      state = absentState;
      return state;
    }),
  };

  return {
    service,
    get state() {
      return state;
    },
    setState(next: ChromeInstallerState) {
      state = next;
    },
  };
}

function createFakeProfiles(initial: Profile[] = []) {
  const profiles = initial.map((profile) => ({ ...profile }));

  const service = {
    list: vi.fn(async (): Promise<Profile[]> => profiles.map((profile) => ({ ...profile }))),
    create: vi.fn(async (name: string): Promise<Profile> => {
      const profile: Profile = {
        id: nextProfileId(),
        name: name.trim(),
        createdAt: now,
        lastUsedAt: null,
      };
      profiles.push(profile);
      return { ...profile };
    }),
    delete: vi.fn(async (profileId: string): Promise<void> => {
      const index = profiles.findIndex((profile) => profile.id === profileId);
      if (index === -1) {
        throw new ProfileStoreError("profile_not_found", "Profil tidak ditemukan.");
      }
      profiles.splice(index, 1);
    }),
  };

  return { service, profiles };
}

function createFakeSessions() {
  const sessions = new Map<string, Session>();
  let sequence = 0;

  const service = {
    start: vi.fn(async (profileId: string): Promise<Session> => {
      sequence += 1;
      const session: Session = {
        id: `s_${sequence.toString(16).padStart(16, "0")}`,
        profileId,
        status: "ready",
        startedAt: now,
        endedAt: null,
        pid: null,
      };
      sessions.set(session.id, session);
      return { ...session };
    }),
    listActive: vi.fn((): Session[] =>
      [...sessions.values()]
        .filter((session) => ["starting", "ready", "busy", "closing"].includes(session.status))
        .map((session) => ({ ...session })),
    ),
    get: vi.fn((sessionId: string): Session | null => {
      const session = sessions.get(sessionId);
      return session === undefined ? null : { ...session };
    }),
    close: vi.fn(async (sessionId: string): Promise<Session> => {
      const session = sessions.get(sessionId);
      if (session === undefined) {
        throw new SessionError("session_not_found");
      }
      const closed: Session = { ...session, status: "closed", endedAt: now };
      sessions.set(sessionId, closed);
      return { ...closed };
    }),
  };

  return { service, sessions };
}

type InstallerService = ReturnType<typeof createFakeInstaller>["service"];
type ProfilesService = ReturnType<typeof createFakeProfiles>["service"];
type SessionsService = ReturnType<typeof createFakeSessions>["service"];

function createHarness(
  overrides: {
    readonly chromeInstaller?: InstallerService;
    readonly profiles?: ProfilesService;
    readonly sessions?: SessionsService;
  } = {},
) {
  const installer = createFakeInstaller();
  const profiles = createFakeProfiles();
  const sessions = createFakeSessions();
  const events = createEventBus();
  const tasks = createTaskManager({
    sessions: sessions.service,
    events,
    now: () => new Date(now),
  });

  const app = createApp({
    token,
    allowedOrigin,
    chromeInstaller: overrides.chromeInstaller ?? installer.service,
    profiles: overrides.profiles ?? profiles.service,
    sessions: overrides.sessions ?? sessions.service,
    tasks,
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
    providers: {
      getConfig: () => ({
        provider: null,
        model: null,
        configured: false,
        updatedAt: null,
      }),
      setConfig: async () => {
        throw new Error("Unused provider update.");
      },
    },
    events,
    eventConnections: createEventStreamRegistry(),
  });

  return { app, installer, profiles, sessions };
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

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function resolvesBefore<T>(promise: Promise<T>, timeoutMs = 500): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error("Request waited for background work."));
    }, timeoutMs);
    timer.unref();
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function makeSession(profileId: string, status: SessionStatus, sequence = 1): Session {
  return {
    id: `s_${sequence.toString(16).padStart(16, "0")}`,
    profileId,
    status,
    startedAt: now,
    endedAt: status === "closed" || status === "error" ? now : null,
    pid: null,
  };
}

describe("authentication and CORS", () => {
  it("rejects a request without a bearer token", async () => {
    const { app } = createHarness();
    const response = await app.request("/v1/health");

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    await expect(response.json()).resolves.toEqual({
      type: "about:blank",
      title: "Unauthorized",
      status: 401,
      detail: "Token akses tidak valid.",
    });
  });

  it("rejects a request with a wrong bearer token", async () => {
    const { app } = createHarness();
    const response = await app.request("/v1/health", {
      headers: { Authorization: "Bearer wrong-token" },
    });

    expect(response.status).toBe(401);
  });

  it("allows CORS only for the UI origin with every API method", async () => {
    const { app } = createHarness();
    const allowed = await app.request("/v1/health", withAuth({ headers: { Origin: allowedOrigin } }));
    const foreign = await app.request(
      "/v1/health",
      withAuth({ headers: { Origin: "https://example.com" } }),
    );

    expect(allowed.headers.get("access-control-allow-origin")).toBe(allowedOrigin);
    expect(allowed.headers.get("access-control-allow-methods")).toBe(
      "GET, POST, PUT, DELETE, OPTIONS",
    );
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("answers preflight for the UI origin without a token", async () => {
    const { app } = createHarness();
    const response = await app.request("/v1/profiles", {
      method: "OPTIONS",
      headers: {
        Origin: allowedOrigin,
        "Access-Control-Request-Method": "DELETE",
        "Access-Control-Request-Headers": "authorization",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(allowedOrigin);
    expect(response.headers.get("access-control-allow-headers")).toContain("Authorization");
  });

  it("returns a problem document for an unknown route", async () => {
    const { app } = createHarness();
    const response = await app.request("/v1/unknown", withAuth());

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    await expect(response.json()).resolves.toEqual({
      type: "about:blank",
      title: "Not Found",
      status: 404,
      detail: "Endpoint tidak ditemukan.",
    });
  });

  it("requires a token before an unknown route is revealed", async () => {
    const { app } = createHarness();
    const response = await app.request("/v1/unknown");

    expect(response.status).toBe(401);
  });
});

describe("GET /v1/health", () => {
  it("reports ready Chrome as ok", async () => {
    const { app } = createHarness();
    const response = await app.request("/v1/health", withAuth());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: { ok: true, chrome: { status: "ready", version: "156.0.8078.47" } },
    });
  });

  it("reports a Chrome download as not ok", async () => {
    const installer = createFakeInstaller(downloadingState);
    const { app } = createHarness({ chromeInstaller: installer.service });
    const response = await app.request("/v1/health", withAuth());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: {
        ok: false,
        chrome: { status: "downloading", version: "156.0.8078.47" },
      },
    });
    expect(installer.service.start).not.toHaveBeenCalled();
  });
});

describe("browser endpoints", () => {
  it("returns the installer error state with 200", async () => {
    const errorState: ChromeInstallerState = {
      status: "error",
      source: "managed",
      version: "156.0.8078.47",
      progress: null,
      error: { code: "chrome_download_failed", message: "Unduhan gagal." },
    };
    const installer = createFakeInstaller(errorState);
    const { app } = createHarness({ chromeInstaller: installer.service });
    const response = await app.request("/v1/browser", withAuth());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: errorState });
  });

  it("starts a download in the background and returns 202", async () => {
    const installer = createFakeInstaller(absentState);
    let resolveStart: ((state: ChromeInstallerState) => void) | undefined;
    installer.service.start.mockReturnValue(
      new Promise<ChromeInstallerState>((resolve) => {
        resolveStart = resolve;
      }),
    );
    const { app } = createHarness({ chromeInstaller: installer.service });

    const response = await resolvesBefore(
      Promise.resolve(app.request("/v1/browser/download", withAuth({ method: "POST" }))),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ data: absentState });
    expect(installer.service.start).toHaveBeenCalledTimes(1);

    resolveStart?.(readyState);
  });

  it("does not start another download while one is running", async () => {
    const installer = createFakeInstaller(downloadingState);
    const { app } = createHarness({ chromeInstaller: installer.service });
    const response = await app.request("/v1/browser/download", withAuth({ method: "POST" }));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ data: downloadingState });
    expect(installer.service.start).not.toHaveBeenCalled();
  });

  it("does not replace an active local binary", async () => {
    const localState: ChromeInstallerState = {
      status: "ready",
      source: "local",
      version: "156.0.8078.47",
      progress: null,
      error: null,
    };
    const installer = createFakeInstaller(localState);
    const { app } = createHarness({ chromeInstaller: installer.service });
    const response = await app.request("/v1/browser/download", withAuth({ method: "POST" }));

    expect(response.status).toBe(202);
    expect(installer.service.start).not.toHaveBeenCalled();
  });

  it("accepts a valid local executable", async () => {
    const installer = createFakeInstaller(absentState);
    const { app } = createHarness({ chromeInstaller: installer.service });
    const localState: ChromeInstallerState = {
      status: "ready",
      source: "local",
      version: "156.0.8078.47",
      progress: null,
      error: null,
    };
    installer.setState(localState);

    const response = await app.request(
      "/v1/browser/local-executable",
      jsonBody("PUT", { path: "/tmp/chrome-for-testing" }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: localState });
    expect(installer.service.setLocalBinary).toHaveBeenCalledWith("/tmp/chrome-for-testing");
  });

  it("rejects an invalid local executable with 422 and the installer message", async () => {
    const installer = createFakeInstaller(absentState);
    installer.service.setLocalBinary.mockResolvedValue({
      ok: false,
      error: {
        code: "chrome_local_invalid",
        message: "Berkas yang dipilih bukan Chrome for Testing yang dapat dijalankan.",
      },
    });
    const { app } = createHarness({ chromeInstaller: installer.service });

    const response = await app.request(
      "/v1/browser/local-executable",
      jsonBody("PUT", { path: "/tmp/not-chrome" }),
    );

    expect(response.status).toBe(422);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    await expect(response.json()).resolves.toEqual({
      type: "about:blank",
      title: "Unprocessable Content",
      status: 422,
      detail: "Berkas yang dipilih bukan Chrome for Testing yang dapat dijalankan.",
    });
  });

  it("rejects a local executable body with extra fields", async () => {
    const { app } = createHarness();
    const response = await app.request(
      "/v1/browser/local-executable",
      jsonBody("PUT", { path: "/tmp/chrome", extra: true }),
    );

    expect(response.status).toBe(400);
  });

  it("clears the local executable with 204", async () => {
    const installer = createFakeInstaller(absentState);
    const { app } = createHarness({ chromeInstaller: installer.service });
    const response = await app.request(
      "/v1/browser/local-executable",
      withAuth({ method: "DELETE" }),
    );

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(installer.service.clearLocalBinary).toHaveBeenCalledTimes(1);
  });
});

describe("profile endpoints", () => {
  it("lists profiles with default pagination", async () => {
    const profile = makeProfile();
    const profiles = createFakeProfiles([profile]);
    const { app } = createHarness({ profiles: profiles.service });
    const response = await app.request("/v1/profiles", withAuth());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: [profile],
      total: 1,
      page: 1,
      page_size: 20,
    });
  });

  it("paginates profiles", async () => {
    const first = makeProfile("Satu");
    const second = makeProfile("Dua");
    const profiles = createFakeProfiles([first, second]);
    const { app } = createHarness({ profiles: profiles.service });
    const response = await app.request("/v1/profiles?page=2&page_size=1", withAuth());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: [second],
      total: 2,
      page: 2,
      page_size: 1,
    });
  });

  it.each(["page=0", "page=abc", "page_size=0", "page_size=101"])(
    "rejects invalid pagination %s",
    async (query) => {
      const { app } = createHarness();
      const response = await app.request(`/v1/profiles?${query}`, withAuth());

      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toContain("application/problem+json");
    },
  );

  it("creates a profile with 201", async () => {
    const profiles = createFakeProfiles();
    const { app } = createHarness({ profiles: profiles.service });
    const response = await app.request("/v1/profiles", jsonBody("POST", { name: "  Kerja  " }));

    expect(response.status).toBe(201);
    const body = await json<{ data: Profile }>(response);
    expect(body.data.name).toBe("Kerja");
    expect(body.data.id).toMatch(/^p_[0-9a-f]{16}$/);
    expect(profiles.profiles).toHaveLength(1);
  });

  it.each([
    { name: "" },
    { name: "   " },
    { name: "bad\u0000name" },
    { name: "Kerja", extra: true },
    {},
  ])("rejects an invalid create profile body %j", async (body) => {
    const profiles = createFakeProfiles();
    const { app } = createHarness({ profiles: profiles.service });
    const response = await app.request("/v1/profiles", jsonBody("POST", body));

    expect(response.status).toBe(400);
    expect(profiles.service.create).not.toHaveBeenCalled();
  });

  it("deletes a profile with 204", async () => {
    const profile = makeProfile();
    const profiles = createFakeProfiles([profile]);
    const { app } = createHarness({ profiles: profiles.service });
    const response = await app.request(`/v1/profiles/${profile.id}`, withAuth({ method: "DELETE" }));

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(profiles.profiles).toHaveLength(0);
  });

  it("rejects an invalid profile id with 400", async () => {
    const { app } = createHarness();
    const response = await app.request("/v1/profiles/not-a-profile", withAuth({ method: "DELETE" }));

    expect(response.status).toBe(400);
  });

  it("returns 404 for a missing profile", async () => {
    const missing = makeProfile();
    const { app } = createHarness();
    const response = await app.request(`/v1/profiles/${missing.id}`, withAuth({ method: "DELETE" }));

    expect(response.status).toBe(404);
  });

  it("refuses to delete a profile with an active session", async () => {
    const profile = makeProfile();
    const profiles = createFakeProfiles([profile]);
    const sessions = createFakeSessions();
    sessions.sessions.set("s_0000000000000001", makeSession(profile.id, "ready"));
    const { app } = createHarness({ profiles: profiles.service, sessions: sessions.service });
    const response = await app.request(`/v1/profiles/${profile.id}`, withAuth({ method: "DELETE" }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      type: "about:blank",
      title: "Conflict",
      status: 409,
      detail: "Profil ini masih memiliki sesi aktif.",
    });
    expect(profiles.profiles).toHaveLength(1);
    expect(profiles.service.delete).not.toHaveBeenCalled();
  });

  it("waits for a running start before checking active sessions", async () => {
    const profile = makeProfile();
    const profiles = createFakeProfiles([profile]);
    const sessions = createFakeSessions();
    let releaseStart: (() => void) | undefined;
    const startEntered = new Promise<void>((resolve) => {
      sessions.service.start.mockImplementationOnce(async (profileId: string) => {
        resolve();
        await new Promise<void>((release) => {
          releaseStart = release;
        });
        const session = makeSession(profileId, "ready");
        sessions.sessions.set(session.id, session);
        return session;
      });
    });
    const { app } = createHarness({ profiles: profiles.service, sessions: sessions.service });

    const startResponse = app.request(
      "/v1/sessions",
      jsonBody("POST", { profileId: profile.id }),
    );
    await startEntered;

    const deleteResponse = app.request(
      `/v1/profiles/${profile.id}`,
      withAuth({ method: "DELETE" }),
    );
    await flushAsync();
    expect(profiles.service.delete).not.toHaveBeenCalled();

    releaseStart?.();
    const started = await startResponse;
    const deleted = await deleteResponse;

    expect(started.status).toBe(201);
    expect(deleted.status).toBe(409);
    expect(profiles.service.delete).not.toHaveBeenCalled();
  });

  it("makes a start wait for deletion and return 404", async () => {
    const profile = makeProfile();
    const profiles = createFakeProfiles([profile]);
    const sessions = createFakeSessions();
    let releaseDelete: (() => void) | undefined;
    const deleteEntered = new Promise<void>((resolve) => {
      profiles.service.delete.mockImplementationOnce(async (profileId: string) => {
        resolve();
        await new Promise<void>((release) => {
          releaseDelete = release;
        });
        const index = profiles.profiles.findIndex((item) => item.id === profileId);
        profiles.profiles.splice(index, 1);
      });
    });
    sessions.service.start.mockImplementationOnce(async (profileId: string) => {
      if (!profiles.profiles.some((item) => item.id === profileId)) {
        throw new SessionError("session_profile_not_found");
      }
      return makeSession(profileId, "ready");
    });
    const { app } = createHarness({ profiles: profiles.service, sessions: sessions.service });

    const deleteResponse = app.request(
      `/v1/profiles/${profile.id}`,
      withAuth({ method: "DELETE" }),
    );
    await deleteEntered;

    const startResponse = app.request(
      "/v1/sessions",
      jsonBody("POST", { profileId: profile.id }),
    );
    await flushAsync();
    expect(sessions.service.start).not.toHaveBeenCalled();

    releaseDelete?.();
    expect((await deleteResponse).status).toBe(204);
    expect((await startResponse).status).toBe(404);
  });
});

describe("session endpoints", () => {
  it("creates a session with 201 after the browser is ready", async () => {
    const profile = makeProfile();
    const profiles = createFakeProfiles([profile]);
    const { app } = createHarness({ profiles: profiles.service });
    const response = await app.request("/v1/sessions", jsonBody("POST", { profileId: profile.id }));

    expect(response.status).toBe(201);
    const body = await json<{ data: Session }>(response);
    expect(body.data.profileId).toBe(profile.id);
    expect(body.data.status).toBe("ready");
    expect(body.data.pid).toBeNull();
  });

  it("rejects an invalid profile id with 400", async () => {
    const { app } = createHarness();
    const response = await app.request("/v1/sessions", jsonBody("POST", { profileId: "bad" }));

    expect(response.status).toBe(400);
  });

  it("rejects a create session body with extra fields", async () => {
    const profile = makeProfile();
    const { app } = createHarness();
    const response = await app.request(
      "/v1/sessions",
      jsonBody("POST", { profileId: profile.id, extra: true }),
    );

    expect(response.status).toBe(400);
  });

  it.each([
    ["session_profile_not_found", 404, "Profil tidak ditemukan."],
    ["session_profile_corrupt", 422, "Profil rusak dan tidak dapat dibuka."],
    ["session_chrome_not_ready", 422, "Chrome for Testing belum siap."],
    ["session_conflict", 409, "Profil ini sudah memiliki sesi aktif."],
    ["session_launch_failed", 500, "Browser gagal dibuka. Coba lagi."],
  ] as const)("maps %s to %i", async (code, status, detail) => {
    const profile = makeProfile();
    const sessions = createFakeSessions();
    sessions.service.start.mockRejectedValue(new SessionError(code));
    const { app } = createHarness({ sessions: sessions.service });
    const response = await app.request("/v1/sessions", jsonBody("POST", { profileId: profile.id }));

    expect(response.status).toBe(status);
    const body = await json<{ detail: string }>(response);
    expect(body.detail).toBe(detail);
  });

  it("lists only active sessions with pagination", async () => {
    const profile = makeProfile();
    const sessions = createFakeSessions();
    sessions.sessions.set("s_0000000000000001", makeSession(profile.id, "ready", 1));
    sessions.sessions.set("s_0000000000000002", makeSession(profile.id, "closed", 2));
    sessions.sessions.set("s_0000000000000003", makeSession(profile.id, "busy", 3));
    const { app } = createHarness({ sessions: sessions.service });
    const response = await app.request("/v1/sessions?page=1&page_size=1", withAuth());

    expect(response.status).toBe(200);
    const body = await json<{ data: Session[]; total: number; page: number; page_size: number }>(
      response,
    );
    expect(body.total).toBe(2);
    expect(body.page).toBe(1);
    expect(body.page_size).toBe(1);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.status).toBe("ready");
  });

  it("rejects invalid session pagination with 400", async () => {
    const { app } = createHarness();
    const response = await app.request("/v1/sessions?page_size=1000", withAuth());

    expect(response.status).toBe(400);
  });

  it("returns a closed session by id", async () => {
    const profile = makeProfile();
    const sessions = createFakeSessions();
    const closed = makeSession(profile.id, "closed");
    sessions.sessions.set(closed.id, closed);
    const { app } = createHarness({ sessions: sessions.service });
    const response = await app.request(`/v1/sessions/${closed.id}`, withAuth());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: closed });
  });

  it("rejects an invalid session id with 400", async () => {
    const { app } = createHarness();
    const response = await app.request("/v1/sessions/not-a-session", withAuth());

    expect(response.status).toBe(400);
  });

  it("returns 404 for an unknown session", async () => {
    const session = makeSession(makeProfile().id, "ready");
    const { app } = createHarness();
    const response = await app.request(`/v1/sessions/${session.id}`, withAuth());

    expect(response.status).toBe(404);
  });

  it("closes a session with 204", async () => {
    const profile = makeProfile();
    const sessions = createFakeSessions();
    const session = makeSession(profile.id, "ready");
    sessions.sessions.set(session.id, session);
    const { app } = createHarness({ sessions: sessions.service });
    const response = await app.request(`/v1/sessions/${session.id}`, withAuth({ method: "DELETE" }));

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(sessions.service.close).toHaveBeenCalledWith(session.id);
  });

  it("returns 204 when closing an already closed session", async () => {
    const profile = makeProfile();
    const sessions = createFakeSessions();
    const session = makeSession(profile.id, "closed");
    sessions.sessions.set(session.id, session);
    const { app } = createHarness({ sessions: sessions.service });
    const response = await app.request(`/v1/sessions/${session.id}`, withAuth({ method: "DELETE" }));

    expect(response.status).toBe(204);
  });

  it("returns 500 when closing a session fails", async () => {
    const profile = makeProfile();
    const sessions = createFakeSessions();
    const session = makeSession(profile.id, "ready");
    sessions.sessions.set(session.id, session);
    sessions.service.close.mockRejectedValue(new SessionError("session_close_failed"));
    const { app } = createHarness({ sessions: sessions.service });
    const response = await app.request(`/v1/sessions/${session.id}`, withAuth({ method: "DELETE" }));

    expect(response.status).toBe(500);
    const body = await json<{ detail: string }>(response);
    expect(body.detail).toBe("Browser gagal ditutup.");
  });
});

describe("unexpected failures", () => {
  it("returns a generic problem document and logs without details", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const profiles = createFakeProfiles();
    profiles.service.list.mockRejectedValue(new Error("secret internal detail"));
    const { app } = createHarness({ profiles: profiles.service });
    const response = await app.request("/v1/profiles", withAuth());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      type: "about:blank",
      title: "Internal Server Error",
      status: 500,
      detail: "Terjadi kesalahan internal.",
    });
    expect(log).toHaveBeenCalled();
    const logged = log.mock.calls.flat().join(" ");
    expect(logged).not.toContain("secret internal detail");

    log.mockRestore();
  });
});

function makeSessionMapApp(session: Session): Hono {
  const sessions = createFakeSessions();
  sessions.sessions.set(session.id, session);
  return createHarness({ sessions: sessions.service }).app;
}

describe("session lookup", () => {
  it("does not expose closed sessions in the active list", async () => {
    const profile = makeProfile();
    const session = makeSession(profile.id, "closed");
    const app = makeSessionMapApp(session);
    const response = await app.request("/v1/sessions", withAuth());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: [],
      total: 0,
      page: 1,
      page_size: 20,
    });
  });
});
