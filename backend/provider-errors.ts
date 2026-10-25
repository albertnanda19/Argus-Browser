import type { ProviderErrorCode } from "../shared/provider";

export const PROVIDER_ERROR_MESSAGES: Record<ProviderErrorCode, string> = {
  provider_unknown: "Provider model tidak dikenal.",
  provider_validation_failed: "Validasi kredensial provider gagal.",
};

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;

  constructor(code: ProviderErrorCode, message?: string) {
    super(message ?? PROVIDER_ERROR_MESSAGES[code]);
    this.name = "ProviderError";
    this.code = code;
  }
}
