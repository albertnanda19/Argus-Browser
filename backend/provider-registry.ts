import type { ProviderId } from "../shared/provider";
import { validateGeminiCredentials, type GeminiValidator } from "./gemini-provider";

export type ProviderCredentialInput = {
  readonly model: string;
  readonly apiKey: string;
};

export type ProviderValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export type ProviderAdapter = {
  readonly id: ProviderId;
  toStagehandModelName(model: string): string;
  validateCredentials(input: ProviderCredentialInput): Promise<ProviderValidation>;
};

export type ProviderRegistry = {
  get(id: string): ProviderAdapter | null;
};

export type ProviderRegistryOptions = {
  readonly validateGemini?: GeminiValidator;
};

export function createProviderRegistry(
  options: ProviderRegistryOptions = {},
): ProviderRegistry {
  const validateGemini = options.validateGemini ?? validateGeminiCredentials;
  const adapters = new Map<string, ProviderAdapter>([
    [
      "gemini",
      {
        id: "gemini",
        toStagehandModelName: (model) => `google/${model}`,
        validateCredentials: validateGemini,
      },
    ],
  ]);

  return {
    get(id) {
      return adapters.get(id) ?? null;
    },
  };
}
