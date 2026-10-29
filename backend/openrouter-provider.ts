import type { ProviderCredentialInput, ProviderValidation } from "./provider-registry";
import type { ClientModelGenerate } from "./stagehand-runtime";

export const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";
export const OPENROUTER_VALIDATION_TIMEOUT_MS = 15_000;
export const OPENROUTER_GENERATE_TIMEOUT_MS = 60_000;

const KEY_REJECTED_MESSAGE = "API key OpenRouter ditolak.";
const MODEL_MISSING_MESSAGE = "Model OpenRouter tidak ditemukan.";
const STRUCTURED_UNSUPPORTED_MESSAGE =
  "Model OpenRouter tidak mendukung structured output.";
const UNAVAILABLE_MESSAGE = "Layanan OpenRouter sedang tidak tersedia.";
const UNREACHABLE_MESSAGE = "OpenRouter tidak dapat dihubungi.";

const GENERATE_FAILED_MESSAGE = "Panggilan model OpenRouter gagal.";
const GENERATE_TIMEOUT_MESSAGE = "Panggilan model OpenRouter melewati batas waktu.";
const GENERATE_INVALID_JSON_MESSAGE =
  "Model OpenRouter mengembalikan JSON yang tidak valid.";
const GENERATE_UNSUPPORTED_MESSAGE =
  "Pesan Stagehand tidak dapat dipetakan ke OpenRouter.";

const MAX_FAILURE_BODY_BYTES = 16 * 1024;
const MAX_RETRY_AFTER_SECONDS = 24 * 60 * 60;
const FAILURE_METADATA_PATTERN = /^[A-Za-z0-9_.:-]{1,100}$/;

export type OpenRouterFailureMetadata = {
  readonly httpStatus: number | null;
  readonly retryAfterSeconds: number | null;
  readonly errorType: string | null;
  readonly providerCode: string | null;
  readonly limitSource: string | null;
};

export type OpenRouterValidation = ProviderValidation;

export type OpenRouterValidator = (
  input: ProviderCredentialInput,
) => Promise<OpenRouterValidation>;

export type OpenRouterFetch = typeof fetch;

export type OpenRouterErrorCode =
  | "openrouter_generate_failed"
  | "openrouter_generate_timeout"
  | "openrouter_generate_invalid_json"
  | "openrouter_generate_unsupported_message";

export class OpenRouterError extends Error {
  readonly code: OpenRouterErrorCode;
  readonly httpStatus: number | null;
  readonly retryAfterSeconds: number | null;
  readonly errorType: string | null;
  readonly providerCode: string | null;
  readonly limitSource: string | null;

  constructor(
    code: OpenRouterErrorCode,
    message: string,
    metadata: Partial<OpenRouterFailureMetadata> = {},
  ) {
    super(message);
    this.name = "OpenRouterError";
    this.code = code;
    this.httpStatus = metadata.httpStatus ?? null;
    this.retryAfterSeconds = metadata.retryAfterSeconds ?? null;
    this.errorType = metadata.errorType ?? null;
    this.providerCode = metadata.providerCode ?? null;
    this.limitSource = metadata.limitSource ?? null;
  }
}

type ClientGenerateRequest = Parameters<ClientModelGenerate>[0];
type ClientGenerateResult = Awaited<ReturnType<ClientModelGenerate>>;
type ClientStructuredResult = Extract<
  ClientGenerateResult,
  { readonly outputFormat: "json_schema" }
>;
type StagehandMessage = ClientGenerateRequest["messages"][number];
type StagehandContentBlock = Exclude<StagehandMessage["content"], readonly unknown[]>;

type OpenRouterContentPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image_url"; readonly image_url: { readonly url: string } };

type OpenRouterMessage = {
  readonly role: "system" | "user" | "assistant";
  readonly content: readonly OpenRouterContentPart[];
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contentBlocks(content: StagehandMessage["content"]): readonly StagehandContentBlock[] {
  return Array.isArray(content) ? content : [content];
}

function toOpenRouterPart(block: StagehandContentBlock): OpenRouterContentPart {
  if (block.type === "text") {
    return { type: "text", text: block.text };
  }

  if (block.type === "image") {
    return {
      type: "image_url",
      image_url: { url: `data:${block.mimeType};base64,${block.data}` },
    };
  }

  throw new OpenRouterError(
    "openrouter_generate_unsupported_message",
    GENERATE_UNSUPPORTED_MESSAGE,
  );
}

function toOpenRouterMessage(message: StagehandMessage): OpenRouterMessage {
  return {
    role: message.role,
    content: contentBlocks(message.content).map(toOpenRouterPart),
  };
}

function supportsStructuredOutput(value: unknown): boolean {
  return (
    isObject(value) &&
    Array.isArray(value.supported_parameters) &&
    value.supported_parameters.includes("structured_outputs")
  );
}

function emptyFailureMetadata(): OpenRouterFailureMetadata {
  return {
    httpStatus: null,
    retryAfterSeconds: null,
    errorType: null,
    providerCode: null,
    limitSource: null,
  };
}

function sanitizeFailureValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  return FAILURE_METADATA_PATTERN.test(value) ? value : null;
}

function parseRetryAfter(value: string | null): number | null {
  if (value === null) {
    return null;
  }

  const text = value.trim();
  if (text.length === 0) {
    return null;
  }

  if (/^\d+$/.test(text)) {
    const seconds = Number.parseInt(text, 10);
    if (!Number.isSafeInteger(seconds)) {
      return null;
    }
    return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
  }

  if (!text.includes(":") || text.startsWith("-")) {
    return null;
  }

  const timestamp = Date.parse(text);
  if (Number.isNaN(timestamp)) {
    return null;
  }

  const seconds = Math.ceil((timestamp - Date.now()) / 1000);
  if (seconds <= 0) {
    return 0;
  }
  return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
}

async function readFailureBody(response: Response): Promise<string | null> {
  const stream = response.body;
  if (stream === null) {
    return null;
  }

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = stream.getReader();
  } catch {
    return null;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value === undefined) {
        continue;
      }
      total += value.byteLength;
      if (total > MAX_FAILURE_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return null;
  }

  if (chunks.length === 0) {
    return "";
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(body);
}

async function readFailureMetadata(
  response: Response,
): Promise<OpenRouterFailureMetadata> {
  const metadata: OpenRouterFailureMetadata = {
    ...emptyFailureMetadata(),
    httpStatus: response.status,
    retryAfterSeconds: parseRetryAfter(response.headers.get("Retry-After")),
  };
  const body = await readFailureBody(response);

  if (body === null) {
    return metadata;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return metadata;
  }

  if (!isObject(payload) || !isObject(payload.error)) {
    return metadata;
  }

  const error = payload.error;
  const details = isObject(error.metadata) ? error.metadata : undefined;

  return {
    ...metadata,
    errorType:
      sanitizeFailureValue(details?.error_type) ??
      sanitizeFailureValue(error.type),
    providerCode: sanitizeFailureValue(details?.provider_code),
    limitSource: sanitizeFailureValue(details?.limit_source),
  };
}

export async function validateOpenRouterCredentials(
  input: ProviderCredentialInput,
  fetchFn: OpenRouterFetch = globalThis.fetch,
): Promise<OpenRouterValidation> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENROUTER_VALIDATION_TIMEOUT_MS);

  try {
    const keyResponse = await fetchFn(`${OPENROUTER_API_BASE}/key`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${input.apiKey}`,
      },
      signal: controller.signal,
    });

    if (keyResponse.status === 401 || keyResponse.status === 403) {
      return { ok: false, message: KEY_REJECTED_MESSAGE };
    }

    if (!keyResponse.ok) {
      return { ok: false, message: UNAVAILABLE_MESSAGE };
    }

    const modelResponse = await fetchFn(
      `${OPENROUTER_API_BASE}/models/${input.model}/endpoints`,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${input.apiKey}`,
        },
        signal: controller.signal,
      },
    );

    if (modelResponse.status === 401 || modelResponse.status === 403) {
      return { ok: false, message: KEY_REJECTED_MESSAGE };
    }

    if (modelResponse.status === 404) {
      return { ok: false, message: MODEL_MISSING_MESSAGE };
    }

    if (!modelResponse.ok) {
      return { ok: false, message: UNAVAILABLE_MESSAGE };
    }

    let payload: unknown;
    try {
      payload = await modelResponse.json();
    } catch {
      return { ok: false, message: STRUCTURED_UNSUPPORTED_MESSAGE };
    }

    const data = isObject(payload) ? payload.data : undefined;
    const endpoints = isObject(data) ? data.endpoints : undefined;
    const supported =
      Array.isArray(endpoints) && endpoints.some(supportsStructuredOutput);

    return supported
      ? { ok: true }
      : { ok: false, message: STRUCTURED_UNSUPPORTED_MESSAGE };
  } catch {
    return { ok: false, message: UNREACHABLE_MESSAGE };
  } finally {
    clearTimeout(timeout);
  }
}

export function createOpenRouterGenerate(input: {
  readonly model: string;
  readonly apiKey: string;
  readonly fetch?: OpenRouterFetch;
}): ClientModelGenerate {
  const fetchFn = input.fetch ?? globalThis.fetch;

  return async (request) => {
    const messages: OpenRouterMessage[] = [];

    if (request.systemPrompt !== undefined) {
      messages.push({ role: "system", content: [{ type: "text", text: request.systemPrompt }] });
    }

    messages.push(...request.messages.map(toOpenRouterMessage));

    const body = {
      model: input.model,
      messages,
      ...(request.responseFormat?.type === "json_schema"
        ? {
            response_format: {
              type: "json_schema",
              json_schema: {
                name: request.responseFormat.name,
                strict: true,
                schema: request.responseFormat.schema,
              },
            },
          }
        : {}),
      provider: { require_parameters: true, allow_fallbacks: false },
    };

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      OPENROUTER_GENERATE_TIMEOUT_MS,
    );

    let response: Response;
    try {
      response = await fetchFn(`${OPENROUTER_API_BASE}/chat/completions`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${input.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw new OpenRouterError(
          "openrouter_generate_timeout",
          GENERATE_TIMEOUT_MESSAGE,
        );
      }
      throw new OpenRouterError("openrouter_generate_failed", GENERATE_FAILED_MESSAGE);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new OpenRouterError(
        "openrouter_generate_failed",
        GENERATE_FAILED_MESSAGE,
        await readFailureMetadata(response),
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new OpenRouterError("openrouter_generate_failed", GENERATE_FAILED_MESSAGE);
    }

    const choices = isObject(payload) ? payload.choices : undefined;
    const first = Array.isArray(choices) ? choices[0] : undefined;
    const message = isObject(first) ? first.message : undefined;
    const content = isObject(message) ? message.content : undefined;

    if (typeof content !== "string") {
      throw new OpenRouterError("openrouter_generate_failed", GENERATE_FAILED_MESSAGE);
    }

    const base = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: content }],
    };

    if (request.responseFormat?.type !== "json_schema") {
      return { ...base, outputFormat: "text" };
    }

    let structuredContent: ClientStructuredResult["structuredContent"];
    try {
      structuredContent = JSON.parse(content);
    } catch {
      throw new OpenRouterError(
        "openrouter_generate_invalid_json",
        GENERATE_INVALID_JSON_MESSAGE,
      );
    }

    return { ...base, outputFormat: "json_schema", structuredContent };
  };
}
