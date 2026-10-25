import { useEffect, useRef, useState } from "react";
import type { ChromeInstallerState } from "../shared/chrome-installer";
import type { ApiInfo, SidecarState } from "../shared/contracts";
import {
  BrowserApiError,
  clearLocalExecutable,
  fetchBrowserState,
  fetchHealth,
  setLocalExecutable,
  startBrowserDownload,
} from "./api";
import { BrowserSetupPanel, type BrowserAction } from "./BrowserSetupPanel";
import { texts } from "./texts";

type ConnectionStatus = "connecting" | "connected" | "failed";

type BrowserRequest = (
  apiInfo: ApiInfo,
  signal?: AbortSignal,
) => Promise<ChromeInstallerState | null>;

const SUPERVISOR_POLL_INTERVAL_MS = 5000;
const BROWSER_ACTIVE_POLL_INTERVAL_MS = 1000;
const BROWSER_RETRY_INTERVAL_MS = 2000;
const BROWSER_DOWNLOAD_START_WATCH_MS = 10000;

const ACTIVE_BROWSER_STATUSES = new Set<ChromeInstallerState["status"]>([
  "absent",
  "downloading",
  "verifying",
  "extracting",
]);

function toDisplayError(error: unknown): string {
  return error instanceof BrowserApiError ? error.message : texts.api.generic;
}

export function App() {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [supervisorStatus, setSupervisorStatus] = useState<SidecarState["status"]>("starting");
  const [apiInfo, setApiInfo] = useState<ApiInfo | null>(null);
  const [browserState, setBrowserState] = useState<ChromeInstallerState | null>(null);
  const [isBrowserCheckFailed, setIsBrowserCheckFailed] = useState(false);
  const [pendingAction, setPendingAction] = useState<BrowserAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [localPath, setLocalPath] = useState("");
  const [browserRefreshKey, setBrowserRefreshKey] = useState(0);
  const pendingActionRef = useRef(false);
  const browserAbortControllerRef = useRef<AbortController | null>(null);
  const downloadWatchDeadlineRef = useRef(0);

  useEffect(() => {
    let isActive = true;

    const check = async (): Promise<void> => {
      try {
        const state = await window.argus.getSidecarState();

        if (!isActive) {
          return;
        }

        setSupervisorStatus(state.status);

        if (state.status === "starting") {
          setStatus("connecting");
          setApiInfo(null);
          return;
        }

        if (state.status === "error") {
          setStatus("failed");
          setApiInfo(null);
          return;
        }

        await fetchHealth(state.apiInfo);

        if (isActive) {
          setStatus("connected");
          setApiInfo((current) =>
            current !== null &&
            current.baseUrl === state.apiInfo.baseUrl &&
            current.token === state.apiInfo.token
              ? current
              : state.apiInfo,
          );
        }
      } catch (error: unknown) {
        console.error("Health check failed:", error);
        if (isActive) {
          setStatus("failed");
          setApiInfo(null);
        }
      }
    };

    void check();
    const interval = setInterval(() => {
      void check();
    }, SUPERVISOR_POLL_INTERVAL_MS);

    return () => {
      isActive = false;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (apiInfo === null) {
      setBrowserState(null);
      setIsBrowserCheckFailed(false);
      return;
    }

    const controller = new AbortController();
    browserAbortControllerRef.current = controller;
    let isActive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = (delay: number): void => {
      timer = setTimeout(() => {
        void check();
      }, delay);
    };

    const check = async (): Promise<void> => {
      try {
        const state = await fetchBrowserState(apiInfo, controller.signal);

        if (!isActive) {
          return;
        }

        setBrowserState(state);
        setIsBrowserCheckFailed(false);

        const isWaitingForDownloadStart =
          state.status === "error" && Date.now() < downloadWatchDeadlineRef.current;

        if (isWaitingForDownloadStart) {
          schedule(BROWSER_ACTIVE_POLL_INTERVAL_MS);
        } else {
          downloadWatchDeadlineRef.current = 0;
          if (ACTIVE_BROWSER_STATUSES.has(state.status)) {
            schedule(BROWSER_ACTIVE_POLL_INTERVAL_MS);
          }
        }
      } catch (error: unknown) {
        if (!isActive) {
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
      controller.abort();
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (browserAbortControllerRef.current === controller) {
        browserAbortControllerRef.current = null;
      }
    };
  }, [apiInfo, browserRefreshKey]);

  useEffect(() => {
    setActionError(null);
    downloadWatchDeadlineRef.current = 0;
  }, [apiInfo]);

  const runBrowserAction = async (
    action: BrowserAction,
    send: BrowserRequest,
  ): Promise<void> => {
    if (apiInfo === null || pendingActionRef.current) {
      return;
    }

    if (action === "download") {
      downloadWatchDeadlineRef.current = Date.now() + BROWSER_DOWNLOAD_START_WATCH_MS;
    }

    pendingActionRef.current = true;
    setPendingAction(action);
    setActionError(null);

    try {
      const nextState = await send(apiInfo, browserAbortControllerRef.current?.signal);
      if (nextState !== null) {
        setBrowserState(nextState);
      }
    } catch (error: unknown) {
      console.error(`Browser action failed: ${action}`, error);
      setActionError(toDisplayError(error));
    } finally {
      pendingActionRef.current = false;
      setPendingAction(null);
      setBrowserRefreshKey((key) => key + 1);
    }
  };

  const handleRestart = async (): Promise<void> => {
    setStatus("connecting");
    setSupervisorStatus("starting");
    setApiInfo(null);

    try {
      await window.argus.restartSidecar();
    } catch (error: unknown) {
      console.error("Manual sidecar restart failed:", error);
      setStatus("failed");
    }
  };

  const showBrowserPanel =
    status === "connected" && (browserState !== null || isBrowserCheckFailed);

  return (
    <main className="shell">
      <h1 className="title">{texts.app.title}</h1>
      <p className="subtitle">{texts.app.subtitle}</p>
      <div className="status" data-status={status} role="status" aria-live="polite">
        <span className="dot" aria-hidden="true" />
        <span>{texts.connection[status]}</span>
      </div>
      {status === "failed" && supervisorStatus === "error" ? (
        <button className="restart" type="button" onClick={() => void handleRestart()}>
          {texts.restart}
        </button>
      ) : null}
      {showBrowserPanel ? (
        <BrowserSetupPanel
          state={browserState}
          isBusy={pendingAction !== null}
          pendingAction={pendingAction}
          checkFailed={isBrowserCheckFailed}
          actionError={actionError}
          localPath={localPath}
          onLocalPathChange={setLocalPath}
          onDownload={() => void runBrowserAction("download", startBrowserDownload)}
          onUseLocal={() =>
            void runBrowserAction("local", (info, signal) =>
              setLocalExecutable(info, localPath.trim(), signal),
            )
          }
          onClearLocal={() =>
            void runBrowserAction("clear", async (info, signal) => {
              await clearLocalExecutable(info, signal);
              return null;
            })
          }
        />
      ) : null}
    </main>
  );
}
