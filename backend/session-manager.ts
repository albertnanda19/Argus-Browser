import { randomBytes } from "node:crypto";
import type { ChromeInstallerState } from "../shared/chrome-installer";
import type { Session, SessionStatus } from "../shared/session";
import { launchBrowser, type BrowserSessionContext, type CdpCredentials, type LaunchBrowser } from "./browser-launcher";
import { getProfile, ProfileStoreError, resolveProfileDir, updateLastUsedAt } from "./profile-store";
import { SessionError } from "./session-errors";

const CLOSE_TIMEOUT_MS = 8_000;
const SHUTDOWN_TIMEOUT_MS = 8_000;

const ACTIVE_STATUSES = new Set<SessionStatus>(["starting", "ready", "busy", "closing"]);

export type ChromeExecutableSource = {
  getState(): ChromeInstallerState;
  getExecutablePath(): string | null;
};

export type SessionManagerOptions = {
  readonly appDataDir: string;
  readonly chromeInstaller: ChromeExecutableSource;
  readonly launchBrowser?: LaunchBrowser;
  readonly now?: () => Date;
};

export type SessionManager = {
  start(profileId: string): Promise<Session>;
  listActive(): Session[];
  get(sessionId: string): Session | null;
  getContext(sessionId: string): BrowserSessionContext | null;
  getCdpUrl(sessionId: string): string | null;
  getCdpCredentials(sessionId: string): CdpCredentials | null;
  close(sessionId: string): Promise<Session>;
  shutdown(): Promise<void>;
};

type SessionRecord = {
  session: Session;
  context: BrowserSessionContext | null;
  cdpUrl: string | null;
  credentials: CdpCredentials | null;
  startPromise: Promise<Session> | null;
  closePromise: Promise<Session> | null;
  isCloseRequested: boolean;
};

function createSessionId(): string {
  return `s_${randomBytes(8).toString("hex")}`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new Error(`Timed out after ${timeoutMs} ms.`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });
}

class SessionManagerImpl implements SessionManager {
  private readonly appDataDir: string;
  private readonly chromeInstaller: ChromeExecutableSource;
  private readonly launchBrowser: LaunchBrowser;
  private readonly now: () => Date;
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly profileSessions = new Map<string, string>();
  private shutdownPromise: Promise<void> | null = null;

  constructor(options: SessionManagerOptions) {
    this.appDataDir = options.appDataDir;
    this.chromeInstaller = options.chromeInstaller;
    this.launchBrowser = options.launchBrowser ?? launchBrowser;
    this.now = options.now ?? (() => new Date());
  }

  async start(profileId: string): Promise<Session> {
    if (this.profileSessions.has(profileId)) {
      throw new SessionError("session_conflict");
    }

    const id = createSessionId();
    const record: SessionRecord = {
      session: {
        id,
        profileId,
        status: "starting",
        startedAt: this.now().toISOString(),
        endedAt: null,
        pid: null,
      },
      context: null,
      cdpUrl: null,
      credentials: null,
      startPromise: null,
      closePromise: null,
      isCloseRequested: false,
    };

    this.sessions.set(id, record);
    this.profileSessions.set(profileId, id);

    const task = this.runStart(record);
    record.startPromise = task;
    return task;
  }

  listActive(): Session[] {
    return [...this.sessions.values()]
      .filter((record) => ACTIVE_STATUSES.has(record.session.status))
      .map((record) => ({ ...record.session }));
  }

  get(sessionId: string): Session | null {
    const record = this.sessions.get(sessionId);
    return record === undefined ? null : { ...record.session };
  }

  getContext(sessionId: string): BrowserSessionContext | null {
    const record = this.sessions.get(sessionId);
    if (record === undefined || record.session.status !== "ready" || record.context === null) {
      return null;
    }
    return record.context;
  }

  getCdpUrl(sessionId: string): string | null {
    const record = this.sessions.get(sessionId);
    if (record === undefined || record.session.status !== "ready") {
      return null;
    }
    return record.cdpUrl;
  }

  getCdpCredentials(sessionId: string): CdpCredentials | null {
    const record = this.sessions.get(sessionId);
    if (
      record === undefined ||
      record.session.status !== "ready" ||
      record.credentials === null
    ) {
      return null;
    }
    return { ...record.credentials };
  }

  async close(sessionId: string): Promise<Session> {
    const record = this.sessions.get(sessionId);
    if (record === undefined) {
      throw new SessionError("session_not_found");
    }

    let task = record.closePromise;
    if (task === null) {
      const started = this.runClose(record);
      record.closePromise = started;
      void started.catch(() => {
        if (record.closePromise === started) {
          record.closePromise = null;
        }
      });
      task = started;
    }
    return task;
  }

  async shutdown(): Promise<void> {
    this.shutdownPromise ??= this.runShutdown();
    return this.shutdownPromise;
  }

  private async runStart(record: SessionRecord): Promise<Session> {
    let context: BrowserSessionContext | null = null;
    try {
      await this.requireProfile(record.session.profileId);
      const executablePath = this.requireExecutablePath();

      const launched = await this.launchBrowser({
        executablePath,
        userDataDir: resolveProfileDir(this.appDataDir, record.session.profileId),
        profileId: record.session.profileId,
      });

      context = launched.context;
      record.context = launched.context;
      record.cdpUrl = launched.cdpUrl;
      record.credentials = launched.credentials;
      context.on("close", () => this.handleContextClose(record));
      record.session = { ...record.session, status: "ready" };

      await this.touchProfile(record.session.profileId);
      return { ...record.session };
    } catch (error) {
      if (context !== null) {
        await context.close().catch(() => undefined);
      }
      throw this.failStart(record, error);
    }
  }

  private async runClose(record: SessionRecord): Promise<Session> {
    if (record.startPromise !== null) {
      await record.startPromise.catch(() => undefined);
    }

    record.cdpUrl = null;
    record.credentials = null;

    if (record.session.status === "closed" || record.session.status === "error") {
      return { ...record.session };
    }

    record.session = { ...record.session, status: "closing" };
    record.isCloseRequested = true;

    try {
      if (record.context !== null) {
        await withTimeout(record.context.close(), CLOSE_TIMEOUT_MS);
      }
    } catch (error) {
      console.warn(
        `Session close failed: ${record.session.id}: ${error instanceof Error ? error.name : "unknown"}`,
      );
      throw new SessionError("session_close_failed");
    }

    record.context = null;
    record.session = { ...record.session, status: "closed", endedAt: this.now().toISOString() };
    this.releaseProfile(record.session.profileId, record.session.id);
    return { ...record.session };
  }

  private async runShutdown(): Promise<void> {
    const closes = [...this.sessions.values()]
      .filter((record) => ACTIVE_STATUSES.has(record.session.status))
      .map((record) =>
        this.close(record.session.id).catch((error: unknown) => {
          console.warn(
            `Session shutdown close failed: ${record.session.id}: ${
              error instanceof SessionError ? error.code : "unknown"
            }`,
          );
        }),
      );

    try {
      await withTimeout(Promise.all(closes), SHUTDOWN_TIMEOUT_MS);
    } catch {
      console.warn(`Session shutdown timed out after ${SHUTDOWN_TIMEOUT_MS} ms.`);
    }
  }

  private async requireProfile(profileId: string): Promise<void> {
    try {
      await getProfile(this.appDataDir, profileId);
    } catch (error) {
      if (error instanceof ProfileStoreError) {
        if (error.code === "profile_not_found") {
          throw new SessionError("session_profile_not_found");
        }
        if (error.code === "corrupt_profile_metadata") {
          throw new SessionError("session_profile_corrupt");
        }
      }
      throw error;
    }
  }

  private requireExecutablePath(): string {
    const executablePath = this.chromeInstaller.getExecutablePath();
    if (this.chromeInstaller.getState().status !== "ready" || executablePath === null) {
      throw new SessionError("session_chrome_not_ready");
    }
    return executablePath;
  }

  private async touchProfile(profileId: string): Promise<void> {
    try {
      await updateLastUsedAt(this.appDataDir, profileId, this.now());
    } catch {
      console.warn(`Session profile metadata update failed: ${profileId}`);
    }
  }

  private failStart(record: SessionRecord, error: unknown): SessionError {
    record.cdpUrl = null;
    record.credentials = null;

    if (record.session.status === "starting") {
      record.session = {
        ...record.session,
        status: "error",
        endedAt: this.now().toISOString(),
      };
    }

    this.releaseProfile(record.session.profileId, record.session.id);
    const failure = error instanceof SessionError ? error : new SessionError("session_launch_failed");
    console.warn(
      `Session start failed: ${record.session.id} (${record.session.profileId}): ${failure.code}`,
    );
    return failure;
  }

  private handleContextClose(record: SessionRecord): void {
    record.context = null;
    record.cdpUrl = null;
    record.credentials = null;

    if (
      record.isCloseRequested ||
      record.session.status === "closed" ||
      record.session.status === "error"
    ) {
      return;
    }

    record.session = { ...record.session, status: "closed", endedAt: this.now().toISOString() };
    this.releaseProfile(record.session.profileId, record.session.id);
    console.warn(
      `Session closed unexpectedly: ${record.session.id} (${record.session.profileId})`,
    );
  }

  private releaseProfile(profileId: string, sessionId: string): void {
    if (this.profileSessions.get(profileId) === sessionId) {
      this.profileSessions.delete(profileId);
    }
  }
}

export function createSessionManager(options: SessionManagerOptions): SessionManager {
  return new SessionManagerImpl(options);
}
