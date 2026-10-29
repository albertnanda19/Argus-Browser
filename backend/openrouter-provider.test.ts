import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientModelGenerate } from "./stagehand-runtime";
import {
  createOpenRouterGenerate,
  OPENROUTER_API_BASE,
  OPENROUTER_GENERATE_TIMEOUT_MS,
  OPENROUTER_VALIDATION_TIMEOUT_MS,
  OpenRouterError,
  validateOpenRouterCredentials,
} from "./openrouter-provider";

const apiKey = "unit-test-openrouter-key";
const model = "nvidia/nemotron-3.5-super-vl:free";

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

function structuredEndpoints(): Response {
  return jsonResponse({
    data: {
      endpoints: [
        { supported_parameters: ["temperature", "structured_outputs"] },
      ],
    },
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

describe("OpenRouter credential validation", () => {
  it("checks the key and a structured-output endpoint with the key in a header", async () => {
    const stub = fetchStub((call) =>
      call.input.endsWith("/key")
        ? jsonResponse({ data: { label: "test" } })
        : structuredEndpoints(),
    );

    const result = await validateOpenRouterCredentials({ model, apiKey }, stub.fetch);

    expect(result).toEqual({ ok: true });
    expect(stub.calls).toHaveLength(2);

    const [keyCall, modelCall] = stub.calls;
    if (keyCall === undefined || modelCall === undefined) {
      throw new Error("Expected two OpenRouter requests.");
    }

    expect(keyCall.input).toBe(`${OPENROUTER_API_BASE}/key`);
    expect(modelCall.input).toBe(`${OPENROUTER_API_BASE}/models/${model}/endpoints`);
    expect(modelCall.input).toContain(":free");
    expect(keyCall.input).not.toContain(apiKey);
    expect(modelCall.input).not.toContain(apiKey);

    for (const call of stub.calls) {
      const headers = new Headers(call.init?.headers);
      expect(call.init?.method).toBe("GET");
      expect(headers.get("Authorization")).toBe(`Bearer ${apiKey}`);
      expect(call.init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it.each([401, 403])("rejects a key the provider refuses with %i", async (status) => {
    const stub = fetchStub(() => new Response(null, { status }));

    const result = await validateOpenRouterCredentials({ model, apiKey }, stub.fetch);

    expect(result).toEqual({ ok: false, message: "API key OpenRouter ditolak." });
    expect(stub.calls).toHaveLength(1);
  });

  it("rejects a model whose endpoints return 404", async () => {
    const stub = fetchStub((call) =>
      call.input.endsWith("/key")
        ? new Response(null, { status: 200 })
        : new Response(null, { status: 404 }),
    );

    const result = await validateOpenRouterCredentials({ model, apiKey }, stub.fetch);

    expect(result).toEqual({
      ok: false,
      message: "Model OpenRouter tidak ditemukan.",
    });
    expect(stub.calls).toHaveLength(2);
  });

  it("rejects a model without a structured-output endpoint", async () => {
    const stub = fetchStub((call) =>
      call.input.endsWith("/key")
        ? new Response(null, { status: 200 })
        : jsonResponse({
            data: {
              endpoints: [
                { supported_parameters: ["temperature", "tools"] },
              ],
            },
          }),
    );

    const result = await validateOpenRouterCredentials({ model, apiKey }, stub.fetch);

    expect(result).toEqual({
      ok: false,
      message: "Model OpenRouter tidak mendukung structured output.",
    });
  });

  it.each([
    ["key 429", 429, "key"],
    ["key 500", 500, "key"],
    ["endpoints 429", 429, "endpoints"],
    ["endpoints 503", 503, "endpoints"],
  ])("reports transient failures for %s", async (_label, status, target) => {
    const stub = fetchStub((call) => {
      if (target === "key") {
        return new Response(null, { status });
      }
      return call.input.endsWith("/key")
        ? new Response(null, { status: 200 })
        : new Response(null, { status });
    });

    const result = await validateOpenRouterCredentials({ model, apiKey }, stub.fetch);

    expect(result).toEqual({
      ok: false,
      message: "Layanan OpenRouter sedang tidak tersedia.",
    });
    expect(stub.calls).toHaveLength(target === "key" ? 1 : 2);
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

    const pending = validateOpenRouterCredentials({ model, apiKey }, stub.fetch);
    await vi.advanceTimersByTimeAsync(OPENROUTER_VALIDATION_TIMEOUT_MS - 1);
    expect(stub.calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;

    expect(result).toEqual({
      ok: false,
      message: "OpenRouter tidak dapat dihubungi.",
    });
    expect(stub.calls).toHaveLength(1);
  });

  it("reports a network failure once without leaking the key", async () => {
    const stub = fetchStub(() => {
      throw new Error(`connect ECONNREFUSED ${apiKey}`);
    });

    const result = await validateOpenRouterCredentials({ model, apiKey }, stub.fetch);

    expect(result).toEqual({
      ok: false,
      message: "OpenRouter tidak dapat dihubungi.",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).not.toContain(apiKey);
    }
    expect(stub.calls).toHaveLength(1);
  });
});

describe("OpenRouter generate callback", () => {
  it("maps text and image messages and returns structured content", async () => {
    const stub = fetchStub(() =>
      jsonResponse({
        choices: [{ message: { role: "assistant", content: '{"ok":true}' } }],
      }),
    );
    const generate = createOpenRouterGenerate({
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
      throw new Error("Expected one OpenRouter request.");
    }

    expect(call.input).toBe(`${OPENROUTER_API_BASE}/chat/completions`);
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
      provider: { require_parameters: boolean; allow_fallbacks: boolean };
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
    expect(body.provider).toEqual({
      require_parameters: true,
      allow_fallbacks: false,
    });
    expect(String(call.init?.body)).not.toContain(apiKey);
  });

  it("rejects invalid JSON with a stable typed error and no retry", async () => {
    const stub = fetchStub(() =>
      jsonResponse({
        choices: [{ message: { role: "assistant", content: "bukan json" } }],
      }),
    );
    const generate = createOpenRouterGenerate({
      model,
      apiKey,
      fetch: stub.fetch,
    });

    const error = await generate(generateRequest()).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(OpenRouterError);
    expect(error).toMatchObject({
      name: "OpenRouterError",
      code: "openrouter_generate_invalid_json",
      message: "Model OpenRouter mengembalikan JSON yang tidak valid.",
    });
    expect(String(error)).not.toContain(apiKey);
    expect(stub.calls).toHaveLength(1);
  });

  it("rejects a non-2xx completion without retrying", async () => {
    const stub = fetchStub(() => new Response(null, { status: 500 }));
    const generate = createOpenRouterGenerate({
      model,
      apiKey,
      fetch: stub.fetch,
    });

    await expect(generate(generateRequest())).rejects.toMatchObject({
      name: "OpenRouterError",
      code: "openrouter_generate_failed",
      message: "Panggilan model OpenRouter gagal.",
    });
    expect(stub.calls).toHaveLength(1);
  });

  it("captures sanitized failure metadata from a 402 response", async () => {
    const bodyMarker = "raw-credit-message";
    const stub = fetchStub(
      () =>
        new Response(
          JSON.stringify({
            error: {
              message: `${bodyMarker} ${apiKey}`,
              type: "insufficient_credits",
              metadata: {
                error_type: "invalid_request_error",
                provider_code: "openrouter.insufficient_credits",
                limit_source: "openrouter_credits",
              },
            },
          }),
          { status: 402, headers: { "Content-Type": "application/json" } },
        ),
    );
    const generate = createOpenRouterGenerate({
      model,
      apiKey,
      fetch: stub.fetch,
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const error = await generate(generateRequest()).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(OpenRouterError);
    expect(error).toMatchObject({
      code: "openrouter_generate_failed",
      message: "Panggilan model OpenRouter gagal.",
      httpStatus: 402,
      retryAfterSeconds: null,
      errorType: "invalid_request_error",
      providerCode: "openrouter.insufficient_credits",
      limitSource: "openrouter_credits",
    });

    const serialized = `${String(error)} ${JSON.stringify(error)}`;
    expect(serialized).not.toContain(bodyMarker);
    expect(serialized).not.toContain(apiKey);

    const logged = [...log.mock.calls, ...warn.mock.calls, ...errorLog.mock.calls]
      .flat()
      .join(" ");
    expect(logged).not.toContain(bodyMarker);
    expect(logged).not.toContain(apiKey);
  });

  it("falls back to error.type and drops unsafe metadata values", async () => {
    const stub = fetchStub(
      () =>
        new Response(
          JSON.stringify({
            error: {
              type: "safe_error_type",
              metadata: {
                error_type: "unsafe type",
                provider_code: "provider code!",
                limit_source: "openrouter_credits\n",
              },
            },
          }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        ),
    );
    const generate = createOpenRouterGenerate({
      model,
      apiKey,
      fetch: stub.fetch,
    });

    const error = await generate(generateRequest()).catch((failure: unknown) => failure);

    expect(error).toMatchObject({
      httpStatus: 403,
      errorType: "safe_error_type",
      providerCode: null,
      limitSource: null,
    });
  });

  it("reads Retry-After seconds, HTTP dates, and caps the delay", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-29T00:00:00.000Z"));
    const responses = [
      new Response(null, { status: 429, headers: { "Retry-After": "20" } }),
      new Response(null, {
        status: 429,
        headers: { "Retry-After": "Thu, 29 Oct 2026 01:00:00 GMT" },
      }),
      new Response(null, { status: 429, headers: { "Retry-After": "999999" } }),
    ];
    const stub = fetchStub(
      () => responses.shift() ?? new Response(null, { status: 500 }),
    );
    const generate = createOpenRouterGenerate({
      model,
      apiKey,
      fetch: stub.fetch,
    });

    const seconds = await generate(generateRequest()).catch((failure: unknown) => failure);
    const date = await generate(generateRequest()).catch((failure: unknown) => failure);
    const capped = await generate(generateRequest()).catch((failure: unknown) => failure);

    expect(seconds).toMatchObject({ retryAfterSeconds: 20 });
    expect(date).toMatchObject({ retryAfterSeconds: 3_600 });
    expect(capped).toMatchObject({ retryAfterSeconds: 86_400 });
  });

  it.each(["soon", "-5", "20s"])(
    "ignores an invalid Retry-After value %s",
    async (value) => {
      const stub = fetchStub(
        () =>
          new Response(null, {
            status: 429,
            headers: { "Retry-After": value },
          }),
      );
      const generate = createOpenRouterGenerate({
        model,
        apiKey,
        fetch: stub.fetch,
      });

      const error = await generate(generateRequest()).catch((failure: unknown) => failure);

      expect(error).toMatchObject({
        httpStatus: 429,
        retryAfterSeconds: null,
      });
    },
  );

  it("keeps the HTTP status when the failure body is not JSON", async () => {
    const bodyMarker = `provider denied ${apiKey}`;
    const stub = fetchStub(() => new Response(bodyMarker, { status: 403 }));
    const generate = createOpenRouterGenerate({
      model,
      apiKey,
      fetch: stub.fetch,
    });

    const error = await generate(generateRequest()).catch((failure: unknown) => failure);

    expect(error).toMatchObject({
      httpStatus: 403,
      retryAfterSeconds: null,
      errorType: null,
      providerCode: null,
      limitSource: null,
    });
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(apiKey);
  });

  it("keeps the HTTP status when the failure body exceeds the size limit", async () => {
    const stub = fetchStub(
      () => new Response("x".repeat(32 * 1024), { status: 402 }),
    );
    const generate = createOpenRouterGenerate({
      model,
      apiKey,
      fetch: stub.fetch,
    });

    const error = await generate(generateRequest()).catch((failure: unknown) => failure);

    expect(error).toMatchObject({
      httpStatus: 402,
      retryAfterSeconds: null,
      errorType: null,
      providerCode: null,
      limitSource: null,
    });
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
    const generate = createOpenRouterGenerate({
      model,
      apiKey,
      fetch: stub.fetch,
    });

    const pending = generate(generateRequest());
    const assertion = expect(pending).rejects.toMatchObject({
      name: "OpenRouterError",
      code: "openrouter_generate_timeout",
      message: "Panggilan model OpenRouter melewati batas waktu.",
    });

    await vi.advanceTimersByTimeAsync(OPENROUTER_GENERATE_TIMEOUT_MS - 1);
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
    const generate = createOpenRouterGenerate({
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
