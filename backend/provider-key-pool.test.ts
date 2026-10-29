import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ProviderKeyState } from "../shared/provider";
import {
  createProviderKeyPool,
  providerKeyId,
  type ProviderKeySelection,
} from "./provider-key-pool";

const firstKey = "unit-test-key-first";
const secondKey = "unit-test-key-second";
const thirdKey = "unit-test-key-third";

function expectedId(apiKey: string): string {
  return `k_${createHash("sha256").update(apiKey).digest("hex").slice(0, 12)}`;
}

function selected(selection: ProviderKeySelection): {
  readonly keyId: string;
  readonly apiKey: string;
} {
  if (selection.status !== "selected") {
    throw new Error(`Expected a selected key, got ${selection.status}.`);
  }
  return selection;
}

function states(pool: ReturnType<typeof createProviderKeyPool>): readonly ProviderKeyState[] {
  return pool.list();
}

function stateOf(
  pool: ReturnType<typeof createProviderKeyPool>,
  apiKey: string,
): ProviderKeyState {
  const state = pool
    .list()
    .find((entry) => entry.id === providerKeyId(apiKey));
  if (state === undefined) {
    throw new Error("Expected a key state.");
  }
  return state;
}

function createClock(start: Date) {
  let current = start;
  return {
    now: () => current,
    advance(seconds: number) {
      current = new Date(current.getTime() + seconds * 1_000);
    },
  };
}

const start = new Date("2026-10-29T10:00:00.000Z");

describe("provider key pool", () => {
  it("derives a stable opaque id from the key", () => {
    const pool = createProviderKeyPool([firstKey]);

    expect(pool.list()).toEqual([
      {
        id: expectedId(firstKey),
        status: "ready",
        cooldownUntil: null,
        lastUsedAt: null,
      },
    ]);
    expect(pool.list()[0]?.id).toMatch(/^k_[0-9a-f]{12}$/);
    expect(JSON.stringify(pool.list())).not.toContain(firstKey);
  });

  it("keeps ids stable across pools and distinct across keys", () => {
    const first = createProviderKeyPool([firstKey, secondKey]);
    const second = createProviderKeyPool([firstKey, secondKey]);

    expect(first.list().map((entry) => entry.id)).toEqual(
      second.list().map((entry) => entry.id),
    );
    expect(providerKeyId(firstKey)).not.toBe(providerKeyId(secondKey));
  });

  it("dedupes keys while preserving first-seen order", () => {
    const pool = createProviderKeyPool([firstKey, secondKey, firstKey, thirdKey]);

    expect(pool.list().map((entry) => entry.id)).toEqual([
      providerKeyId(firstKey),
      providerKeyId(secondKey),
      providerKeyId(thirdKey),
    ]);
  });

  it("selects the ready key with the oldest lastUsedAt", () => {
    const clock = createClock(start);
    const pool = createProviderKeyPool([firstKey, secondKey], { now: clock.now });

    const initial = selected(pool.select());
    expect(initial.apiKey).toBe(firstKey);
    expect(stateOf(pool, firstKey).lastUsedAt).toBe(start.toISOString());

    clock.advance(10);
    const next = selected(pool.select());
    expect(next.apiKey).toBe(secondKey);
    expect(stateOf(pool, secondKey).lastUsedAt).toBe(
      new Date(start.getTime() + 10_000).toISOString(),
    );

    clock.advance(10);
    expect(selected(pool.select()).apiKey).toBe(firstKey);
  });

  it("cools a key down for the provider retry delay", () => {
    const clock = createClock(start);
    const pool = createProviderKeyPool([firstKey, secondKey], { now: clock.now });
    const first = selected(pool.select());

    pool.markFailure(first.keyId, "quota_exhausted", 120);

    expect(stateOf(pool, firstKey)).toEqual({
      id: providerKeyId(firstKey),
      status: "cooldown",
      cooldownUntil: new Date(start.getTime() + 120_000).toISOString(),
      lastUsedAt: start.toISOString(),
    });
    expect(selected(pool.select()).apiKey).toBe(secondKey);
  });

  it("uses sixty seconds for a rate limit without a retry delay", () => {
    const clock = createClock(start);
    const pool = createProviderKeyPool([firstKey], { now: clock.now });
    const first = selected(pool.select());

    pool.markFailure(first.keyId, "rate_limited", null);

    expect(stateOf(pool, firstKey).cooldownUntil).toBe(
      new Date(start.getTime() + 60_000).toISOString(),
    );
  });

  it("uses one hour for quota and credit exhaustion without a retry delay", () => {
    const clock = createClock(start);
    const pool = createProviderKeyPool([firstKey], { now: clock.now });
    const first = selected(pool.select());

    pool.markFailure(first.keyId, "quota_exhausted", null);
    expect(stateOf(pool, firstKey).cooldownUntil).toBe(
      new Date(start.getTime() + 3_600_000).toISOString(),
    );

    pool.markFailure(first.keyId, "credits_exhausted", null);
    expect(stateOf(pool, firstKey).cooldownUntil).toBe(
      new Date(start.getTime() + 3_600_000).toISOString(),
    );
  });

  it("marks an auth failure without auto recovery and never selects it again", () => {
    const clock = createClock(start);
    const pool = createProviderKeyPool([firstKey, secondKey], { now: clock.now });
    const first = selected(pool.select());

    pool.markFailure(first.keyId, "auth_or_key", null);

    expect(stateOf(pool, firstKey)).toEqual({
      id: providerKeyId(firstKey),
      status: "auth_failed",
      cooldownUntil: null,
      lastUsedAt: start.toISOString(),
    });
    expect(selected(pool.select()).apiKey).toBe(secondKey);

    clock.advance(86_400);

    expect(selected(pool.select()).apiKey).toBe(secondKey);
    expect(
      pool.list().find((entry) => entry.status === "auth_failed")?.id,
    ).toBe(providerKeyId(firstKey));
  });

  it("reports the nearest cooldown when every key is cooling down", () => {
    const clock = createClock(start);
    const pool = createProviderKeyPool([firstKey, secondKey], { now: clock.now });
    const first = selected(pool.select());
    const second = selected(pool.select());

    pool.markFailure(first.keyId, "quota_exhausted", 120);
    pool.markFailure(second.keyId, "rate_limited", 30);

    expect(pool.select()).toEqual({ status: "cooldown", retryAfterSeconds: 30 });

    clock.advance(10);
    expect(pool.select()).toEqual({ status: "cooldown", retryAfterSeconds: 20 });
  });

  it("reports rejection when every key failed auth", () => {
    const clock = createClock(start);
    const pool = createProviderKeyPool([firstKey, secondKey], { now: clock.now });
    const first = selected(pool.select());
    const second = selected(pool.select());

    pool.markFailure(first.keyId, "auth_or_key", null);
    pool.markFailure(second.keyId, "auth_or_key", null);

    expect(pool.select()).toEqual({ status: "rejected" });
  });

  it("returns a key to ready after its cooldown expires", () => {
    const clock = createClock(start);
    const pool = createProviderKeyPool([firstKey], { now: clock.now });
    const first = selected(pool.select());

    pool.markFailure(first.keyId, "rate_limited", null);
    expect(pool.select()).toEqual({ status: "cooldown", retryAfterSeconds: 60 });

    clock.advance(60);

    expect(states(pool)[0]?.status).toBe("ready");
    expect(selected(pool.select()).apiKey).toBe(firstKey);
  });

  it("ignores a failure for an unknown key id", () => {
    const clock = createClock(start);
    const pool = createProviderKeyPool([firstKey], { now: clock.now });

    pool.markFailure("k_000000000000", "auth_or_key", null);

    expect(stateOf(pool, firstKey).status).toBe("ready");
  });
});
