import type { ZodType } from "zod";
import {
  actionResponseSchema,
  type ActionRequest,
  type ActionResponse,
} from "./action";
import {
  approvalResponseSchema,
  browserStateResponseSchema,
  profileListResponseSchema,
  profileResponseSchema,
  sessionListResponseSchema,
  sessionResponseSchema,
  taskResponseSchema,
  type ApprovalDecisionRequest,
  type ApprovalResponse,
  type CreateProfileRequest,
  type CreateSessionRequest,
  type CreateTaskRequest,
  type PaginationQuery,
  type ProfileListResponse,
  type ProfileResponse,
  type SessionListResponse,
  type SessionResponse,
  type TaskResponse,
} from "./api";
import type { ChromeInstallerState } from "./chrome-installer";
import {
  healthResponseSchema,
  problemSchema,
  type ApiInfo,
  type HealthResponse,
  type Problem,
} from "./contracts";
import { domainEventSchema, type DomainEvent } from "./event";
import {
  providerResponseSchema,
  type ProviderConfig,
  type ProviderConfigRequest,
} from "./provider";

const UNREACHABLE_MESSAGE = "Layanan Argus tidak dapat dihubungi.";
const REJECTED_MESSAGE = "Layanan Argus menolak permintaan.";
const INVALID_RESPONSE_MESSAGE = "Respons Argus tidak valid.";
const STREAM_CLOSED_MESSAGE = "Koneksi event terputus.";

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

type RequestOptions = {
  readonly method: HttpMethod;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
};

type ClientConfig = {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetch: typeof fetch;
};

type EventFrame = {
  id: string;
  event: string | null;
  data: string[];
};

type ParsedJson =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false };

export type ArgusClientOptions = {
  readonly api: ApiInfo;
  readonly fetch?: typeof fetch;
};

export type CreateTaskOptions = {
  readonly idempotencyKey: string;
};

export type StreamEventsOptions = {
  readonly taskId?: string;
  readonly lastEventId?: string;
  readonly signal?: AbortSignal;
};

export type ArgusEvent = {
  readonly id: string;
  readonly event: DomainEvent;
};

export type ArgusClient = {
  health(): Promise<HealthResponse>;
  readonly browser: {
    get(): Promise<ChromeInstallerState>;
    download(): Promise<ChromeInstallerState>;
    setLocalExecutable(path: string): Promise<ChromeInstallerState>;
    clearLocalExecutable(): Promise<void>;
  };
  readonly profiles: {
    list(query?: Partial<PaginationQuery>): Promise<ProfileListResponse>;
    create(input: CreateProfileRequest): Promise<ProfileResponse>;
    delete(id: string): Promise<void>;
  };
  readonly sessions: {
    list(query?: Partial<PaginationQuery>): Promise<SessionListResponse>;
    start(input: CreateSessionRequest): Promise<SessionResponse>;
    get(id: string): Promise<SessionResponse>;
    close(id: string): Promise<void>;
  };
  readonly tasks: {
    create(
      sessionId: string,
      input: CreateTaskRequest,
      options: CreateTaskOptions,
    ): Promise<TaskResponse>;
    get(id: string): Promise<TaskResponse>;
    cancel(id: string): Promise<TaskResponse>;
    resolveApproval(
      id: string,
      input: ApprovalDecisionRequest,
    ): Promise<ApprovalResponse>;
  };
  readonly actions: {
    run(sessionId: string, input: ActionRequest): Promise<ActionResponse>;
  };
  readonly providers: {
    get(): Promise<ProviderConfig>;
    set(input: ProviderConfigRequest): Promise<ProviderConfig>;
  };
  readonly events: {
    stream(options?: StreamEventsOptions): AsyncIterable<ArgusEvent>;
  };
};

export class ArgusApiError extends Error {
  readonly status: number;
  readonly problem: Problem | null;

  constructor(message: string, status: number, problem: Problem | null) {
    super(message);
    this.name = "ArgusApiError";
    this.status = status;
    this.problem = problem;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function paginationQuery(query: Partial<PaginationQuery> | undefined): string {
  if (query === undefined) {
    return "";
  }

  const params = new URLSearchParams();
  if (query.page !== undefined) {
    params.set("page", String(query.page));
  }
  if (query.page_size !== undefined) {
    params.set("page_size", String(query.page_size));
  }

  const value = params.toString();
  return value === "" ? "" : `?${value}`;
}

async function toApiError(response: Response): Promise<ArgusApiError> {
  const body: unknown = await response.json().catch(() => null);
  const parsed = problemSchema.safeParse(body);

  if (parsed.success) {
    return new ArgusApiError(parsed.data.detail, response.status, parsed.data);
  }

  return new ArgusApiError(REJECTED_MESSAGE, response.status, null);
}

async function send(
  config: ClientConfig,
  path: string,
  options: RequestOptions,
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.token}`,
    Accept: "application/json",
  };

  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (options.headers !== undefined) {
    Object.assign(headers, options.headers);
  }

  let response: Response;
  try {
    response = await config.fetch(`${config.baseUrl}${path}`, {
      method: options.method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    throw new ArgusApiError(UNREACHABLE_MESSAGE, 0, null);
  }

  if (!response.ok) {
    throw await toApiError(response);
  }

  return response;
}

async function request<T>(
  config: ClientConfig,
  schema: ZodType<T>,
  path: string,
  options: RequestOptions,
): Promise<T> {
  const response = await send(config, path, options);

  try {
    return schema.parse(await response.json());
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    throw new ArgusApiError(INVALID_RESPONSE_MESSAGE, response.status, null);
  }
}

async function requestVoid(
  config: ClientConfig,
  path: string,
  options: RequestOptions,
): Promise<void> {
  await send(config, path, options);
}

async function requestBrowserState(
  config: ClientConfig,
  path: string,
  options: RequestOptions,
): Promise<ChromeInstallerState> {
  const response = await request(config, browserStateResponseSchema, path, options);
  return response.data;
}

async function requestProviderConfig(
  config: ClientConfig,
  path: string,
  options: RequestOptions,
): Promise<ProviderConfig> {
  const response = await request(config, providerResponseSchema, path, options);
  return response.data;
}

function parseJson(text: string): ParsedJson {
  try {
    const value: unknown = JSON.parse(text);
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

function toEvent(frame: EventFrame): ArgusEvent | null {
  if (frame.event === null || frame.data.length === 0) {
    return null;
  }

  const parsed = parseJson(frame.data.join("\n"));
  if (!parsed.ok) {
    return null;
  }
  if (
    typeof parsed.value !== "object" ||
    parsed.value === null ||
    Array.isArray(parsed.value)
  ) {
    return null;
  }

  const candidate: unknown = { ...parsed.value, type: frame.event };
  const event = domainEventSchema.safeParse(candidate);
  if (!event.success) {
    return null;
  }

  return { id: frame.id, event: event.data };
}

function handleLine(frame: EventFrame, line: string): ArgusEvent | null {
  if (line === "") {
    const event = toEvent(frame);
    frame.id = "";
    frame.event = null;
    frame.data.length = 0;
    return event;
  }

  if (line.startsWith(":")) {
    return null;
  }

  const separator = line.indexOf(":");
  const field = separator === -1 ? line : line.slice(0, separator);
  const rawValue = separator === -1 ? "" : line.slice(separator + 1);
  const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;

  if (field === "id") {
    frame.id = value;
  } else if (field === "event") {
    frame.event = value;
  } else if (field === "data") {
    frame.data.push(value);
  }

  return null;
}

async function* streamEvents(
  config: ClientConfig,
  options: StreamEventsOptions,
): AsyncGenerator<ArgusEvent, void, void> {
  const params = new URLSearchParams();
  if (options.taskId !== undefined) {
    params.set("taskId", options.taskId);
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.token}`,
    Accept: "text/event-stream",
  };
  if (options.lastEventId !== undefined) {
    headers["Last-Event-ID"] = options.lastEventId;
  }

  const query = params.toString();
  let response: Response;
  try {
    response = await config.fetch(
      `${config.baseUrl}/events${query === "" ? "" : `?${query}`}`,
      { method: "GET", headers, signal: options.signal },
    );
  } catch (error) {
    if (isAborted(options.signal) || isAbortError(error)) {
      return;
    }
    throw new ArgusApiError(UNREACHABLE_MESSAGE, 0, null);
  }

  if (!response.ok) {
    throw await toApiError(response);
  }
  if (response.body === null) {
    throw new ArgusApiError(STREAM_CLOSED_MESSAGE, 0, null);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const frame: EventFrame = { id: "", event: null, data: [] };
  let buffer = "";

  try {
    while (true) {
      if (isAborted(options.signal)) {
        return;
      }

      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (error) {
        if (isAborted(options.signal) || isAbortError(error)) {
          return;
        }
        throw new ArgusApiError(STREAM_CLOSED_MESSAGE, 0, null);
      }

      if (result.done) {
        if (isAborted(options.signal)) {
          return;
        }
        throw new ArgusApiError(STREAM_CLOSED_MESSAGE, 0, null);
      }

      buffer += decoder.decode(result.value, { stream: true });

      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        if (isAborted(options.signal)) {
          return;
        }

        const end = buffer[newline - 1] === "\r" ? newline - 1 : newline;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(newline + 1);

        const event = handleLine(frame, line);
        if (event !== null) {
          yield event;
        }

        newline = buffer.indexOf("\n");
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function createArgusClient(options: ArgusClientOptions): ArgusClient {
  const config: ClientConfig = {
    baseUrl: `${options.api.baseUrl.replace(/\/+$/, "")}/v1`,
    token: options.api.token,
    fetch: options.fetch ?? globalThis.fetch,
  };

  return {
    health: () => request(config, healthResponseSchema, "/health", { method: "GET" }),
    browser: {
      get: () => requestBrowserState(config, "/browser", { method: "GET" }),
      download: () =>
        requestBrowserState(config, "/browser/download", { method: "POST" }),
      setLocalExecutable: (path) =>
        requestBrowserState(config, "/browser/local-executable", {
          method: "PUT",
          body: { path },
        }),
      clearLocalExecutable: () =>
        requestVoid(config, "/browser/local-executable", { method: "DELETE" }),
    },
    profiles: {
      list: (query) =>
        request(
          config,
          profileListResponseSchema,
          `/profiles${paginationQuery(query)}`,
          { method: "GET" },
        ),
      create: (input) =>
        request(config, profileResponseSchema, "/profiles", {
          method: "POST",
          body: input,
        }),
      delete: (id) =>
        requestVoid(config, `/profiles/${encodeURIComponent(id)}`, {
          method: "DELETE",
        }),
    },
    sessions: {
      list: (query) =>
        request(
          config,
          sessionListResponseSchema,
          `/sessions${paginationQuery(query)}`,
          { method: "GET" },
        ),
      start: (input) =>
        request(config, sessionResponseSchema, "/sessions", {
          method: "POST",
          body: input,
        }),
      get: (id) =>
        request(config, sessionResponseSchema, `/sessions/${encodeURIComponent(id)}`, {
          method: "GET",
        }),
      close: (id) =>
        requestVoid(config, `/sessions/${encodeURIComponent(id)}`, {
          method: "DELETE",
        }),
    },
    tasks: {
      create: (sessionId, input, createOptions) =>
        request(
          config,
          taskResponseSchema,
          `/sessions/${encodeURIComponent(sessionId)}/tasks`,
          {
            method: "POST",
            body: input,
            headers: { "Idempotency-Key": createOptions.idempotencyKey },
          },
        ),
      get: (id) =>
        request(config, taskResponseSchema, `/tasks/${encodeURIComponent(id)}`, {
          method: "GET",
        }),
      cancel: (id) =>
        request(
          config,
          taskResponseSchema,
          `/tasks/${encodeURIComponent(id)}/cancel`,
          { method: "POST" },
        ),
      resolveApproval: (id, input) =>
        request(
          config,
          approvalResponseSchema,
          `/tasks/${encodeURIComponent(id)}/approval`,
          { method: "POST", body: input },
        ),
    },
    actions: {
      run: (sessionId, input) =>
        request(
          config,
          actionResponseSchema,
          `/sessions/${encodeURIComponent(sessionId)}/actions`,
          { method: "POST", body: input },
        ),
    },
    providers: {
      get: () => requestProviderConfig(config, "/providers", { method: "GET" }),
      set: (input) =>
        requestProviderConfig(config, "/providers", { method: "PUT", body: input }),
    },
    events: {
      stream: (streamOptions) => streamEvents(config, streamOptions ?? {}),
    },
  };
}
