import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RestartPolicy } from "./restart-policy";

const startTime = new Date("2026-01-01T00:00:00.000Z").getTime();
const fiveMinutes = 5 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(startTime);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("RestartPolicy", () => {
  it("backs off 1s, 2s, then 4s", () => {
    const policy = new RestartPolicy();

    expect(policy.next()).toEqual({ action: "restart", delayMs: 1000 });
    vi.advanceTimersByTime(1000);

    expect(policy.next()).toEqual({ action: "restart", delayMs: 2000 });
    vi.advanceTimersByTime(2000);

    expect(policy.next()).toEqual({ action: "restart", delayMs: 4000 });
  });

  it("refuses a fourth restart inside the five-minute window", () => {
    const policy = new RestartPolicy();

    policy.next();
    vi.advanceTimersByTime(1000);
    policy.next();
    vi.advanceTimersByTime(2000);
    policy.next();

    expect(policy.next()).toEqual({ action: "exhausted" });
  });

  it("allows a restart again once the oldest restart leaves the window", () => {
    const policy = new RestartPolicy();

    policy.next();
    vi.advanceTimersByTime(1000);
    policy.next();
    vi.advanceTimersByTime(2000);
    policy.next();

    vi.setSystemTime(startTime + fiveMinutes - 1);
    expect(policy.next()).toEqual({ action: "exhausted" });

    vi.setSystemTime(startTime + fiveMinutes);
    expect(policy.next()).toEqual({ action: "restart", delayMs: 4000 });
  });

  it("starts from a 1s delay after a manual reset", () => {
    const policy = new RestartPolicy();

    policy.next();
    policy.next();
    policy.next();
    expect(policy.next()).toEqual({ action: "exhausted" });

    policy.reset();
    expect(policy.next()).toEqual({ action: "restart", delayMs: 1000 });
  });
});
