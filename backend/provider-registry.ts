import type { ProviderId } from "../shared/provider";
import { validateGeminiCredentials, type GeminiValidator } from "./gemini-provider";
import {
  createGroqGenerate,
  validateGroqCredentials,
  type GroqValidator,
} from "./groq-provider";
import {
  createOpenRouterGenerate,
  validateOpenRouterCredentials,
  type OpenRouterValidator,
} from "./openrouter-provider";
import type { StagehandModelConfig } from "./stagehand-runtime";

export type ProviderCredentialInput = {
  readonly model: string;
  readonly apiKey: string;
};

export type ProviderValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export type ProviderModelConfig = StagehandModelConfig;

export type ProviderAdapter = {
  readonly id: ProviderId;
  createModelConfig(input: ProviderCredentialInput): ProviderModelConfig;
  validateCredentials(input: ProviderCredentialInput): Promise<ProviderValidation>;
};

export type ProviderRegistry = {
  get(id: string): ProviderAdapter | null;
};

export type ProviderRegistryOptions = {
  readonly validateGemini?: GeminiValidator;
  readonly validateOpenRouter?: OpenRouterValidator;
  readonly validateGroq?: GroqValidator;
};

export function createProviderRegistry(
  options: ProviderRegistryOptions = {},
): ProviderRegistry {
  const validateGemini = options.validateGemini ?? validateGeminiCredentials;
  const validateOpenRouter =
    options.validateOpenRouter ?? validateOpenRouterCredentials;
  const validateGroq = options.validateGroq ?? validateGroqCredentials;
  const adapters = new Map<string, ProviderAdapter>([
    [
      "gemini",
      {
        id: "gemini",
        createModelConfig: ({ model, apiKey }) => ({
          kind: "native",
          modelName: `google/${model}`,
          apiKey,
        }),
        validateCredentials: validateGemini,
      },
    ],
    [
      "openrouter",
      {
        id: "openrouter",
        createModelConfig: ({ model, apiKey }) => ({
          kind: "client",
          generate: createOpenRouterGenerate({ model, apiKey }),
        }),
        validateCredentials: validateOpenRouter,
      },
    ],
    [
      "groq",
      {
        id: "groq",
        createModelConfig: ({ model, apiKey }) => ({
          kind: "client",
          generate: createGroqGenerate({ model, apiKey }),
        }),
        validateCredentials: validateGroq,
      },
    ],
  ]);

  return {
    get(id) {
      return adapters.get(id) ?? null;
    },
  };
}
