import { randomBytes } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChromeInstallerState } from "../shared/chrome-installer";
import { sessionSchema } from "../shared/session";
import {
  createSessionManager,
  type ChromeExecutableSource,
} from "./session-manager";
import type {
  BrowserLaunchResult,
  BrowserSessionContext,
  CdpCredentials,
  LaunchBrowser,
  LaunchBrowserOptions,
} from "./browser-launcher";
import { createProfile, getProfile, resolveProfileDir } from "./profile-store";

const testRoot = resolve(
  process.cwd(),
  "..",
  "tmp",
  "testing",
  `session-manager-${randomBytes(4).toString("hex")}`,
);

const now = new Date("2026-10-25T10:00:00.000Z");
const fakeCdpUrl = "http://127.0.0.1:59876";
const fakeCredentials: CdpCredentials = {
  gatewayUrl: fakeCdpUrl,
  bearerToken: "unit-test-bearer-token",
  extensionCdpUrl:
    "ws://127.0.0.1:59876/devtools/browser/test?token=unit-test-capability",
};

type FakeContext = BrowserSessionContext & {
  readonly closeCalls: number;
  emitClose(): void;
};

function createFakeContext(closeImpl?: () => Promise<void>): FakeContext {
  const listeners: Array<() => void> = [];
  let closeCalls = 0;
  const context: FakeContext = {
    get closeCalls() {
      return closeCalls;
    },
    async close() {
      closeCalls += 1;
      if (closeImpl !== undefined) {
        await closeImpl();
      }
      context.emitClose();
    },
    on(_event, listener) {
      listeners.push(listener);
    },
    pages() {
      return [];
    },
    async newPage() {
      throw new Error("Unused page creation.");
    },
    emitClose() {
      for (const listener of listeners) {
        listener();
      }
    },
  };
  return context;
}

function readyInstaller(path: string | null): ChromeExecutableSource {
  const state: ChromeInstallerState = {
    status: "ready",
    source: "managed",
    version: "156.0.8078.47",
    progress: null,
    error: null,
  };
  return {
    getState: () => state,
    getExecutablePath: () => path,
  };
}

function absentInstaller(): ChromeExecutableSource {
  const state: ChromeInstallerState = {
    status: "absent",
    source: null,
    version: null,
    progress: null,
    error: null,
  };
  return {
    getState: () => state,
    getExecutablePath: () => null,
  };
}

function executablePath(): string {
  return join(testRoot, "chrome-for-testing", "chrome");
}

function newAppDataDir(): string {
  return join(testRoot, `appdata-${randomBytes(4).toString("hex")}`);
}

function createManager(
  appDataDir: string,
  options: {
    readonly launchBrowser?: LaunchBrowser;
    readonly chromeInstaller?: ChromeExecutableSource;
  } = {},
) {
  return createSessionManager({
    appDataDir,
    chromeInstaller: options.chromeInstaller ?? readyInstaller(executablePath()),
    launchBrowser: options.launchBrowser,
    now: () => now,
  });
}

type FakeLauncher = {
  readonly launchBrowser: LaunchBrowser;
  readonly calls: LaunchBrowserOptions[];
};

function createFakeLauncher(contexts: BrowserSessionContext[]): FakeLauncher {
  const calls: LaunchBrowserOptions[] = [];
  return {
    calls,
    launchBrowser: async (options) => {
      calls.push(options);
      const context = contexts.shift();
      if (context === undefined) {
        throw new Error("No fake context available.");
      }
      return {
        context,
        cdpUrl: fakeCdpUrl,
        credentials: fakeCredentials,
        pid: 4242,
      };
    },
  };
}

beforeAll(async () => {
  await mkdir(testRoot, { recursive: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

describe("start", () => {
  it("opens a browser for the profile directory and returns a ready session", async () => {
    const appDataDir = newAppDataDir();
    const profile = await createProfile(appDataDir, "Sesi");
    const fake = createFakeLauncher([createFakeContext()]);
    const manager = createManager(appDataDir, { launchBrowser: fake.launchBrowser });

    const session = await manager.start(profile.id);

    expect(sessionSchema.parse(session)).toEqual(session);
    expect(session.id).toMatch(/^s_[0-9a-f]{16}$/);
    expect(session.profileId).toBe(profile.id);
    expect(session.status).toBe("ready");
    expect(session.startedAt).toBe(now.toISOString());
    expect(session.endedAt).toBeNull();
    expect(session.pid).toBeNull();
    expect(fake.calls).toEqual([
      {
        executablePath: executablePath(),
        userDataDir: resolveProfileDir(appDataDir, profile.id),
        profileId: profile.id,
      },
    ]);

    await manager.shutdown();
  });

  it("records lastUsedAt on the profile after the browser is ready", async () => {
    const appDataDir = newAppDataDir();
    const profile = await createProfile(appDataDir, "Sesi");
    const manager = createManager(appDataDir, {
      launchBrowser: createFakeLauncher([createFakeContext()]).launchBrowser,
    });

    await manager.start(profile.id);

    await expect(getProfile(appDataDir, profile.id)).resolves.toMatchObject({
      lastUsedAt: now.toISOString(),
    });

    await manager.shutdown();
  });

  it("keeps the session when the lastUsedAt update fails", async () => {
    const appDataDir = newAppDataDir();
    const profile = await createProfile(appDataDir, "Sesi");
    const profileDir = resolveProfileDir(appDataDir, profile.id);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const manager = createManager(appDataDir, {
      launchBrowser: createFakeLauncher([createFakeContext()]).launchBrowser,
    });

    await chmod(profileDir, 0o500);
    try {
      const session = await manager.start(profile.id);

      expect(session.status).toBe("ready");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain(profile.id);
    } finally {
      await chmod(profileDir, 0o700);
    }

    await expect(getProfile(appDataDir, profile.id)).resolves.toMatchObject({
      lastUsedAt: null,
    });

    await manager.shutdown();
  });

  it("rejects an unknown profile without launching a browser", async () => {
    const appDataDir = newAppDataDir();
    const fake = createFakeLauncher([createFakeContext()]);
    const manager = createManager(appDataDir, { launchBrowser: fake.launchBrowser });

    await expect(manager.start("p_aaaaaaaaaaaaaaaa")).rejects.toMatchObject({
      name: "SessionError",
      code: "session_profile_not_found",
      message: "Profil tidak ditemukan.",
    });
    expect(fake.calls).toEqual([]);
    expect(manager.listActive()).toEqual([]);
  });

  it("maps corrupt profile metadata to session_profile_corrupt", async () => {
    const appDataDir = newAppDataDir();
    const profileId = "p_bbbbbbbbbbbbbbbb";
    const profileDir = resolveProfileDir(appDataDir, profileId);
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    await writeFile(join(profileDir, "profile.json"), "{not-json", { mode: 0o600 });
    const fake = createFakeLauncher([createFakeContext()]);
    const manager = createManager(appDataDir, { launchBrowser: fake.launchBrowser });

    await expect(manager.start(profileId)).rejects.toMatchObject({
      name: "SessionError",
      code: "session_profile_corrupt",
      message: "Profil rusak dan tidak dapat dibuka.",
    });
    expect(fake.calls).toEqual([]);
  });

  it("rejects when Chrome for Testing is not ready", async () => {
    const appDataDir = newAppDataDir();
    const profile = await createProfile(appDataDir, "Sesi");
    const fake = createFakeLauncher([createFakeContext()]);
    const manager = createManager(appDataDir, {
      chromeInstaller: absentInstaller(),
      launchBrowser: fake.launchBrowser,
    });

    await expect(manager.start(profile.id)).rejects.toMatchObject({
      name: "SessionError",
      code: "session_chrome_not_ready",
      message: "Chrome for Testing belum siap.",
    });
    expect(fake.calls).toEqual([]);
    expect(manager.listActive()).toEqual([]);
  });

  it("rejects when the installer is ready without an executable path", async () => {
    const appDataDir = newAppDataDir();
    const profile = await createProfile(appDataDir, "Sesi");
    const fake = createFakeLauncher([createFakeContext()]);
    const manager = createManager(appDataDir, {
      chromeInstaller: readyInstaller(null),
      launchBrowser: fake.launchBrowser,
    });

    await expect(manager.start(profile.id)).rejects.toMatchObject({
      code: "session_chrome_not_ready",
    });
    expect(fake.calls).toEqual([]);
  });

  it("maps a launch failure to session_launch_failed and releases the profile", async () => {
    const appDataDir = newAppDataDir();
    const profile = await createProfile(appDataDir, "Sesi");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let attempts = 0;
    const launchBrowser: LaunchBrowser = async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("spawn /Users/secret/profile/chrome EACCES");
      }
      return {
        context: createFakeContext(),
        cdpUrl: fakeCdpUrl,
        credentials: fakeCredentials,
        pid: 4242,
      };
    };
    const manager = createManager(appDataDir, { launchBrowser });

    await expect(manager.start(profile.id)).rejects.toMatchObject({
      name: "SessionError",
      code: "session_launch_failed",
      message: "Browser gagal dibuka. Coba lagi.",
    });

    const failed = manager.listActive();
    expect(failed).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).not.toContain("/Users/secret");

    const session = await manager.start(profile.id);
    expect(session.status).toBe("ready");

    await manager.shutdown();
  });

  it("launches once for simultaneous starts of the same profile", async () => {
    const appDataDir = newAppDataDir();
    const profile = await createProfile(appDataDir, "Sesi");
    const calls: LaunchBrowserOptions[] = [];
    let resolveLaunch: (result: BrowserLaunchResult) => void = () => undefined;
    const launchBrowser: LaunchBrowser = (options) => {
      calls.push(options);
      return new Promise((resolvePromise) => {
        resolveLaunch = resolvePromise;
      });
    };
    const manager = createManager(appDataDir, { launchBrowser });

    const first = manager.start(profile.id);
    const second = manager.start(profile.id);

    await expect(second).rejects.toMatchObject({
      name: "SessionError",
      code: "session_conflict",
      message: "Profil ini sudah memiliki sesi aktif.",
    });
    await vi.waitFor(() => {
      expect(calls).toHaveLength(1);
    });

    resolveLaunch({
      context: createFakeContext(),
      cdpUrl: fakeCdpUrl,
      credentials: fakeCredentials,
      pid: 4242,
    });
    await expect(first).resolves.toMatchObject({ status: "ready" });

    await manager.shutdown();
  });

  it("rejects a second start while the session is closing", async () => {
    const appDataDir = newAppDataDir();
    const profile = await createProfile(appDataDir, "Sesi");
    let resolveClose: () => void = () => undefined;
    const closePromise = new Promise<void>((resolvePromise) => {
      resolveClose = resolvePromise;
    });
    const manager = createManager(appDataDir, {
      launchBrowser: createFakeLauncher([createFakeContext(() => closePromise)]).launchBrowser,
    });
    const session = await manager.start(profile.id);

    const closing = manager.close(session.id);

    await expect(manager.start(profile.id)).rejects.toMatchObject({
      code: "session_conflict",
    });

    resolveClose();
    await closing;
  });

  it("runs sessions for different profiles concurrently", async () => {
    const appDataDir = newAppDataDir();
    const first = await createProfile(appDataDir, "Pertama");
    const second = await createProfile(appDataDir, "Kedua");
    const manager = createManager(appDataDir, {
      launchBrowser: createFakeLauncher([createFakeContext(), createFakeContext()]).launchBrowser,
    });

    const firstSession = await manager.start(first.id);
    const secondSession = await manager.start(second.id);

    expect(firstSession.profileId).toBe(first.id);
    expect(secondSession.profileId).toBe(second.id);
    expect(manager.listActive().map((session) => session.profileId).sort()).toEqual(
      [first.id, second.id].sort(),
    );

    await manager.shutdown();
  });
});

describe("close", () => {
  it("closes the context, sets endedAt, and allows the profile to start again", async () => {
    const appDataDir = newAppDataDir();
    const profile = await createProfile(appDataDir, "Sesi");
    const fake = createFakeLauncher([createFakeContext(), createFakeContext()]);
    const manager = createManager(appDataDir, { launchBrowser: fake.launchBrowser });
    const session = await manager.start(profile.id);

    const closed = await manager.close(session.id);

    expect(closed).toEqual({
      ...session,
      status: "closed",
      endedAt: now.toISOString(),
    });
    expect(manager.listActive()).toEqual([]);
    expect(manager.get(session.id)?.status).toBe("closed");

    const reopened = await manager.start(profile.id);
    expect(reopened.status).toBe("ready");

    await manager.shutdown();
  });

  it("is idempotent", async () => {
    const appDataDir = newAppDataDir();
    const profile = await createProfile(appDataDir, "Sesi");
    const context = createFakeContext();
    const manager = createManager(appDataDir, {
      launchBrowser: createFakeLauncher([context]).launchBrowser,
    });
    const session = await manager.start(profile.id);

    const first = await manager.close(session.id);
    const second = await manager.close(session.id);

    expect(second).toEqual(first);
    expect(context.closeCalls).toBe(1);
  });

  it("waits for a starting session before closing it", async () => {
    const appDataDir = newAppDataDir();
    const profile = await createProfile(appDataDir, "Sesi");
    const context = createFakeContext();
    let resolveLaunch: (value: BrowserLaunchResult) => void = () => undefined;
    let notifyLaunchStarted: () => void = () => undefined;
    const launchStarted = new Promise<void>((resolvePromise) => {
      notifyLaunchStarted = resolvePromise;
    });
    const manager = createManager(appDataDir, {
      launchBrowser: () => {
        notifyLaunchStarted();
        return new Promise((resolvePromise) => {
          resolveLaunch = resolvePromise;
        });
      },
    });

    const starting = manager.start(profile.id);
    await launchStarted;
    const active = manager.listActive();
    expect(active).toHaveLength(1);
    const sessionId = active[0]?.id;
    expect(sessionId).toBeDefined();

    const closing = manager.close(String(sessionId));
    resolveLaunch({
      context,
      cdpUrl: fakeCdpUrl,
      credentials: fakeCredentials,
      pid: 4242,
    });

    await expect(starting).resolves.toMatchObject({ status: "ready" });
    await expect(closing).resolves.toMatchObject({ status: "closed" });
    expect(context.closeCalls).toBe(1);
    expect(manager.listActive()).toEqual([]);
  });

  it("rejects an unknown session with session_not_found", async () => {
    const manager = createManager(newAppDataDir());

    await expect(manager.close("s_aaaaaaaaaaaaaaaa")).rejects.toMatchObject({
      name: "SessionError",
      code: "session_not_found",
      message: "Sesi tidak ditemukan.",
    });
  });

  it("rejects with session_close_failed when the context does not close in time", async () => {
    const appDataDir = newAppDataDir();
    const profile = await createProfile(appDataDir, "Sesi");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const manager = createManager(appDataDir, {
      launchBrowser: createFakeLauncher([createFakeContext(() => new Promise(() => undefined))])
        .launchBrowser,
    });
    const session = await manager.start(profile.id);

    vi.useFakeTimers();
    const closing = manager.close(session.id);
    const assertion = expect(closing).rejects.toMatchObject({
      name: "SessionError",
      code: "session_close_failed",
      message: "Browser gagal ditutup.",
    });
    await vi.advanceTimersByTimeAsync(8_000);
    await assertion;
  });
});

describe("unexpected close", () => {
  it("marks the session closed, logs, and releases the profile", async () => {
    const appDataDir = newAppDataDir();
    const profile = await createProfile(appDataDir, "Sesi");
    const context = createFakeContext();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const manager = createManager(appDataDir, {
      launchBrowser: createFakeLauncher([context, createFakeContext()]).launchBrowser,
    });
    const session = await manager.start(profile.id);

    context.emitClose();

    expect(manager.get(session.id)).toEqual({
      ...session,
      status: "closed",
      endedAt: now.toISOString(),
    });
    expect(manager.listActive()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = String(warn.mock.calls[0]?.[0]);
    expect(logged).toContain(session.id);
    expect(logged).toContain(profile.id);

    const reopened = await manager.start(profile.id);
    expect(reopened.status).toBe("ready");

    await manager.shutdown();
  });

  it("does not log an unexpected close when close is managed", async () => {
    const appDataDir = newAppDataDir();
    const profile = await createProfile(appDataDir, "Sesi");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const manager = createManager(appDataDir, {
      launchBrowser: createFakeLauncher([createFakeContext()]).launchBrowser,
    });
    const session = await manager.start(profile.id);

    await manager.close(session.id);

    expect(warn).not.toHaveBeenCalled();
  });
});

describe("shutdown", () => {
  it("closes all sessions and is idempotent", async () => {
    const appDataDir = newAppDataDir();
    const first = await createProfile(appDataDir, "Pertama");
    const second = await createProfile(appDataDir, "Kedua");
    const firstContext = createFakeContext();
    const secondContext = createFakeContext();
    const manager = createManager(appDataDir, {
      launchBrowser: createFakeLauncher([firstContext, secondContext]).launchBrowser,
    });
    await manager.start(first.id);
    await manager.start(second.id);

    await manager.shutdown();
    await manager.shutdown();

    expect(manager.listActive()).toEqual([]);
    expect(firstContext.closeCalls).toBe(1);
    expect(secondContext.closeCalls).toBe(1);
  });

  it("never throws when a context fails to close", async () => {
    const appDataDir = newAppDataDir();
    const profile = await createProfile(appDataDir, "Sesi");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const manager = createManager(appDataDir, {
      launchBrowser: createFakeLauncher([
        createFakeContext(async () => {
          throw new Error("close failed");
        }),
      ]).launchBrowser,
    });
    await manager.start(profile.id);

    await expect(manager.shutdown()).resolves.toBeUndefined();
  });

  it("stops waiting after eight seconds", async () => {
    const appDataDir = newAppDataDir();
    const first = await createProfile(appDataDir, "Pertama");
    const manager = createManager(appDataDir, {
      launchBrowser: () => new Promise(() => undefined),
    });
    void manager.start(first.id);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    vi.useFakeTimers();
    const shutdown = manager.shutdown();
    let isSettled = false;
    void shutdown.then(() => {
      isSettled = true;
    });
    await vi.advanceTimersByTimeAsync(7_999);
    expect(isSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await shutdown;
    expect(isSettled).toBe(true);
  });
});

describe("get and listActive", () => {
  it("returns null for an unknown session", () => {
    const manager = createManager(newAppDataDir());

    expect(manager.get("s_bbbbbbbbbbbbbbbb")).toBeNull();
  });

  it("keeps closed sessions out of the active list", async () => {
    const appDataDir = newAppDataDir();
    const profile = await createProfile(appDataDir, "Sesi");
    const manager = createManager(appDataDir, {
      launchBrowser: createFakeLauncher([createFakeContext()]).launchBrowser,
    });
    const session = await manager.start(profile.id);

    expect(manager.listActive()).toEqual([session]);

    await manager.close(session.id);

    expect(manager.listActive()).toEqual([]);
    expect(manager.get(session.id)).toMatchObject({ status: "closed" });
  });
});

describe("getCdpUrl", () => {
  it("returns the cdp url while the session is ready", async () => {
    const appDataDir = newAppDataDir();
    const profile = await createProfile(appDataDir, "Sesi");
    const manager = createManager(appDataDir, {
      launchBrowser: createFakeLauncher([createFakeContext()]).launchBrowser,
    });

    const session = await manager.start(profile.id);

    expect(manager.getCdpUrl(session.id)).toBe(fakeCdpUrl);

    await manager.shutdown();
  });

  it("returns null after close", async () => {
    const appDataDir = newAppDataDir();
    const profile = await createProfile(appDataDir, "Sesi");
    const manager = createManager(appDataDir, {
      launchBrowser: createFakeLauncher([createFakeContext()]).launchBrowser,
    });
    const session = await manager.start(profile.id);

    await manager.close(session.id);

    expect(manager.getCdpUrl(session.id)).toBeNull();
  });

  it("returns null when the session fails to start", async () => {
    const appDataDir = newAppDataDir();
    const profile = await createProfile(appDataDir, "Sesi");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const manager = createManager(appDataDir, {
      launchBrowser: async () => {
        throw new Error("CDP endpoint is not ready after 5000 ms.");
      },
    });

    await expect(manager.start(profile.id)).rejects.toMatchObject({
      code: "session_launch_failed",
    });

    const logged = String(warn.mock.calls[0]?.[0]);
    const sessionId = logged.match(/s_[0-9a-f]{16}/)?.[0];
    expect(sessionId).toBeDefined();
    expect(manager.getCdpUrl(String(sessionId))).toBeNull();
    expect(manager.listActive()).toEqual([]);
  });

  it("returns null after the context closes unexpectedly", async () => {
    const appDataDir = newAppDataDir();
    const profile = await createProfile(appDataDir, "Sesi");
    const context = createFakeContext();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const manager = createManager(appDataDir, {
      launchBrowser: createFakeLauncher([context]).launchBrowser,
    });
    const session = await manager.start(profile.id);

    context.emitClose();

    expect(manager.getCdpUrl(session.id)).toBeNull();
  });

  it("returns null for an unknown session", () => {
    const manager = createManager(newAppDataDir());

    expect(manager.getCdpUrl("s_aaaaaaaaaaaaaaaa")).toBeNull();
  });
});

describe("getCdpCredentials", () => {
  it("returns the credentials while the session is ready", async () => {
    const appDataDir = newAppDataDir();
    const profile = await createProfile(appDataDir, "Sesi");
    const manager = createManager(appDataDir, {
      launchBrowser: createFakeLauncher([createFakeContext()]).launchBrowser,
    });

    const session = await manager.start(profile.id);

    expect(manager.getCdpCredentials(session.id)).toEqual(fakeCredentials);

    await manager.shutdown();
  });

  it("removes credentials before closing the context", async () => {
    const appDataDir = newAppDataDir();
    const profile = await createProfile(appDataDir, "Sesi");
    let credentialsDuringClose: CdpCredentials | null | undefined;
    let manager: ReturnType<typeof createManager> | null = null;
    let sessionId = "";
    const context = createFakeContext(async () => {
      credentialsDuringClose = manager?.getCdpCredentials(sessionId);
    });
    manager = createManager(appDataDir, {
      launchBrowser: createFakeLauncher([context]).launchBrowser,
    });
    const session = await manager.start(profile.id);
    sessionId = session.id;

    await manager.close(session.id);

    expect(credentialsDuringClose).toBeNull();
    expect(manager.getCdpCredentials(session.id)).toBeNull();
  });

  it("returns null after close", async () => {
    const appDataDir = newAppDataDir();
    const profile = await createProfile(appDataDir, "Sesi");
    const manager = createManager(appDataDir, {
      launchBrowser: createFakeLauncher([createFakeContext()]).launchBrowser,
    });
    const session = await manager.start(profile.id);

    await manager.close(session.id);

    expect(manager.getCdpCredentials(session.id)).toBeNull();
  });

  it("returns null after the context closes unexpectedly", async () => {
    const appDataDir = newAppDataDir();
    const profile = await createProfile(appDataDir, "Sesi");
    const context = createFakeContext();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const manager = createManager(appDataDir, {
      launchBrowser: createFakeLauncher([context]).launchBrowser,
    });
    const session = await manager.start(profile.id);

    context.emitClose();

    expect(manager.getCdpCredentials(session.id)).toBeNull();
  });

  it("returns null when the session fails to start", async () => {
    const appDataDir = newAppDataDir();
    const profile = await createProfile(appDataDir, "Sesi");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const manager = createManager(appDataDir, {
      launchBrowser: async () => {
        throw new Error("Chrome failed to launch.");
      },
    });

    await expect(manager.start(profile.id)).rejects.toMatchObject({
      code: "session_launch_failed",
    });

    const logged = String(warn.mock.calls[0]?.[0]);
    const sessionId = logged.match(/s_[0-9a-f]{16}/)?.[0];
    expect(sessionId).toBeDefined();
    expect(manager.getCdpCredentials(String(sessionId))).toBeNull();
  });

  it("returns null for an unknown session", () => {
    const manager = createManager(newAppDataDir());

    expect(manager.getCdpCredentials("s_aaaaaaaaaaaaaaaa")).toBeNull();
  });
});
