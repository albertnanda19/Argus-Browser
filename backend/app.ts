import { Hono, type Context } from "hono";
import type { ZodType } from "zod";
import {
  browserStateResponseSchema,
  createProfileRequestSchema,
  createSessionRequestSchema,
  localExecutableRequestSchema,
  paginationQuerySchema,
  profileListResponseSchema,
  profileResponseSchema,
  sessionListResponseSchema,
  sessionResponseSchema,
  type PaginationQuery,
} from "../shared/api";
import type { ChromeInstallerState } from "../shared/chrome-installer";
import { healthResponseSchema } from "../shared/contracts";
import { profileIdSchema, type Profile } from "../shared/profile";
import { sessionIdSchema, type Session } from "../shared/session";
import type { ChromeLocalValidation } from "./chrome-local-binary";
import { ChromeFailure } from "./chrome-errors";
import { isAuthorized } from "./auth";
import { handleKnownError, INTERNAL_ERROR_DETAIL, problemResponse } from "./api-problem";
import { createProfileLock } from "./profile-lock";

const ACTIVE_INSTALL_STATUSES = new Set<ChromeInstallerState["status"]>([
  "downloading",
  "verifying",
  "extracting",
]);

const ACTIVE_SESSION_DETAIL = "Profil ini masih memiliki sesi aktif.";

export type ChromeInstallerApi = {
  getState(): ChromeInstallerState;
  start(): Promise<ChromeInstallerState>;
  setLocalBinary(inputPath: string): Promise<ChromeLocalValidation>;
  clearLocalBinary(): Promise<ChromeInstallerState>;
};

export type ProfileService = {
  list(): Promise<Profile[]>;
  create(name: string): Promise<Profile>;
  delete(profileId: string): Promise<void>;
};

export type SessionService = {
  start(profileId: string): Promise<Session>;
  listActive(): Session[];
  get(sessionId: string): Session | null;
  close(sessionId: string): Promise<Session>;
};

export type AppOptions = {
  readonly token: string;
  readonly allowedOrigin: string;
  readonly chromeInstaller: ChromeInstallerApi;
  readonly profiles: ProfileService;
  readonly sessions: SessionService;
};

type ParsedBody<T> = { readonly ok: true; readonly data: T } | { readonly ok: false };

async function parseJsonBody<T>(c: Context, schema: ZodType<T>): Promise<ParsedBody<T>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { ok: false };
  }

  const parsed = schema.safeParse(body);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false };
}

function parsePagination(c: Context): PaginationQuery | null {
  const raw: Record<string, string> = {};
  const page = c.req.query("page");
  const pageSize = c.req.query("page_size");

  if (page !== undefined) {
    raw.page = page;
  }
  if (pageSize !== undefined) {
    raw.page_size = pageSize;
  }

  const parsed = paginationQuerySchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function paginate<T>(items: readonly T[], page: number, pageSize: number) {
  const start = (page - 1) * pageSize;
  return {
    data: items.slice(start, start + pageSize),
    total: items.length,
    page,
    page_size: pageSize,
  };
}

export function createApp(options: AppOptions): Hono {
  const app = new Hono();
  const profileLock = createProfileLock();

  app.use("/v1/*", async (c, next) => {
    const origin = c.req.header("Origin");

    if (origin !== undefined && origin === options.allowedOrigin) {
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
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
    if (!isAuthorized(c.req.header("Authorization"), options.token)) {
      return problemResponse(c, 401, "Token akses tidak valid.");
    }

    await next();
  });

  app.get("/v1/health", (c) => {
    const state = options.chromeInstaller.getState();
    const body = healthResponseSchema.parse({
      data: {
        ok: state.status === "ready",
        chrome: { status: state.status, version: state.version },
      },
    });
    return c.json(body, 200);
  });

  app.get("/v1/browser", (c) => {
    const body = browserStateResponseSchema.parse({
      data: options.chromeInstaller.getState(),
    });
    return c.json(body, 200);
  });

  app.post("/v1/browser/download", (c) => {
    const state = options.chromeInstaller.getState();

    if (state.status !== "ready" && !ACTIVE_INSTALL_STATUSES.has(state.status)) {
      void options.chromeInstaller.start().catch((error: unknown) => {
        console.error(
          `Chrome download failed: ${error instanceof ChromeFailure ? error.code : "unknown"}`,
        );
      });
    }

    const body = browserStateResponseSchema.parse({ data: state });
    return c.json(body, 202);
  });

  app.put("/v1/browser/local-executable", async (c) => {
    const body = await parseJsonBody(c, localExecutableRequestSchema);
    if (!body.ok) {
      return problemResponse(c, 400, "Body permintaan tidak valid.");
    }

    try {
      const result = await options.chromeInstaller.setLocalBinary(body.data.path);
      if (!result.ok) {
        return problemResponse(c, 422, result.error.message);
      }
      const response = browserStateResponseSchema.parse({
        data: options.chromeInstaller.getState(),
      });
      return c.json(response, 200);
    } catch (error) {
      return handleKnownError(c, error);
    }
  });

  app.delete("/v1/browser/local-executable", async (c) => {
    try {
      await options.chromeInstaller.clearLocalBinary();
      return c.body(null, 204);
    } catch (error) {
      return handleKnownError(c, error);
    }
  });

  app.get("/v1/profiles", async (c) => {
    const pagination = parsePagination(c);
    if (pagination === null) {
      return problemResponse(c, 400, "Parameter pagination tidak valid.");
    }

    try {
      const items = await options.profiles.list();
      const body = profileListResponseSchema.parse(
        paginate(items, pagination.page, pagination.page_size),
      );
      return c.json(body, 200);
    } catch (error) {
      return handleKnownError(c, error);
    }
  });

  app.post("/v1/profiles", async (c) => {
    const body = await parseJsonBody(c, createProfileRequestSchema);
    if (!body.ok) {
      return problemResponse(c, 400, "Body permintaan tidak valid.");
    }

    try {
      const profile = await options.profiles.create(body.data.name);
      return c.json(profileResponseSchema.parse({ data: profile }), 201);
    } catch (error) {
      return handleKnownError(c, error);
    }
  });

  app.delete("/v1/profiles/:id", async (c) => {
    const parsedId = profileIdSchema.safeParse(c.req.param("id"));
    if (!parsedId.success) {
      return problemResponse(c, 400, "Id profil tidak valid.");
    }

    try {
      const outcome = await profileLock.run(parsedId.data, async () => {
        const hasActiveSession = options.sessions
          .listActive()
          .some((session) => session.profileId === parsedId.data);

        if (hasActiveSession) {
          return "active";
        }

        await options.profiles.delete(parsedId.data);
        return "deleted";
      });

      if (outcome === "active") {
        return problemResponse(c, 409, ACTIVE_SESSION_DETAIL);
      }

      return c.body(null, 204);
    } catch (error) {
      return handleKnownError(c, error);
    }
  });

  app.post("/v1/sessions", async (c) => {
    const body = await parseJsonBody(c, createSessionRequestSchema);
    if (!body.ok) {
      return problemResponse(c, 400, "Body permintaan tidak valid.");
    }

    try {
      const session = await profileLock.run(body.data.profileId, () =>
        options.sessions.start(body.data.profileId),
      );
      return c.json(sessionResponseSchema.parse({ data: session }), 201);
    } catch (error) {
      return handleKnownError(c, error);
    }
  });

  app.get("/v1/sessions", (c) => {
    const pagination = parsePagination(c);
    if (pagination === null) {
      return problemResponse(c, 400, "Parameter pagination tidak valid.");
    }

    const body = sessionListResponseSchema.parse(
      paginate(options.sessions.listActive(), pagination.page, pagination.page_size),
    );
    return c.json(body, 200);
  });

  app.get("/v1/sessions/:id", (c) => {
    const parsedId = sessionIdSchema.safeParse(c.req.param("id"));
    if (!parsedId.success) {
      return problemResponse(c, 400, "Id sesi tidak valid.");
    }

    const session = options.sessions.get(parsedId.data);
    if (session === null) {
      return problemResponse(c, 404, "Sesi tidak ditemukan.");
    }

    return c.json(sessionResponseSchema.parse({ data: session }), 200);
  });

  app.delete("/v1/sessions/:id", async (c) => {
    const parsedId = sessionIdSchema.safeParse(c.req.param("id"));
    if (!parsedId.success) {
      return problemResponse(c, 400, "Id sesi tidak valid.");
    }

    try {
      await options.sessions.close(parsedId.data);
      return c.body(null, 204);
    } catch (error) {
      return handleKnownError(c, error);
    }
  });

  app.notFound((c) => problemResponse(c, 404, "Endpoint tidak ditemukan."));

  app.onError((error, c) => {
    console.error(
      `Unhandled API error: ${c.req.method} ${c.req.path} (${
        error instanceof Error ? error.name : "unknown"
      })`,
    );
    return problemResponse(c, 500, INTERNAL_ERROR_DETAIL);
  });

  return app;
}
