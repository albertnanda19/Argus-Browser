import { Hono, type Context } from "hono";
import type { ZodType } from "zod";
import { actionRequestSchema, actionResponseSchema } from "../shared/action";
import {
  agentStepListResponseSchema,
  type AgentStep,
} from "../shared/agent-step";
import {
  approvalDecisionRequestSchema,
  approvalListQuerySchema,
  approvalListResponseSchema,
  approvalResponseSchema,
  browserStateResponseSchema,
  createProfileRequestSchema,
  createSessionRequestSchema,
  createTaskRequestSchema,
  idempotencyKeySchema,
  localExecutableRequestSchema,
  paginationQuerySchema,
  profileListResponseSchema,
  profilePolicyResponseSchema,
  profileResponseSchema,
  sessionListResponseSchema,
  sessionResponseSchema,
  taskListQuerySchema,
  taskListResponseSchema,
  taskResponseSchema,
  type PaginationQuery,
} from "../shared/api";
import type { ChromeInstallerState } from "../shared/chrome-installer";
import { healthResponseSchema } from "../shared/contracts";
import { createOpenApiDocument } from "../shared/openapi";
import { profileIdSchema, type Profile } from "../shared/profile";
import { profilePolicySchema, type ProfilePolicy } from "../shared/profile-policy";
import {
  providerConfigRequestSchema,
  providerResponseSchema,
  type ProviderConfig,
  type ProviderConfigRequest,
} from "../shared/provider";
import { sessionIdSchema, type Session } from "../shared/session";
import { taskIdSchema } from "../shared/task";
import type { ChromeLocalValidation } from "./chrome-local-binary";
import { ChromeFailure } from "./chrome-errors";
import { isAuthorized } from "./auth";
import { handleKnownError, INTERNAL_ERROR_DETAIL, problemResponse } from "./api-problem";
import type { ActionService } from "./action-manager";
import type { BrowserSessionContext } from "./browser-launcher";
import type { EventBus } from "./event-bus";
import { createEventStream, type EventStreamRegistry } from "./event-stream";
import { createProfileLock } from "./profile-lock";
import type { TaskService } from "./task-manager";
import { capturePageThumbnail } from "./thumbnail";

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

export type ProfilePolicyService = {
  get(profileId: string): Promise<ProfilePolicy>;
  set(profileId: string, policy: ProfilePolicy): Promise<ProfilePolicy>;
};

export type SessionService = {
  start(profileId: string): Promise<Session>;
  listActive(): Session[];
  get(sessionId: string): Session | null;
  getContext?(sessionId: string): BrowserSessionContext | null;
  close(sessionId: string): Promise<Session>;
};

export type ProviderConfigService = {
  getConfig(): ProviderConfig;
  setConfig(input: ProviderConfigRequest): Promise<ProviderConfig>;
};

export type TaskRunnerApi = {
  start(taskId: string): void;
  cancel(taskId: string): void;
  notifyApprovalDecision?(taskId: string, approve: boolean): void;
};

export type AgentStepService = {
  listByTask(taskId: string): readonly AgentStep[];
};

export type AppOptions = {
  readonly token: string;
  readonly allowedOrigin: string;
  readonly chromeInstaller: ChromeInstallerApi;
  readonly profiles: ProfileService;
  readonly profilePolicies: ProfilePolicyService;
  readonly sessions: SessionService;
  readonly tasks: TaskService;
  readonly steps: AgentStepService;
  readonly runner: TaskRunnerApi;
  readonly actions: ActionService;
  readonly events: EventBus;
  readonly eventConnections: EventStreamRegistry;
  readonly providers: ProviderConfigService;
  readonly eventHeartbeatMs?: number;
};

type ParsedBody<T> = { readonly ok: true; readonly data: T } | { readonly ok: false };

type ParsedIdempotencyKey =
  | { readonly ok: true; readonly key: string }
  | { readonly ok: false; readonly detail: string };

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

function parseIdempotencyKey(c: Context): ParsedIdempotencyKey {
  const raw = c.req.header("Idempotency-Key");
  const parsed = idempotencyKeySchema.safeParse(raw);
  if (parsed.success) {
    return { ok: true, key: parsed.data };
  }
  return {
    ok: false,
    detail:
      raw !== undefined && raw.trim().length > 0
        ? "Idempotency-Key tidak valid."
        : "Idempotency-Key wajib diisi.",
  };
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

function compareTimeThenIdDesc<T extends { readonly id: string }>(
  left: T,
  right: T,
  timeOf: (item: T) => string,
): number {
  const timeOrder = timeOf(right).localeCompare(timeOf(left));
  return timeOrder !== 0 ? timeOrder : right.id.localeCompare(left.id);
}

export function createApp(options: AppOptions): Hono {
  const app = new Hono();
  const openApiDocument = createOpenApiDocument();
  const profileLock = createProfileLock();
  const thumbnailLock = createProfileLock();
  const eventStream = createEventStream({
    events: options.events,
    connections: options.eventConnections,
    heartbeatMs: options.eventHeartbeatMs,
  });

  app.use("/v1/*", async (c, next) => {
    const origin = c.req.header("Origin");

    if (origin !== undefined && origin === options.allowedOrigin) {
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      c.header(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type, Idempotency-Key, Last-Event-ID",
      );
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

  app.get("/v1/openapi.json", (c) => c.json(openApiDocument, 200));

  app.get("/v1/browser", (c) => {
    const body = browserStateResponseSchema.parse({
      data: options.chromeInstaller.getState(),
    });
    return c.json(body, 200);
  });

  app.get("/v1/providers", (c) => {
    const body = providerResponseSchema.parse({ data: options.providers.getConfig() });
    return c.json(body, 200);
  });

  app.put("/v1/providers", async (c) => {
    const body = await parseJsonBody(c, providerConfigRequestSchema);
    if (!body.ok) {
      return problemResponse(c, 400, "Body permintaan tidak valid.");
    }

    try {
      const config = await options.providers.setConfig(body.data);
      return c.json(providerResponseSchema.parse({ data: config }), 200);
    } catch (error) {
      return handleKnownError(c, error);
    }
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

  app.get("/v1/profiles/:id/policy", async (c) => {
    const parsedId = profileIdSchema.safeParse(c.req.param("id"));
    if (!parsedId.success) {
      return problemResponse(c, 400, "Id profil tidak valid.");
    }

    try {
      const policy = await options.profilePolicies.get(parsedId.data);
      return c.json(profilePolicyResponseSchema.parse({ data: policy }), 200);
    } catch (error) {
      return handleKnownError(c, error);
    }
  });

  app.put("/v1/profiles/:id/policy", async (c) => {
    const parsedId = profileIdSchema.safeParse(c.req.param("id"));
    if (!parsedId.success) {
      return problemResponse(c, 400, "Id profil tidak valid.");
    }

    const body = await parseJsonBody(c, profilePolicySchema);
    if (!body.ok) {
      return problemResponse(c, 400, "Body permintaan tidak valid.");
    }

    try {
      const policy = await profileLock.run(parsedId.data, () =>
        options.profilePolicies.set(parsedId.data, body.data),
      );
      return c.json(profilePolicyResponseSchema.parse({ data: policy }), 200);
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

  app.get("/v1/sessions/:id/thumbnail", async (c) => {
    const parsedId = sessionIdSchema.safeParse(c.req.param("id"));
    if (!parsedId.success) {
      return problemResponse(c, 400, "Id sesi tidak valid.");
    }

    if (options.sessions.get(parsedId.data) === null) {
      return problemResponse(c, 404, "Sesi tidak ditemukan.");
    }

    const context = options.sessions.getContext?.(parsedId.data) ?? null;
    if (context === null) {
      return problemResponse(c, 409, "Sesi belum siap menampilkan cuplikan.");
    }

    const page = context.pages().at(-1);
    if (page === undefined) {
      return problemResponse(c, 409, "Sesi belum memiliki halaman.");
    }

    try {
      const jpeg = await thumbnailLock.run(parsedId.data, () =>
        capturePageThumbnail({ context, page }),
      );
      return c.body(jpeg, 200, {
        "Content-Type": "image/jpeg",
        "Cache-Control": "no-store",
      });
    } catch (error) {
      console.warn(
        `Session thumbnail failed: ${parsedId.data}: ${
          error instanceof Error ? error.name : "unknown"
        }`,
      );
      return problemResponse(c, 500, "Cuplikan halaman gagal dibuat.");
    }
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

  app.post("/v1/sessions/:id/actions", async (c) => {
    const parsedId = sessionIdSchema.safeParse(c.req.param("id"));
    if (!parsedId.success) {
      return problemResponse(c, 400, "Id sesi tidak valid.");
    }

    const body = await parseJsonBody(c, actionRequestSchema);
    if (!body.ok) {
      return problemResponse(c, 400, "Body permintaan tidak valid.");
    }

    try {
      const result = await options.actions.execute(parsedId.data, body.data);
      return c.json(actionResponseSchema.parse({ data: result }), 200);
    } catch (error) {
      return handleKnownError(c, error);
    }
  });

  app.post("/v1/sessions/:id/tasks", async (c) => {
    const parsedId = sessionIdSchema.safeParse(c.req.param("id"));
    if (!parsedId.success) {
      return problemResponse(c, 400, "Id sesi tidak valid.");
    }

    const body = await parseJsonBody(c, createTaskRequestSchema);
    if (!body.ok) {
      return problemResponse(c, 400, "Body permintaan tidak valid.");
    }

    const idempotencyKey = parseIdempotencyKey(c);
    if (!idempotencyKey.ok) {
      return problemResponse(c, 400, idempotencyKey.detail);
    }

    try {
      const task = options.tasks.createTask(parsedId.data, body.data, idempotencyKey.key);
      options.runner.start(task.id);
      return c.json(taskResponseSchema.parse({ data: task }), 202);
    } catch (error) {
      return handleKnownError(c, error);
    }
  });

  app.get("/v1/tasks", (c) => {
    const parsedQuery = taskListQuerySchema.safeParse(c.req.query());
    if (!parsedQuery.success) {
      return problemResponse(c, 400, "Parameter daftar task tidak valid.");
    }

    const { page, page_size, sessionId, status } = parsedQuery.data;
    const tasks = options.tasks
      .listTasks()
      .filter(
        (task) =>
          (sessionId === undefined || task.sessionId === sessionId) &&
          (status === undefined || task.status === status),
      )
      .sort((left, right) => compareTimeThenIdDesc(left, right, (task) => task.createdAt));
    return c.json(
      taskListResponseSchema.parse(paginate(tasks, page, page_size)),
      200,
    );
  });

  app.get("/v1/tasks/:id", (c) => {
    const parsedId = taskIdSchema.safeParse(c.req.param("id"));
    if (!parsedId.success) {
      return problemResponse(c, 400, "Id task tidak valid.");
    }

    const task = options.tasks.getTask(parsedId.data);
    if (task === null) {
      return problemResponse(c, 404, "Task tidak ditemukan.");
    }

    return c.json(taskResponseSchema.parse({ data: task }), 200);
  });

  app.get("/v1/tasks/:id/steps", (c) => {
    const parsedId = taskIdSchema.safeParse(c.req.param("id"));
    if (!parsedId.success) {
      return problemResponse(c, 400, "Id task tidak valid.");
    }

    const pagination = parsePagination(c);
    if (pagination === null) {
      return problemResponse(c, 400, "Parameter pagination tidak valid.");
    }

    if (options.tasks.getTask(parsedId.data) === null) {
      return problemResponse(c, 404, "Task tidak ditemukan.");
    }

    const steps = options.steps
      .listByTask(parsedId.data)
      .slice()
      .sort((left, right) => left.index - right.index);
    const body = agentStepListResponseSchema.parse(
      paginate(steps, pagination.page, pagination.page_size),
    );
    return c.json(body, 200);
  });

  app.post("/v1/tasks/:id/cancel", (c) => {
    const parsedId = taskIdSchema.safeParse(c.req.param("id"));
    if (!parsedId.success) {
      return problemResponse(c, 400, "Id task tidak valid.");
    }

    try {
      const task = options.tasks.cancelTask(parsedId.data);
      options.runner.cancel(parsedId.data);
      return c.json(taskResponseSchema.parse({ data: task }), 202);
    } catch (error) {
      return handleKnownError(c, error);
    }
  });

  app.post("/v1/tasks/:id/approval", async (c) => {
    const parsedId = taskIdSchema.safeParse(c.req.param("id"));
    if (!parsedId.success) {
      return problemResponse(c, 400, "Id task tidak valid.");
    }

    const body = await parseJsonBody(c, approvalDecisionRequestSchema);
    if (!body.ok) {
      return problemResponse(c, 400, "Body permintaan tidak valid.");
    }

    try {
      const result = options.tasks.resolveApproval(parsedId.data, body.data);
      options.runner.notifyApprovalDecision?.(
        parsedId.data,
        body.data.approve,
      );
      return c.json(approvalResponseSchema.parse({ data: result }), 202);
    } catch (error) {
      return handleKnownError(c, error);
    }
  });

  app.get("/v1/approvals", (c) => {
    const parsedQuery = approvalListQuerySchema.safeParse(c.req.query());
    if (!parsedQuery.success) {
      return problemResponse(c, 400, "Parameter daftar approval tidak valid.");
    }

    const { page, page_size, decision, taskId } = parsedQuery.data;
    const approvals = options.tasks
      .listApprovals()
      .filter(
        (approval) =>
          (decision === undefined || approval.decision === decision) &&
          (taskId === undefined || approval.taskId === taskId),
      )
      .sort((left, right) =>
        compareTimeThenIdDesc(left, right, (approval) => approval.requestedAt),
      );
    return c.json(
      approvalListResponseSchema.parse(paginate(approvals, page, page_size)),
      200,
    );
  });

  app.get("/v1/events", (c) => {
    const rawTaskId = c.req.query("taskId");
    if (rawTaskId === undefined) {
      return eventStream.open(c, undefined);
    }

    const parsedTaskId = taskIdSchema.safeParse(rawTaskId);
    if (!parsedTaskId.success) {
      return problemResponse(c, 400, "Id task tidak valid.");
    }

    return eventStream.open(c, parsedTaskId.data);
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
