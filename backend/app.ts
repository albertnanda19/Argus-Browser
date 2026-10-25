import { Hono } from "hono";
import { healthResponseSchema, problemSchema } from "../shared/contracts";
import { isAuthorized } from "./auth";

type AppOptions = {
  token: string;
  allowedOrigin: string;
};

export function createApp({ token, allowedOrigin }: AppOptions): Hono {
  const app = new Hono();
  const unauthorized = problemSchema.parse({
    type: "about:blank",
    title: "Unauthorized",
    status: 401,
    detail: "Token akses tidak valid.",
  });

  app.use("/v1/*", async (c, next) => {
    const origin = c.req.header("Origin");

    if (origin !== undefined && origin === allowedOrigin) {
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Access-Control-Allow-Methods", "GET, OPTIONS");
      c.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
      c.header("Access-Control-Max-Age", "600");
      c.header("Vary", "Origin");
    }

    if (c.req.method === "OPTIONS") {
      return c.body(null, 204);
    }

    await next();
  });

  app.use("/v1/*", async (c, next) => {
    if (!isAuthorized(c.req.header("Authorization"), token)) {
      return c.body(JSON.stringify(unauthorized), 401, {
        "Content-Type": "application/problem+json",
      });
    }

    await next();
  });

  app.get("/v1/health", (c) => {
    const body = healthResponseSchema.parse({ data: { ok: true } });
    return c.json(body, 200);
  });

  return app;
}
