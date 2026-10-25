import { useEffect, useState } from "react";
import type { SidecarState } from "../shared/contracts";
import { fetchHealth } from "./api";

type ConnectionStatus = "connecting" | "connected" | "failed";

const statusLabels: Record<ConnectionStatus, string> = {
  connecting: "Menghubungkan…",
  connected: "Terhubung",
  failed: "Gagal terhubung",
};

const POLL_INTERVAL_MS = 5000;

export function App() {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [supervisorStatus, setSupervisorStatus] = useState<SidecarState["status"]>("starting");

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
          return;
        }

        if (state.status === "error") {
          setStatus("failed");
          return;
        }

        await fetchHealth(state.apiInfo);

        if (isActive) {
          setStatus("connected");
        }
      } catch (error: unknown) {
        console.error("Health check failed:", error);
        if (isActive) {
          setStatus("failed");
        }
      }
    };

    void check();
    const interval = setInterval(() => {
      void check();
    }, POLL_INTERVAL_MS);

    return () => {
      isActive = false;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    console.log(`connection status: ${statusLabels[status]}`);
  }, [status]);

  const handleRestart = async (): Promise<void> => {
    setStatus("connecting");
    setSupervisorStatus("starting");

    try {
      await window.argus.restartSidecar();
    } catch (error: unknown) {
      console.error("Manual sidecar restart failed:", error);
      setStatus("failed");
    }
  };

  return (
    <main className="shell">
      <h1 className="title">Argus</h1>
      <p className="subtitle">Browser yang dikendalikan AI</p>
      <div className="status" data-status={status} role="status" aria-live="polite">
        <span className="dot" aria-hidden="true" />
        <span>{statusLabels[status]}</span>
      </div>
      {status === "failed" && supervisorStatus === "error" ? (
        <button className="restart" type="button" onClick={() => void handleRestart()}>
          Mulai ulang layanan
        </button>
      ) : null}
    </main>
  );
}
