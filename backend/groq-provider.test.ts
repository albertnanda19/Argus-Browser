import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientModelGenerate } from "./stagehand-runtime";
import {
  createGroqGenerate,
  GROQ_API_BASE,
  GROQ_GENERATE_TIMEOUT_MS,
  GROQ_VALIDATION_TIMEOUT_MS,
  GroqError,
  validateGroqCredentials,
} from "./groq-provider";

const apiKey = "unit-test-groq-key";
const model = "qwen/qwen3.8-27b";

type GenerateRequest = Parameters<ClientModelGenerate>[0];

type FetchCall = {
  readonly input: string;
  readonly init: RequestInit | undefined;
};

function fetchStub(
  respond: (call: FetchCall) => Response | Promise<Response>,
): { readonly fetch: typeof fetch; readonly calls: FetchCall[] } {
  const calls: FetchCall[] = [];

  const fetchImpl: typeof fetch = async (input, init) => {
    const call = { input: String(input), init };
    calls.push(call);
    return respond(call);
  };

  return { fetch: fetchImpl, calls };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function generateRequest(): GenerateRequest {
  return {
    systemPrompt: "You are a browser agent.",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Amati halaman ini." },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        ],
      },
    ],
    responseFormat: {
      type: "json_schema",
      name: "Observation",
      schema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
      },
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Groq credential validation", () => {
  it("checks the key against the models endpoint without putting it in the URL", async () => {
    const stub = fetchStub(() =>
      jsonResponse({ data: [{ id: "openai/gpt-oss-20b" }, { id: model }] }),
    );

    const result = await validateGroqCredentials({ model, apiKey }, stub.fetch);

    expect(result).toEqual({ ok: true });
    expect(stub.calls).toHaveLength(1);

    const call = stub.calls[0];
    if (call === undefined) {
      throw new Error("Expected one Groq request.");
    }

    const headers = new Headers(call.init?.headers);
    expect(call.input).toBe(`${GROQ_API_BASE}/models`);
    expect(call.input).not.toContain(apiKey);
    expect(call.init?.method).toBe("GET");
    expect(headers.get("Authorization")).toBe(`Bearer ${apiKey}`);
    expect(call.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([401, 403])("rejects a key the provider refuses with %i", async (status) => {
    const stub = fetchStub(() => new Response(null, { status }));

    const result = await validateGroqCredentials({ model, apiKey }, stub.fetch);

    expect(result).toEqual({ ok: false, message: "API key Groq ditolak." });
  });

  it("rejects a model that is missing from the model list", async () => {
    const stub = fetchStub(() =>
      jsonResponse({ data: [{ id: "openai/gpt-oss-20b" }] }),
    );

    const result = await validateGroqCredentials({ model, apiKey }, stub.fetch);

    expect(result).toEqual({
      ok: false,
      message: "Model Groq tidak tersedia.",
    });
  });

  it.each([429, 500])("reports a transient failure with %i", async (status) => {
    const stub = fetchStub(() => new Response(null, { status }));

    const result = await validateGroqCredentials({ model, apiKey }, stub.fetch);

    expect(result).toEqual({
      ok: false,
      message: "Layanan Groq sedang tidak tersedia.",
    });
  });

  it("returns an unreadable model list as unavailable", async () => {
    const stub = fetchStub(() => new Response("not json", { status: 200 }));

    const result = await validateGroqCredentials({ model, apiKey }, stub.fetch);

    expect(result).toEqual({
      ok: false,
      message: "Layanan Groq sedang tidak tersedia.",
    });
  });

  it("aborts after fifteen seconds without retrying", async () => {
    vi.useFakeTimers();
    const stub = fetchStub(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );

    const pending = validateGroqCredentials({ model, apiKey }, stub.fetch);
    await vi.advanceTimersByTimeAsync(GROQ_VALIDATION_TIMEOUT_MS - 1);
    expect(stub.calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;

    expect(result).toEqual({
      ok: false,
      message: "Groq tidak dapat dihubungi.",
    });
    expect(stub.calls).toHaveLength(1);
  });

  it("reports a network failure once without leaking the key", async () => {
    const stub = fetchStub(() => {
      throw new Error(`connect ECONNREFUSED ${apiKey}`);
    });

    const result = await validateGroqCredentials({ model, apiKey }, stub.fetch);

    expect(result).toEqual({
      ok: false,
      message: "Groq tidak dapat dihubungi.",
    });
    if (!result.ok) {
      expect(result.message).not.toContain(apiKey);
    }
    expect(stub.calls).toHaveLength(1);
  });
});

describe("Groq generate callback", () => {
  it("maps text and image messages and returns structured content", async () => {
    const stub = fetchStub(() =>
      jsonResponse({
        choices: [{ message: { role: "assistant", content: '{"ok":true}' } }],
      }),
    );
    const generate = createGroqGenerate({
      model,
      apiKey,
      fetch: stub.fetch,
    });

    const result = await generate(generateRequest());

    expect(result).toEqual({
      role: "assistant",
      content: [{ type: "text", text: '{"ok":true}' }],
      outputFormat: "json_schema",
      structuredContent: { ok: true },
    });
    expect(stub.calls).toHaveLength(1);

    const call = stub.calls[0];
    if (call === undefined) {
      throw new Error("Expected one Groq request.");
    }

    expect(call.input).toBe(`${GROQ_API_BASE}/chat/completions`);
    expect(call.init?.method).toBe("POST");
    const headers = new Headers(call.init?.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${apiKey}`);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(call.input).not.toContain(apiKey);

    const body = JSON.parse(String(call.init?.body)) as {
      model: string;
      messages: Array<{
        role: string;
        content: Array<Record<string, unknown>>;
      }>;
      response_format: {
        type: string;
        json_schema: { name: string; strict: boolean; schema: unknown };
      };
    };

    expect(body.model).toBe(model);
    expect(body.messages).toEqual([
      {
        role: "system",
        content: [{ type: "text", text: "You are a browser agent." }],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Amati halaman ini." },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,aGVsbG8=" },
          },
        ],
      },
    ]);
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "Observation",
        strict: true,
        schema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
        },
      },
    });
    expect(String(call.init?.body)).not.toContain(apiKey);
  });

  it("returns text output when no json_schema response format is requested", async () => {
    const stub = fetchStub(() =>
      jsonResponse({
        choices: [{ message: { role: "assistant", content: "Halo." } }],
      }),
    );
    const generate = createGroqGenerate({
      model,
      apiKey,
      fetch: stub.fetch,
    });

    const result = await generate({
      messages: [{ role: "user", content: [{ type: "text", text: "Halo?" }] }],
    });

    expect(result).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Halo." }],
      outputFormat: "text",
    });

    const body = JSON.parse(String(stub.calls[0]?.init?.body)) as Record<
      string,
      unknown
    >;
    expect("response_format" in body).toBe(false);
  });

  it("rejects a content block that has no Groq mapping", async () => {
    const stub = fetchStub(() => jsonResponse({}));
    const generate = createGroqGenerate({
      model,
      apiKey,
      fetch: stub.fetch,
    });

    const error = await generate({
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_1",
              name: "browser",
              input: { url: "https://example.com/" },
            },
          ],
        },
      ],
    }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(GroqError);
    expect(error).toMatchObject({
      name: "GroqError",
      code: "groq_generate_unsupported_message",
      message: "Pesan Stagehand tidak dapat dipetakan ke Groq.",
    });
    expect(stub.calls).toHaveLength(0);
  });

  it("rejects invalid JSON with a stable typed error and no retry", async () => {
    const stub = fetchStub(() =>
      jsonResponse({
        choices: [{ message: { role: "assistant", content: "bukan json" } }],
      }),
    );
    const generate = createGroqGenerate({
      model,
      apiKey,
      fetch: stub.fetch,
    });

    const error = await generate(generateRequest()).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(GroqError);
    expect(error).toMatchObject({
      name: "GroqError",
      code: "groq_generate_invalid_json",
      message: "Model Groq mengembalikan JSON yang tidak valid.",
    });
    expect(stub.calls).toHaveLength(1);
  });

  it("captures sanitized failure metadata from a 429 response", async () => {
    const bodyMarker = "raw-rate-limit-message";
    const stub = fetchStub(
      () =>
        new Response(
          JSON.stringify({
            error: {
              message: `${bodyMarker} ${apiKey}`,
              type: "tokens",
              code: "rate_limit_exceeded",
              metadata: {
                error_type: "invalid_request_error",
                provider_code: "groq.rate_limit",
                limit_source: "groq_tokens",
              },
            },
          }),
          {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": "20",
            },
          },
        ),
    );
    const generate = createGroqGenerate({
      model,
      apiKey,
      fetch: stub.fetch,
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const error = await generate(generateRequest()).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(GroqError);
    expect(error).toMatchObject({
      code: "groq_generate_failed",
      message: "Panggilan model Groq gagal.",
      httpStatus: 429,
      retryAfterSeconds: 20,
      errorType: "invalid_request_error",
      providerCode: "groq.rate_limit",
      limitSource: "groq_tokens",
    });

    const serialized = `${String(error)} ${JSON.stringify(error)}`;
    expect(serialized).not.toContain(bodyMarker);
    expect(serialized).not.toContain(apiKey);
    expect(serialized).not.toContain("Amati halaman ini.");

    const logged = [...log.mock.calls, ...warn.mock.calls, ...errorLog.mock.calls]
      .flat()
      .join(" ");
    expect(logged).not.toContain(bodyMarker);
    expect(logged).not.toContain(apiKey);
    expect(stub.calls).toHaveLength(1);
  });

  it.each([401, 400])(
    "keeps the HTTP status %i on a completion failure",
    async (status) => {
      const stub = fetchStub(() => new Response(null, { status }));
      const generate = createGroqGenerate({
        model,
        apiKey,
        fetch: stub.fetch,
      });

      const error = await generate(generateRequest()).catch((failure: unknown) => failure);

      expect(error).toMatchObject({
        name: "GroqError",
        code: "groq_generate_failed",
        httpStatus: status,
        retryAfterSeconds: null,
      });
      expect(stub.calls).toHaveLength(1);
    },
  );

  it("keeps the HTTP status when the failure body is not JSON", async () => {
    const bodyMarker = `provider denied ${apiKey}`;
    const stub = fetchStub(() => new Response(bodyMarker, { status: 403 }));
    const generate = createGroqGenerate({
      model,
      apiKey,
      fetch: stub.fetch,
    });

    const error = await generate(generateRequest()).catch((failure: unknown) => failure);

    expect(error).toMatchObject({
      httpStatus: 403,
      errorType: null,
      providerCode: null,
      limitSource: null,
    });
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(apiKey);
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(bodyMarker);
  });

  it("aborts a completion after sixty seconds without retrying", async () => {
    vi.useFakeTimers();
    const stub = fetchStub(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );
    const generate = createGroqGenerate({
      model,
      apiKey,
      fetch: stub.fetch,
    });

    const pending = generate(generateRequest());
    const assertion = expect(pending).rejects.toMatchObject({
      name: "GroqError",
      code: "groq_generate_timeout",
      message: "Panggilan model Groq melewati batas waktu.",
    });

    await vi.advanceTimersByTimeAsync(GROQ_GENERATE_TIMEOUT_MS - 1);
    expect(stub.calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(stub.calls).toHaveLength(1);
  });

  it("never logs the API key or prompt", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stub = fetchStub(() =>
      jsonResponse({
        choices: [{ message: { role: "assistant", content: "bukan json" } }],
      }),
    );
    const generate = createGroqGenerate({
      model,
      apiKey,
      fetch: stub.fetch,
    });

    await generate(generateRequest()).catch(() => undefined);

    const logged = [...log.mock.calls, ...warn.mock.calls, ...error.mock.calls]
      .flat()
      .join(" ");
    expect(logged).not.toContain(apiKey);
    expect(logged).not.toContain("Amati halaman ini.");
  });
});
