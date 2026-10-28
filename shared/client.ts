import type { ZodType } from "zod";
import {
  actionResponseSchema,
  type ActionRequest,
  type ActionResponse,
} from "./action";
import {
  agentStepListResponseSchema,
  type AgentStepListResponse,
} from "./agent-step";
import {
  approvalListResponseSchema,
  approvalResponseSchema,
  browserStateResponseSchema,
  profileListResponseSchema,
  profilePolicyResponseSchema,
  profileResponseSchema,
  researchResultResponseSchema,
  sessionListResponseSchema,
  sessionResponseSchema,
  taskListResponseSchema,
  taskResponseSchema,
  type ApprovalDecisionRequest,
  type ApprovalListQuery,
  type ApprovalListResponse,
  type ApprovalResponse,
  type CreateProfileRequest,
  type CreateSessionRequest,
  type CreateTaskRequest,
  type PaginationQuery,
  type ProfileListResponse,
  type ProfilePolicyResponse,
  type ProfileResponse,
  type ResearchResultResponse,
  type SessionListResponse,
  type SessionResponse,
  type TaskListQuery,
  type TaskListResponse,
  type TaskResponse,
} from "./api";
import type { ChromeInstallerState } from "./chrome-installer";
import {
  conversationListResponseSchema,
  conversationResponseSchema,
  messageListResponseSchema,
  sendConversationMessageResponseSchema,
  type ConversationListResponse,
  type ConversationResponse,
  type CreateConversationRequest,
  type MessageListResponse,
  type SendConversationMessageRequest,
  type SendConversationMessageResponse,
} from "./conversation";
import {
  healthResponseSchema,
  problemSchema,
  type ApiInfo,
  type HealthResponse,
  type Problem,
} from "./contracts";
import { domainEventSchema, type DomainEvent } from "./event";
import type { ProfilePolicy } from "./profile-policy";
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
  readonly accept?: string;
  readonly signal?: AbortSignal;
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

export type SendConversationMessageOptions = {
  readonly idempotencyKey: string;
};

export type StreamEventsOptions = {
  readonly taskId?: string;
  readonly lastEventId?: string;
  readonly signal?: AbortSignal;
};

export type ThumbnailOptions = {
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
    getPolicy(id: string): Promise<ProfilePolicyResponse>;
    setPolicy(id: string, policy: ProfilePolicy): Promise<ProfilePolicyResponse>;
  };
  readonly conversations: {
    list(
      profileId: string,
      query?: Partial<PaginationQuery>,
    ): Promise<ConversationListResponse>;
    create(
      profileId: string,
      input?: CreateConversationRequest,
    ): Promise<ConversationResponse>;
    listMessages(
      profileId: string,
      conversationId: string,
      query?: Partial<PaginationQuery>,
    ): Promise<MessageListResponse>;
    sendMessage(
      profileId: string,
      conversationId: string,
      input: SendConversationMessageRequest,
      options: SendConversationMessageOptions,
    ): Promise<SendConversationMessageResponse>;
  };
  readonly sessions: {
    list(query?: Partial<PaginationQuery>): Promise<SessionListResponse>;
    start(input: CreateSessionRequest): Promise<SessionResponse>;
    get(id: string): Promise<SessionResponse>;
    close(id: string): Promise<void>;
    thumbnail(id: string, options?: ThumbnailOptions): Promise<Blob>;
  };
  readonly tasks: {
    list(query?: Partial<TaskListQuery>): Promise<TaskListResponse>;
    create(
      sessionId: string,
      input: CreateTaskRequest,
      options: CreateTaskOptions,
    ): Promise<TaskResponse>;
    get(id: string): Promise<TaskResponse>;
    listSteps(
      id: string,
      query?: Partial<PaginationQuery>,
    ): Promise<AgentStepListResponse>;
    getResearch(id: string): Promise<ResearchResultResponse>;
    cancel(id: string): Promise<TaskResponse>;
    resolveApproval(
      id: string,
      input: ApprovalDecisionRequest,
    ): Promise<ApprovalResponse>;
  };
  readonly approvals: {
    list(query?: Partial<ApprovalListQuery>): Promise<ApprovalListResponse>;
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

function queryString(
  values: Readonly<Record<string, string | number | undefined>>,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) {
      params.set(key, String(value));
    }
  }

  const value = params.toString();
  return value === "" ? "" : `?${value}`;
}

function paginationQuery(query: Partial<PaginationQuery> | undefined): string {
  return queryString({ page: query?.page, page_size: query?.page_size });
}

function taskListQuery(query: Partial<TaskListQuery> | undefined): string {
  return queryString({
    page: query?.page,
    page_size: query?.page_size,
    sessionId: query?.sessionId,
    status: query?.status,
  });
}

function approvalListQuery(query: Partial<ApprovalListQuery> | undefined): string {
  return queryString({
    page: query?.page,
    page_size: query?.page_size,
    decision: query?.decision,
    taskId: query?.taskId,
  });
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
    Accept: options.accept ?? "application/json",
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
      signal: options.signal,
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

async function requestThumbnail(
  config: ClientConfig,
  path: string,
  options: RequestOptions,
): Promise<Blob> {
  const response = await send(config, path, { ...options, accept: "image/jpeg" });
  const contentType = response.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase();

  if (contentType !== "image/jpeg") {
    throw new ArgusApiError(INVALID_RESPONSE_MESSAGE, response.status, null);
  }

  try {
    return await response.blob();
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    throw new ArgusApiError(INVALID_RESPONSE_MESSAGE, response.status, null);
  }
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
      getPolicy: (id) =>
        request(
          config,
          profilePolicyResponseSchema,
          `/profiles/${encodeURIComponent(id)}/policy`,
          { method: "GET" },
        ),
      setPolicy: (id, policy) =>
        request(
          config,
          profilePolicyResponseSchema,
          `/profiles/${encodeURIComponent(id)}/policy`,
          { method: "PUT", body: policy },
        ),
    },
    conversations: {
      list: (profileId, query) =>
        request(
          config,
          conversationListResponseSchema,
          `/profiles/${encodeURIComponent(profileId)}/conversations${paginationQuery(query)}`,
          { method: "GET" },
        ),
      create: (profileId, input = {}) =>
        request(
          config,
          conversationResponseSchema,
          `/profiles/${encodeURIComponent(profileId)}/conversations`,
          { method: "POST", body: input },
        ),
      listMessages: (profileId, conversationId, query) =>
        request(
          config,
          messageListResponseSchema,
          `/profiles/${encodeURIComponent(profileId)}/conversations/${encodeURIComponent(conversationId)}/messages${paginationQuery(query)}`,
          { method: "GET" },
        ),
      sendMessage: (profileId, conversationId, input, sendOptions) =>
        request(
          config,
          sendConversationMessageResponseSchema,
          `/profiles/${encodeURIComponent(profileId)}/conversations/${encodeURIComponent(conversationId)}/messages`,
          {
            method: "POST",
            body: input,
            headers: { "Idempotency-Key": sendOptions.idempotencyKey },
          },
        ),
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
      thumbnail: (id, thumbnailOptions) =>
        requestThumbnail(
          config,
          `/sessions/${encodeURIComponent(id)}/thumbnail`,
          { method: "GET", signal: thumbnailOptions?.signal },
        ),
    },
    tasks: {
      list: (query) =>
        request(
          config,
          taskListResponseSchema,
          `/tasks${taskListQuery(query)}`,
          { method: "GET" },
        ),
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
      listSteps: (id, query) =>
        request(
          config,
          agentStepListResponseSchema,
          `/tasks/${encodeURIComponent(id)}/steps${paginationQuery(query)}`,
          { method: "GET" },
        ),
      getResearch: (id) =>
        request(
          config,
          researchResultResponseSchema,
          `/tasks/${encodeURIComponent(id)}/research`,
          { method: "GET" },
        ),
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
    approvals: {
      list: (query) =>
        request(
          config,
          approvalListResponseSchema,
          `/approvals${approvalListQuery(query)}`,
          { method: "GET" },
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
