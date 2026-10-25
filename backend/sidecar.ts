import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { resolveAppDataDir, writeApiCredentials } from "./app-data";

async function main(): Promise<void> {
  const appDataDir = resolveAppDataDir();
  const token = randomBytes(32).toString("base64url");
  const allowedOrigin = process.env.ARGUS_UI_ORIGIN ?? "null";

  const server = serve({
    fetch: createApp({ token, allowedOrigin }).fetch,
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
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.on("disconnect", shutdown);

  process.send?.({ type: "ready" });
}

void main().catch((error: unknown) => {
  console.error("Sidecar failed:", error);
  process.exit(1);
});
