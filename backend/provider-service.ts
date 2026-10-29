import {
  providerConfigRequestSchema,
  providerIdSchema,
  type ProviderConfig,
  type ProviderConfigRequest,
  type ProviderId,
  type ProviderKeyState,
} from "../shared/provider";
import { ProviderError } from "./provider-errors";
import {
  createProviderKeyPool,
  normalizeProviderApiKeys,
  type ProviderKeyFailureKind,
  type ProviderKeyPool,
  type ProviderKeySelection,
} from "./provider-key-pool";
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
  acquireKey(provider: ProviderId): ProviderKeySelection;
  markKeyFailure(
    provider: ProviderId,
    keyId: string,
    kind: ProviderKeyFailureKind,
    retryDelaySeconds: number | null,
  ): void;
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

function toPublicConfig(
  state: StoredProviderFile | null,
  keys: ProviderKeyState[],
): ProviderConfig {
  if (state === null) {
    return {
      provider: null,
      model: null,
      configured: false,
      updatedAt: null,
      available: [],
      keys: [],
    };
  }

  const entry = state.configs[state.active];

  return {
    provider: state.active,
    model: entry?.model ?? null,
    configured: entry !== undefined,
    updatedAt: entry?.updatedAt ?? null,
    available: availableProviders(state),
    keys,
  };
}

function toActiveConfig(
  state: StoredProviderFile | null,
): StoredProviderConfig | null {
  if (state === null) {
    return null;
  }

  const entry = state.configs[state.active];
  if (entry === undefined) {
    return null;
  }

  return {
    provider: state.active,
    model: entry.model,
    apiKeys: [...entry.apiKeys],
    updatedAt: entry.updatedAt,
  };
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
  const keyPools = new Map<ProviderId, ProviderKeyPool>();

  if (state !== null) {
    for (const id of providerIdSchema.options) {
      const entry = state.configs[id];
      if (entry !== undefined) {
        keyPools.set(id, createProviderKeyPool(entry.apiKeys, { now }));
      }
    }
  }

  const keysFor = (provider: ProviderId | null): ProviderKeyState[] => {
    if (provider === null) {
      return [];
    }

    return [...(keyPools.get(provider)?.list() ?? [])];
  };

  return {
    getConfig: () => toPublicConfig(state, keysFor(state?.active ?? null)),
    getActive: () => toActiveConfig(state),
    acquireKey(provider) {
      const pool = keyPools.get(provider);
      return pool?.select() ?? { status: "rejected" };
    },
    markKeyFailure(provider, keyId, kind, retryDelaySeconds) {
      keyPools.get(provider)?.markFailure(keyId, kind, retryDelaySeconds);
    },
    setConfig(input) {
      const run = async (): Promise<ProviderConfig> => {
        const request = providerConfigRequestSchema.parse(input);
        const adapter = options.registry.get(request.provider);

        if (adapter === null) {
          throw new ProviderError("provider_unknown");
        }

        const stored = state?.configs[adapter.id];
        const explicitApiKeys =
          request.apiKeys ??
          (request.apiKey === undefined ? null : [request.apiKey]);
        const apiKeys =
          explicitApiKeys === null
            ? stored?.apiKeys
            : normalizeProviderApiKeys(explicitApiKeys);

        if (apiKeys === undefined) {
          throw new ProviderError("provider_api_key_required");
        }

        for (const apiKey of apiKeys) {
          const validation = await adapter.validateCredentials({
            model: request.model,
            apiKey,
          });

          if (!validation.ok) {
            throw new ProviderError("provider_validation_failed", validation.message);
          }
        }

        const entry: StoredProviderEntry = {
          model: request.model,
          apiKeys,
          updatedAt: now().toISOString(),
        };
        const next: StoredProviderFile = {
          active: adapter.id,
          configs: { ...state?.configs, [adapter.id]: entry },
        };

        await writeStoredProviderConfig(options.appDataDir, next);
        state = next;

        if (explicitApiKeys !== null || !keyPools.has(adapter.id)) {
          keyPools.set(adapter.id, createProviderKeyPool(apiKeys, { now }));
        }

        return toPublicConfig(next, keysFor(adapter.id));
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
