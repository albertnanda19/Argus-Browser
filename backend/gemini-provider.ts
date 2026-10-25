import type { ProviderCredentialInput, ProviderValidation } from "./provider-registry";

export const GEMINI_MODEL_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models";

export const GEMINI_VALIDATION_TIMEOUT_MS = 15_000;

const MODEL_MESSAGE =
  "Model Gemini tidak ditemukan atau tidak tersedia untuk API key ini. Periksa kembali id model.";
const CREDENTIAL_MESSAGE =
  "API key Gemini ditolak atau tidak memiliki akses. Periksa kembali key dan izinnya.";
const TIMEOUT_MESSAGE =
  "Validasi ke Gemini melewati batas 15 detik. Periksa koneksi internet lalu coba lagi.";
const UNREACHABLE_MESSAGE =
  "Gemini tidak dapat dihubungi. Periksa koneksi internet lalu coba lagi.";
const TEMPORARY_MESSAGE =
  "Gemini tidak dapat memvalidasi kredensial saat ini. Coba lagi beberapa saat lagi.";

export type GeminiValidator = (
  input: ProviderCredentialInput,
) => Promise<ProviderValidation>;

export async function validateGeminiCredentials(
  input: ProviderCredentialInput,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<ProviderValidation> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEMINI_VALIDATION_TIMEOUT_MS);

  try {
    const response = await fetchFn(
      `${GEMINI_MODEL_ENDPOINT}/${encodeURIComponent(input.model)}`,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          "x-goog-api-key": input.apiKey,
        },
        signal: controller.signal,
      },
    );

    if (response.ok) {
      return { ok: true };
    }

    if (response.status === 404) {
      return { ok: false, message: MODEL_MESSAGE };
    }

    if (
      response.status === 400 ||
      response.status === 401 ||
      response.status === 403
    ) {
      return { ok: false, message: CREDENTIAL_MESSAGE };
    }

    return { ok: false, message: TEMPORARY_MESSAGE };
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === "AbortError";
    return { ok: false, message: isTimeout ? TIMEOUT_MESSAGE : UNREACHABLE_MESSAGE };
  } finally {
    clearTimeout(timeout);
  }
}
