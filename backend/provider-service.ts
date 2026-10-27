import {
  providerConfigRequestSchema,
  providerIdSchema,
  type ProviderConfig,
  type ProviderConfigRequest,
  type ProviderId,
} from "../shared/provider";
import { ProviderError } from "./provider-errors";
import type { ProviderRegistry } from "./provider-registry";
import {
  readStoredProviderConfig,
  writeStoredProviderConfig,
  type StoredProviderConfig,
  type StoredProviderEntry,
  type StoredProviderFile,
} from "./provider-store";

export type ProviderService = {
  getConfig(): ProviderConfig;
  getActive(): StoredProviderConfig | null;
  setConfig(input: ProviderConfigRequest): Promise<ProviderConfig>;
};

export type ProviderServiceOptions = {
  readonly appDataDir: string;
  readonly registry: ProviderRegistry;
  readonly now?: () => Date;
};

function availableProviders(state: StoredProviderFile | null): ProviderId[] {
  if (state === null) {
    return [];
  }

  return providerIdSchema.options.filter(
    (id) => state.configs[id] !== undefined,
  );
}

function toPublicConfig(state: StoredProviderFile | null): ProviderConfig {
  if (state === null) {
    return {
      provider: null,
      model: null,
      configured: false,
      updatedAt: null,
      available: [],
    };
  }

  const entry = state.configs[state.active];

  return {
    provider: state.active,
    model: entry?.model ?? null,
    configured: entry !== undefined,
    updatedAt: entry?.updatedAt ?? null,
    available: availableProviders(state),
  };
}

function toActiveConfig(state: StoredProviderFile | null): StoredProviderConfig | null {
  if (state === null) {
    return null;
  }

  const entry = state.configs[state.active];
  if (entry === undefined) {
    return null;
  }

  return { provider: state.active, ...entry };
}

export async function createProviderService(
  options: ProviderServiceOptions,
): Promise<ProviderService> {
  const read = await readStoredProviderConfig(options.appDataDir);

  if (read.status === "invalid") {
    console.warn("Provider configuration is invalid; treating as unconfigured.");
  }

  let state = read.status === "ok" ? read.config : null;
  let writeTail: Promise<unknown> = Promise.resolve();
  const now = options.now ?? (() => new Date());

  return {
    getConfig: () => toPublicConfig(state),
    getActive: () => toActiveConfig(state),
    setConfig(input) {
      const run = async (): Promise<ProviderConfig> => {
        const request = providerConfigRequestSchema.parse(input);
        const adapter = options.registry.get(request.provider);

        if (adapter === null) {
          throw new ProviderError("provider_unknown");
        }

        const stored = state?.configs[adapter.id];
        const apiKey = request.apiKey ?? stored?.apiKey;

        if (apiKey === undefined) {
          throw new ProviderError("provider_api_key_required");
        }

        const validation = await adapter.validateCredentials({
          model: request.model,
          apiKey,
        });

        if (!validation.ok) {
          throw new ProviderError("provider_validation_failed", validation.message);
        }

        const entry: StoredProviderEntry = {
          model: request.model,
          apiKey,
          updatedAt: now().toISOString(),
        };
        const next: StoredProviderFile = {
          active: adapter.id,
          configs: { ...state?.configs, [adapter.id]: entry },
        };

        await writeStoredProviderConfig(options.appDataDir, next);
        state = next;
        return toPublicConfig(next);
      };

      const current = writeTail.catch(() => undefined).then(run);
      writeTail = current.then(
        () => undefined,
        () => undefined,
      );
      return current;
    },
  };
}
