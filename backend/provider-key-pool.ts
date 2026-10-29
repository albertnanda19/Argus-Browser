import { createHash } from "node:crypto";
import type { ProviderKeyState, ProviderKeyStatus } from "../shared/provider";

const RATE_LIMIT_COOLDOWN_SECONDS = 60;
const QUOTA_COOLDOWN_SECONDS = 3_600;

export type ProviderKeyFailureKind =
  | "quota_exhausted"
  | "rate_limited"
  | "credits_exhausted"
  | "auth_or_key";

export type ProviderKeySelection =
  | {
      readonly status: "selected";
      readonly keyId: string;
      readonly apiKey: string;
    }
  | { readonly status: "cooldown"; readonly retryAfterSeconds: number }
  | { readonly status: "rejected" };

export type ProviderKeyPool = {
  list(): readonly ProviderKeyState[];
  select(): ProviderKeySelection;
  markFailure(
    keyId: string,
    kind: ProviderKeyFailureKind,
    retryDelaySeconds: number | null,
  ): void;
};

export type ProviderKeyPoolOptions = {
  readonly now?: () => Date;
};

type KeyEntry = {
  readonly id: string;
  readonly apiKey: string;
  status: ProviderKeyStatus;
  cooldownUntilMs: number | null;
  lastUsedAtMs: number | null;
};

export function providerKeyId(apiKey: string): string {
  return `k_${createHash("sha256").update(apiKey).digest("hex").slice(0, 12)}`;
}

export function normalizeProviderApiKeys(apiKeys: readonly string[]): string[] {
  return [...new Set(apiKeys)];
}

function refresh(entry: KeyEntry, nowMs: number): void {
  if (
    entry.status === "cooldown" &&
    entry.cooldownUntilMs !== null &&
    entry.cooldownUntilMs <= nowMs
  ) {
    entry.status = "ready";
    entry.cooldownUntilMs = null;
  }
}

function toState(entry: KeyEntry): ProviderKeyState {
  return {
    id: entry.id,
    status: entry.status,
    cooldownUntil:
      entry.cooldownUntilMs === null
        ? null
        : new Date(entry.cooldownUntilMs).toISOString(),
    lastUsedAt:
      entry.lastUsedAtMs === null
        ? null
        : new Date(entry.lastUsedAtMs).toISOString(),
  };
}

export function createProviderKeyPool(
  apiKeys: readonly string[],
  options: ProviderKeyPoolOptions = {},
): ProviderKeyPool {
  const now = options.now ?? (() => new Date());
  const entries: KeyEntry[] = normalizeProviderApiKeys(apiKeys).map((apiKey) => ({
    id: providerKeyId(apiKey),
    apiKey,
    status: "ready",
    cooldownUntilMs: null,
    lastUsedAtMs: null,
  }));

  return {
    list() {
      const nowMs = now().getTime();
      for (const entry of entries) {
        refresh(entry, nowMs);
      }
      return entries.map(toState);
    },
    select() {
      const nowMs = now().getTime();
      for (const entry of entries) {
        refresh(entry, nowMs);
      }

      const ready = entries
        .filter((entry) => entry.status === "ready")
        .sort(
          (left, right) =>
            (left.lastUsedAtMs ?? -Infinity) - (right.lastUsedAtMs ?? -Infinity),
        );
      const selected = ready[0];
      if (selected !== undefined) {
        selected.lastUsedAtMs = nowMs;
        return {
          status: "selected",
          keyId: selected.id,
          apiKey: selected.apiKey,
        };
      }

      const cooldownUntil = entries
        .filter((entry) => entry.status === "cooldown")
        .map((entry) => entry.cooldownUntilMs ?? nowMs)
        .reduce<number | null>(
          (nearest, value) => (nearest === null || value < nearest ? value : nearest),
          null,
        );

      if (cooldownUntil !== null) {
        return {
          status: "cooldown",
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((cooldownUntil - nowMs) / 1_000),
          ),
        };
      }

      return { status: "rejected" };
    },
    markFailure(keyId, kind, retryDelaySeconds) {
      const entry = entries.find((candidate) => candidate.id === keyId);
      if (entry === undefined) {
        return;
      }

      if (kind === "auth_or_key") {
        entry.status = "auth_failed";
        entry.cooldownUntilMs = null;
        return;
      }

      const defaultSeconds =
        kind === "rate_limited"
          ? RATE_LIMIT_COOLDOWN_SECONDS
          : QUOTA_COOLDOWN_SECONDS;
      const seconds = Math.max(0, retryDelaySeconds ?? defaultSeconds);
      entry.status = "cooldown";
      entry.cooldownUntilMs = now().getTime() + seconds * 1_000;
    },
  };
}
