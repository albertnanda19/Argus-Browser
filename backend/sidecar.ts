import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { serve } from "@hono/node-server";
import { createActionManager } from "./action-manager";
import { createAgentStepStore } from "./agent-steps";
import {
  createApp,
  type ProfilePolicyService,
  type ProfileService,
  type SessionService,
} from "./app";
import { resolveAppDataDir, writeApiCredentials } from "./app-data";
import { createChromeInstaller } from "./chrome-installer";
import { ChromeFailure } from "./chrome-errors";
import { createEventBus } from "./event-bus";
import { createEventStreamRegistry } from "./event-stream";
import {
  createProfile,
  deleteProfile,
  getProfilePolicy,
  listProfiles,
  setProfilePolicy,
} from "./profile-store";
import { createProviderRegistry } from "./provider-registry";
import { createProviderService } from "./provider-service";
import { createSessionManager } from "./session-manager";
import { createTaskManager } from "./task-manager";
import { createTaskRunner } from "./task-runner";

const SHUTDOWN_TIMEOUT_MS = 9_000;

async function main(): Promise<void> {
  const appDataDir = resolveAppDataDir();
  const token = randomBytes(32).toString("base64url");
  const allowedOrigin = process.env.ARGUS_UI_ORIGIN ?? "null";

  const chromeInstaller = createChromeInstaller({
    appDataDir,
    onStateChange: (state) => {
      if (state.status === "error") {
        console.error(`Chrome installer error: ${state.error.code}`);
      }
    },
  });
  await chromeInstaller.initialize();

  const sessionManager = createSessionManager({ appDataDir, chromeInstaller });
  const events = createEventBus();
  const eventConnections = createEventStreamRegistry();
  const tasks = createTaskManager({ sessions: sessionManager, events });
  const actions = createActionManager({ sessions: sessionManager, tasks, events });
  const registry = createProviderRegistry();
  const providers = await createProviderService({
    appDataDir,
    registry,
  });
  const steps = createAgentStepStore();
  const profiles: ProfileService = {
    list: () => listProfiles(appDataDir),
    create: (name) => createProfile(appDataDir, name),
    delete: (profileId) => deleteProfile(appDataDir, profileId),
  };
  const profilePolicies: ProfilePolicyService = {
    get: (profileId) => getProfilePolicy(appDataDir, profileId),
    set: (profileId, policy) => setProfilePolicy(appDataDir, profileId, policy),
  };
  const runner = createTaskRunner({
    sessions: sessionManager,
    tasks,
    providers,
    registry,
    steps,
    events,
    profilePolicies,
  });

  const sessions: SessionService = sessionManager;

  const server = serve({
    fetch: createApp({
      token,
      allowedOrigin,
      chromeInstaller,
      profiles,
      profilePolicies,
      sessions,
      tasks,
      steps: { listByTask: (taskId) => steps.list(taskId) },
      runner,
      actions,
      events,
      eventConnections,
      providers,
    }).fetch,
    hostname: "127.0.0.1",
    port: 0,
  });

  await once(server, "listening");

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Sidecar did not bind a TCP port.");
  }

  await writeApiCredentials(appDataDir, { port: address.port, token });

  let isShuttingDown = false;
  const shutdown = (): void => {
    if (isShuttingDown) {
      return;
    }
    isShuttingDown = true;

    const forceExit = setTimeout(() => process.exit(0), SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();
    server.close();
    eventConnections.shutdown();

    const stop = async (): Promise<void> => {
      await runner.shutdown().catch((error: unknown) => {
        console.warn(
          `Task runner shutdown failed: ${error instanceof Error ? error.name : "unknown"}`,
        );
      });
      await sessionManager.shutdown().catch((error: unknown) => {
        console.warn(
          `Session shutdown failed: ${error instanceof Error ? error.name : "unknown"}`,
        );
      });
      await chromeInstaller.shutdown().catch((error: unknown) => {
        console.warn(
          `Chrome shutdown failed: ${error instanceof Error ? error.name : "unknown"}`,
        );
      });
    };

    void stop().then(
      () => {
        clearTimeout(forceExit);
        process.exit(0);
      },
      () => {
        clearTimeout(forceExit);
        process.exit(0);
      },
    );
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.on("disconnect", shutdown);

  process.send?.({ type: "ready" });

  if (chromeInstaller.getState().status === "absent") {
    void chromeInstaller.start().catch((error: unknown) => {
      console.error(
        `Chrome auto-download failed: ${error instanceof ChromeFailure ? error.code : "unknown"}`,
      );
    });
  }
}

void main().catch((error: unknown) => {
  console.error("Sidecar failed:", error);
  process.exit(1);
});
