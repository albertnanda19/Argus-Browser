import { useEffect, useRef, useState } from "react";
import type { ApiInfo, SidecarState } from "../shared/contracts";
import { createArgusRuntime, type ArgusRuntime } from "./api-runtime";
import { Cockpit } from "./Cockpit";
import { isAbortError } from "./cockpit-state";
import { texts } from "./texts";

type ConnectionStatus = "connecting" | "connected" | "failed";

const SUPERVISOR_POLL_INTERVAL_MS = 5000;
const HEALTH_POLL_INTERVAL_MS = 5000;
const HEALTH_TIMEOUT_MS = 2000;

export function App() {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [supervisorStatus, setSupervisorStatus] =
    useState<SidecarState["status"]>("starting");
  const [apiInfo, setApiInfo] = useState<ApiInfo | null>(null);
  const [runtime, setRuntime] = useState<ArgusRuntime | null>(null);
  const apiInfoRef = useRef<ApiInfo | null>(null);

  useEffect(() => {
    if (apiInfo === null) {
      setRuntime(null);
      return;
    }

    const next = createArgusRuntime(apiInfo);
    setRuntime(next);

    return () => {
      next.dispose();
    };
  }, [apiInfo]);

  useEffect(() => {
    if (runtime === null) {
      return;
    }

    let isActive = true;
    setStatus("connecting");

    const check = async (): Promise<void> => {
      try {
        await runtime.run(HEALTH_TIMEOUT_MS, (client) => client.health());

        if (isActive) {
          setStatus("connected");
        }
      } catch (error: unknown) {
        if (!isActive || isAbortError(error)) {
          return;
        }

        console.error("Health check failed:", error);
        setStatus("failed");
      }
    };

    void check();
    const interval = setInterval(() => {
      void check();
    }, HEALTH_POLL_INTERVAL_MS);

    return () => {
      isActive = false;
      clearInterval(interval);
    };
  }, [runtime]);

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
          apiInfoRef.current = null;
          setStatus("connecting");
          setApiInfo(null);
          return;
        }

        if (state.status === "error") {
          apiInfoRef.current = null;
          setStatus("failed");
          setApiInfo(null);
          return;
        }

        const current = apiInfoRef.current;

        if (
          current === null ||
          current.baseUrl !== state.apiInfo.baseUrl ||
          current.token !== state.apiInfo.token
        ) {
          apiInfoRef.current = state.apiInfo;
          setStatus("connecting");
          setApiInfo(state.apiInfo);
        }
      } catch (error: unknown) {
        console.error("Sidecar state check failed:", error);

        if (isActive) {
          apiInfoRef.current = null;
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

  const handleRestart = async (): Promise<void> => {
    apiInfoRef.current = null;
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

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-brand">
          <h1 className="title">{texts.app.title}</h1>
          <p className="subtitle">{texts.app.subtitle}</p>
        </div>
        <div className="header-actions">
          <div
            className="status"
            data-status={status}
            role="status"
            aria-live="polite"
          >
            <span className="dot" aria-hidden="true" />
            <span>{texts.connection[status]}</span>
          </div>
          {status === "failed" && supervisorStatus === "error" ? (
            <button
              className="button"
              type="button"
              onClick={() => void handleRestart()}
            >
              {texts.restart}
            </button>
          ) : null}
        </div>
      </header>

      <Cockpit
        key={runtime?.id ?? "offline"}
        runtime={runtime}
        isConnected={status === "connected"}
      />
    </div>
  );
}
