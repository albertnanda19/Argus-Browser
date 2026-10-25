import {
  providerConfigRequestSchema,
  type ProviderConfig,
  type ProviderConfigRequest,
} from "../shared/provider";
import { ProviderError } from "./provider-errors";
import type { ProviderRegistry } from "./provider-registry";
import {
  readStoredProviderConfig,
  writeStoredProviderConfig,
  type StoredProviderConfig,
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

function toPublicConfig(config: StoredProviderConfig | null): ProviderConfig {
  if (config === null) {
    return { provider: null, model: null, configured: false, updatedAt: null };
  }

  return {
    provider: config.provider,
    model: config.model,
    configured: true,
    updatedAt: config.updatedAt,
  };
}

export async function createProviderService(
  options: ProviderServiceOptions,
): Promise<ProviderService> {
  const read = await readStoredProviderConfig(options.appDataDir);

  if (read.status === "invalid") {
    console.warn("Provider configuration is invalid; treating as unconfigured.");
  }

  let active = read.status === "ok" ? read.config : null;
  let writeTail: Promise<unknown> = Promise.resolve();
  const now = options.now ?? (() => new Date());

  return {
    getConfig: () => toPublicConfig(active),
    getActive: () => (active === null ? null : { ...active }),
    setConfig(input) {
      const run = async (): Promise<ProviderConfig> => {
        const request = providerConfigRequestSchema.parse(input);
        const adapter = options.registry.get(request.provider);

        if (adapter === null) {
          throw new ProviderError("provider_unknown");
        }

        const validation = await adapter.validateCredentials({
          model: request.model,
          apiKey: request.apiKey,
        });

        if (!validation.ok) {
          throw new ProviderError("provider_validation_failed", validation.message);
        }

        const stored: StoredProviderConfig = {
          provider: adapter.id,
          model: request.model,
          apiKey: request.apiKey,
          updatedAt: now().toISOString(),
        };

        await writeStoredProviderConfig(options.appDataDir, stored);
        active = stored;
        return toPublicConfig(stored);
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
