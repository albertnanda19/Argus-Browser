import { useEffect, useState } from "react";
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

  useEffect(() => {
    let isActive = true;

    const check = async (): Promise<void> => {
      try {
        const apiInfo = await window.argus.getApiInfo();

        if (!apiInfo) {
          if (isActive) {
            setStatus("failed");
          }
          return;
        }

        await fetchHealth(apiInfo);

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

  return (
    <main className="shell">
      <h1 className="title">Argus</h1>
      <p className="subtitle">Browser yang dikendalikan AI</p>
      <div className="status" data-status={status} role="status" aria-live="polite">
        <span className="dot" aria-hidden="true" />
        <span>{statusLabels[status]}</span>
      </div>
    </main>
  );
}
