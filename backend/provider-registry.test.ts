import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GEMINI_MODEL_ENDPOINT,
  GEMINI_VALIDATION_TIMEOUT_MS,
  validateGeminiCredentials,
} from "./gemini-provider";
import { createProviderRegistry, type ProviderValidation } from "./provider-registry";

const apiKey = "unit-test-gemini-key";
const model = "gemini-2.5-flash";

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

afterEach(() => {
  vi.useRealTimers();
});

describe("Gemini credential validation", () => {
  it("calls the official model endpoint once with the key in a header", async () => {
    const stub = fetchStub(() => new Response(null, { status: 200 }));

    const result = await validateGeminiCredentials({ model, apiKey }, stub.fetch);

    expect(result).toEqual({ ok: true });
    expect(stub.calls).toHaveLength(1);

    const call = stub.calls[0];
    if (call === undefined) {
      throw new Error("Expected one Gemini request.");
    }

    const headers = new Headers(call.init?.headers);

    expect(call.input).toBe(`${GEMINI_MODEL_ENDPOINT}/${model}`);
    expect(call.input).not.toContain(apiKey);
    expect(call.input).not.toContain("key=");
    expect(call.init?.method).toBe("GET");
    expect(headers.get("x-goog-api-key")).toBe(apiKey);
    expect(call.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects an unknown or unavailable model with 422-compatible detail", async () => {
    const stub = fetchStub(() => new Response(null, { status: 404 }));

    const result = await validateGeminiCredentials({ model, apiKey }, stub.fetch);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected validation to fail.");
    }
    expect(result.message).toContain("Model");
    expect(result.message).not.toContain(apiKey);
  });

  it("rejects a key the provider refuses", async () => {
    const stub = fetchStub(() => new Response(null, { status: 403 }));

    const result = await validateGeminiCredentials({ model, apiKey }, stub.fetch);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected validation to fail.");
    }
    expect(result.message).toContain("API key");
    expect(result.message).not.toContain(apiKey);
  });

  it("reports a temporary provider failure with a next step", async () => {
    const stub = fetchStub(() => new Response(null, { status: 429 }));

    const result = await validateGeminiCredentials({ model, apiKey }, stub.fetch);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected validation to fail.");
    }
    expect(result.message).toContain("Coba lagi");
    expect(result.message).not.toContain(apiKey);
    expect(result.message).not.toContain("API key Gemini ditolak");
  });

  it("reports a network failure with a next step", async () => {
    const stub = fetchStub(() => {
      throw new Error(`connect ECONNREFUSED ${apiKey}`);
    });

    const result = await validateGeminiCredentials({ model, apiKey }, stub.fetch);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected validation to fail.");
    }
    expect(result.message).toContain("koneksi");
    expect(result.message).not.toContain(apiKey);
    expect(stub.calls).toHaveLength(1);
  });

  it("aborts a validation that exceeds 15 seconds without retrying", async () => {
    vi.useFakeTimers();
    const stub = fetchStub(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );

    const pending = validateGeminiCredentials({ model, apiKey }, stub.fetch);
    await vi.advanceTimersByTimeAsync(GEMINI_VALIDATION_TIMEOUT_MS - 1);
    expect(stub.calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected validation to fail.");
    }
    expect(result.message).toContain("15 detik");
    expect(stub.calls).toHaveLength(1);
  });
});

describe("provider registry", () => {
  it("registers only Gemini and maps models for Stagehand", () => {
    const validate = vi.fn(
      async (): Promise<ProviderValidation> => ({ ok: true }),
    );
    const registry = createProviderRegistry({ validateGemini: validate });
    const adapter = registry.get("gemini");

    expect(adapter?.id).toBe("gemini");
    expect(adapter?.toStagehandModelName(model)).toBe(`google/${model}`);
    expect(registry.get("openai")).toBeNull();
    expect(validate).not.toHaveBeenCalled();
  });

  it("uses the injected validator instead of the network", async () => {
    const validate = vi.fn(
      async (): Promise<ProviderValidation> => ({ ok: false, message: "Ditolak." }),
    );
    const registry = createProviderRegistry({ validateGemini: validate });
    const adapter = registry.get("gemini");

    await expect(
      adapter?.validateCredentials({ model, apiKey }),
    ).resolves.toEqual({ ok: false, message: "Ditolak." });
    expect(validate).toHaveBeenCalledWith({ model, apiKey });
  });
});
