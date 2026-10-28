import { useEffect, useRef, useState } from "react";
import type { ChromeInstallerState } from "../shared/chrome-installer";
import type { ArgusRuntime } from "./api-runtime";
import { isAbortError, toDisplayError } from "./cockpit-state";
import { BrowserSetupPanel, type BrowserAction } from "./BrowserSetupPanel";

const BROWSER_ACTIVE_POLL_INTERVAL_MS = 1000;
const BROWSER_RETRY_INTERVAL_MS = 2000;
const BROWSER_DOWNLOAD_START_WATCH_MS = 10000;
const BROWSER_READ_TIMEOUT_MS = 2000;
const BROWSER_DOWNLOAD_TIMEOUT_MS = 5000;
const LOCAL_EXECUTABLE_SET_TIMEOUT_MS = 10000;
const LOCAL_EXECUTABLE_CLEAR_TIMEOUT_MS = 5000;

const ACTIVE_BROWSER_STATUSES = new Set<ChromeInstallerState["status"]>([
  "absent",
  "downloading",
  "verifying",
  "extracting",
]);

type BrowserRequest = (
  runtime: ArgusRuntime,
) => Promise<ChromeInstallerState | null>;

export function BrowserSetupSection({
  runtime,
}: {
  readonly runtime: ArgusRuntime;
}) {
  const [browserState, setBrowserState] =
    useState<ChromeInstallerState | null>(null);
  const [isBrowserCheckFailed, setIsBrowserCheckFailed] = useState(false);
  const [pendingAction, setPendingAction] = useState<BrowserAction | null>(
    null,
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [localPath, setLocalPath] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const pendingActionRef = useRef(false);
  const downloadWatchDeadlineRef = useRef(0);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let isActive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = (delay: number): void => {
      timer = setTimeout(() => {
        void check();
      }, delay);
    };

    const check = async (): Promise<void> => {
      try {
        const state = await runtime.run(BROWSER_READ_TIMEOUT_MS, (client) =>
          client.browser.get(),
        );

        if (!isActive || !isMountedRef.current) {
          return;
        }

        setBrowserState(state);
        setIsBrowserCheckFailed(false);

        const isWaitingForDownloadStart =
          state.status === "error" &&
          Date.now() < downloadWatchDeadlineRef.current;

        if (isWaitingForDownloadStart) {
          schedule(BROWSER_ACTIVE_POLL_INTERVAL_MS);
        } else {
          downloadWatchDeadlineRef.current = 0;
          if (ACTIVE_BROWSER_STATUSES.has(state.status)) {
            schedule(BROWSER_ACTIVE_POLL_INTERVAL_MS);
          }
        }
      } catch (error: unknown) {
        if (!isActive || !isMountedRef.current || isAbortError(error)) {
          return;
        }

        console.error("Browser state check failed:", error);
        setIsBrowserCheckFailed(true);
        schedule(BROWSER_RETRY_INTERVAL_MS);
      }
    };

    void check();

    return () => {
      isActive = false;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }, [runtime, refreshKey]);

  const runBrowserAction = async (
    action: BrowserAction,
    send: BrowserRequest,
  ): Promise<void> => {
    if (pendingActionRef.current) {
      return;
    }

    if (action === "download") {
      downloadWatchDeadlineRef.current =
        Date.now() + BROWSER_DOWNLOAD_START_WATCH_MS;
    }

    pendingActionRef.current = true;
    setPendingAction(action);
    setActionError(null);

    try {
      const nextState = await send(runtime);
      if (nextState !== null && isMountedRef.current) {
        setBrowserState(nextState);
      }
    } catch (error: unknown) {
      if (!isAbortError(error) && isMountedRef.current) {
        console.error(`Browser action failed: ${action}`, error);
        setActionError(toDisplayError(error));
      }
    } finally {
      pendingActionRef.current = false;
      if (isMountedRef.current) {
        setPendingAction(null);
        setRefreshKey((key) => key + 1);
      }
    }
  };

  if (browserState === null && !isBrowserCheckFailed) {
    return null;
  }

  return (
    <BrowserSetupPanel
      state={browserState}
      isBusy={pendingAction !== null}
      pendingAction={pendingAction}
      checkFailed={isBrowserCheckFailed}
      actionError={actionError}
      localPath={localPath}
      onLocalPathChange={setLocalPath}
      onDownload={() =>
        void runBrowserAction("download", (activeRuntime) =>
          activeRuntime.run(BROWSER_DOWNLOAD_TIMEOUT_MS, (client) =>
            client.browser.download(),
          ),
        )
      }
      onUseLocal={() =>
        void runBrowserAction("local", (activeRuntime) =>
          activeRuntime.run(LOCAL_EXECUTABLE_SET_TIMEOUT_MS, (client) =>
            client.browser.setLocalExecutable(localPath.trim()),
          ),
        )
      }
      onClearLocal={() =>
        void runBrowserAction("clear", async (activeRuntime) => {
          await activeRuntime.run(
            LOCAL_EXECUTABLE_CLEAR_TIMEOUT_MS,
            (client) => client.browser.clearLocalExecutable(),
          );
          return null;
        })
      }
    />
  );
}
