import type { ZodType } from "zod";
import { browserStateResponseSchema } from "../shared/api";
import type { ChromeInstallerState } from "../shared/chrome-installer";
import {
  healthResponseSchema,
  problemSchema,
  type ApiInfo,
  type HealthResponse,
} from "../shared/contracts";
import { texts } from "./texts";

const HEALTH_TIMEOUT_MS = 2000;
const BROWSER_READ_TIMEOUT_MS = 2000;
const BROWSER_DOWNLOAD_TIMEOUT_MS = 5000;
const LOCAL_EXECUTABLE_SET_TIMEOUT_MS = 10000;
const LOCAL_EXECUTABLE_CLEAR_TIMEOUT_MS = 5000;

type RequestOptions = {
  readonly method?: "GET" | "POST" | "PUT" | "DELETE";
  readonly body?: unknown;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
};

export class BrowserApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserApiError";
  }
}

async function readProblemDetail(response: Response): Promise<string> {
  try {
    const parsed = problemSchema.safeParse(await response.json());
    return parsed.success ? parsed.data.detail : texts.api.generic;
  } catch {
    return texts.api.generic;
  }
}

async function request(
  apiInfo: ApiInfo,
  path: string,
  options: RequestOptions,
): Promise<Response> {
  let response: Response;

  try {
    response = await fetch(`${apiInfo.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${apiInfo.token}`,
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal:
        options.signal === undefined
          ? AbortSignal.timeout(options.timeoutMs)
          : AbortSignal.any([AbortSignal.timeout(options.timeoutMs), options.signal]),
    });
  } catch {
    throw new BrowserApiError(texts.api.unreachable);
  }

  if (!response.ok) {
    throw new BrowserApiError(await readProblemDetail(response));
  }

  return response;
}

async function parseResponse<T>(response: Response, schema: ZodType<T>): Promise<T> {
  try {
    return schema.parse(await response.json());
  } catch {
    throw new BrowserApiError(texts.api.invalidResponse);
  }
}

export async function fetchHealth(apiInfo: ApiInfo): Promise<HealthResponse> {
  const response = await request(apiInfo, "/v1/health", {
    timeoutMs: HEALTH_TIMEOUT_MS,
  });
  return parseResponse(response, healthResponseSchema);
}

export async function fetchBrowserState(
  apiInfo: ApiInfo,
  signal?: AbortSignal,
): Promise<ChromeInstallerState> {
  const response = await request(apiInfo, "/v1/browser", {
    timeoutMs: BROWSER_READ_TIMEOUT_MS,
    signal,
  });
  return (await parseResponse(response, browserStateResponseSchema)).data;
}

export async function startBrowserDownload(
  apiInfo: ApiInfo,
  signal?: AbortSignal,
): Promise<ChromeInstallerState> {
  const response = await request(apiInfo, "/v1/browser/download", {
    method: "POST",
    timeoutMs: BROWSER_DOWNLOAD_TIMEOUT_MS,
    signal,
  });
  return (await parseResponse(response, browserStateResponseSchema)).data;
}

export async function setLocalExecutable(
  apiInfo: ApiInfo,
  path: string,
  signal?: AbortSignal,
): Promise<ChromeInstallerState> {
  const response = await request(apiInfo, "/v1/browser/local-executable", {
    method: "PUT",
    body: { path },
    timeoutMs: LOCAL_EXECUTABLE_SET_TIMEOUT_MS,
    signal,
  });
  return (await parseResponse(response, browserStateResponseSchema)).data;
}

export async function clearLocalExecutable(
  apiInfo: ApiInfo,
  signal?: AbortSignal,
): Promise<void> {
  await request(apiInfo, "/v1/browser/local-executable", {
    method: "DELETE",
    timeoutMs: LOCAL_EXECUTABLE_CLEAR_TIMEOUT_MS,
    signal,
  });
}
