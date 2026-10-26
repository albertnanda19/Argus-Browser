import { describe, expect, it } from "vitest";
import {
  createDefaultProfilePolicy,
  type ProfilePolicy,
} from "../shared/profile-policy";
import {
  isWithinWorkingHours,
  planMousePath,
  planScrollDeltas,
  planTypingDelays,
  readingDurationMs,
  sampleActionDelay,
  type MousePoint,
  type RandomSource,
} from "./human-like";

function makePolicy(mutator: (policy: ProfilePolicy) => void): ProfilePolicy {
  const policy = createDefaultProfilePolicy();
  mutator(policy);
  return policy;
}

function createSeededRandom(seed: number): RandomSource {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`Missing value at index ${index}.`);
  }
  return value;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (at(sorted, middle - 1) + at(sorted, middle)) / 2
    : at(sorted, middle);
}

function projectionAlong(
  start: MousePoint,
  end: MousePoint,
  point: MousePoint,
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  return ((point.x - start.x) * dx + (point.y - start.y) * dy) / length;
}

function lateralDistance(
  start: MousePoint,
  end: MousePoint,
  point: MousePoint,
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  return Math.abs((point.x - start.x) * dy - (point.y - start.y) * dx) / length;
}

describe("sampleActionDelay", () => {
  it("clamps samples to the lower bound", () => {
    const policy = makePolicy((value) => {
      value.actionDelay.mu = 0;
      value.actionDelay.sigma = 0.01;
      value.actionDelay.minMs = 100;
      value.actionDelay.maxMs = 500;
    });
    const random = createSeededRandom(1);
    const samples = Array.from({ length: 50 }, () =>
      sampleActionDelay(policy, random),
    );

    expect(new Set(samples)).toEqual(new Set([100]));
  });

  it("clamps samples to the upper bound", () => {
    const policy = makePolicy((value) => {
      value.actionDelay.mu = Math.log(1_000_000_000);
      value.actionDelay.sigma = 0.01;
      value.actionDelay.minMs = 1;
      value.actionDelay.maxMs = 100;
    });
    const random = createSeededRandom(2);
    const samples = Array.from({ length: 50 }, () =>
      sampleActionDelay(policy, random),
    );

    expect(new Set(samples)).toEqual(new Set([100]));
  });

  it("keeps the median near the log-normal median", () => {
    const policy = makePolicy((value) => {
      value.actionDelay.mu = Math.log(500);
      value.actionDelay.sigma = 0.3;
      value.actionDelay.minMs = 1;
      value.actionDelay.maxMs = 100_000;
    });
    const random = createSeededRandom(3);
    const samples = Array.from({ length: 2001 }, () =>
      sampleActionDelay(policy, random),
    );
    const sampleMedian = median(samples);

    expect(sampleMedian).toBeGreaterThan(400);
    expect(sampleMedian).toBeLessThan(625);
  });

  it("varies between samples", () => {
    const policy = createDefaultProfilePolicy();
    const random = createSeededRandom(4);
    const samples = Array.from({ length: 200 }, () =>
      sampleActionDelay(policy, random),
    );

    expect(new Set(samples).size).toBeGreaterThan(20);
    expect(Math.min(...samples)).toBeLessThan(Math.max(...samples));
  });

  it("is deterministic for the same seed", () => {
    const policy = createDefaultProfilePolicy();
    const firstRandom = createSeededRandom(5);
    const secondRandom = createSeededRandom(5);
    const first = Array.from({ length: 100 }, () =>
      sampleActionDelay(policy, firstRandom),
    );
    const second = Array.from({ length: 100 }, () =>
      sampleActionDelay(policy, secondRandom),
    );

    expect(first).toEqual(second);
  });

  it("handles random sources returning 0 and 1", () => {
    const policy = createDefaultProfilePolicy();

    for (const value of [0, 1]) {
      const samples = Array.from({ length: 20 }, () =>
        sampleActionDelay(policy, () => value),
      );

      for (const sample of samples) {
        expect(Number.isFinite(sample)).toBe(true);
        expect(Number.isInteger(sample)).toBe(true);
        expect(sample).toBeGreaterThanOrEqual(policy.actionDelay.minMs);
        expect(sample).toBeLessThanOrEqual(policy.actionDelay.maxMs);
      }
    }
  });
});

describe("planTypingDelays", () => {
  it("returns one delay per code unit", () => {
    const policy = createDefaultProfilePolicy();
    const text = "a😀b";

    expect(planTypingDelays(text, policy, () => 0.5)).toHaveLength(
      text.length,
    );
  });

  it("returns an empty array for empty text", () => {
    expect(
      planTypingDelays("", createDefaultProfilePolicy(), () => 0.5),
    ).toEqual([]);
  });

  it("uses base interval, burst interval, and after-burst pause", () => {
    const policy = makePolicy((value) => {
      value.typing.baseIntervalMs = 110;
      value.typing.burstIntervalMs = 40;
      value.typing.burstLength = 2;
      value.typing.afterBurstPauseMs = 320;
    });

    expect(planTypingDelays("abcde", policy, () => 0.5)).toEqual([
      110, 40, 430, 40, 430,
    ]);
  });

  it("varies intervals with a seeded source", () => {
    const policy = makePolicy((value) => {
      value.typing.baseIntervalMs = 110;
      value.typing.burstIntervalMs = 40;
      value.typing.burstLength = 3;
      value.typing.afterBurstPauseMs = 320;
    });
    const delays = planTypingDelays(
      "abcdefghijklmnopqrst",
      policy,
      createSeededRandom(7),
    );

    expect(new Set(delays).size).toBeGreaterThan(3);
    expect(
      delays.every((delay) => Number.isInteger(delay) && delay >= 0),
    ).toBe(true);
  });

  it("is deterministic for the same seed", () => {
    const policy = createDefaultProfilePolicy();
    const text = "deterministic typing";
    const first = planTypingDelays(text, policy, createSeededRandom(99));
    const second = planTypingDelays(text, policy, createSeededRandom(99));

    expect(first).toEqual(second);
  });

  it("handles random sources returning 0 and 1", () => {
    const policy = createDefaultProfilePolicy();

    for (const value of [0, 1]) {
      const delays = planTypingDelays("abc", policy, () => value);

      expect(
        delays.every(
          (delay) =>
            Number.isFinite(delay) && Number.isInteger(delay) && delay >= 0,
        ),
      ).toBe(true);
    }
  });
});

describe("planMousePath", () => {
  const start: MousePoint = { x: 10, y: 20 };
  const end: MousePoint = { x: 110, y: 220 };

  it("starts and ends exactly at the requested points", () => {
    const policy = makePolicy((value) => {
      value.mouse.steps = 8;
      value.mouse.overshootRatio = 0.1;
    });
    const points = planMousePath(start, end, policy, () => 0.5);

    expect(points).toHaveLength(9);
    expect(points.at(0)).toEqual(start);
    expect(points.at(-1)).toEqual(end);
  });

  it("returns steps plus one points", () => {
    const policy = makePolicy((value) => {
      value.mouse.steps = 12;
      value.mouse.overshootRatio = 0;
    });

    expect(planMousePath(start, end, policy, () => 0.5)).toHaveLength(13);
  });

  it("does not pass the target when overshoot is zero", () => {
    const policy = makePolicy((value) => {
      value.mouse.steps = 16;
      value.mouse.overshootRatio = 0;
      value.mouse.curvature = 0.6;
    });
    const points = planMousePath(start, end, policy, () => 0.5);
    const distance = Math.hypot(end.x - start.x, end.y - start.y);
    const maxProjection = Math.max(
      ...points.map((point) => projectionAlong(start, end, point)),
    );

    expect(maxProjection).toBeLessThanOrEqual(distance + 1e-9);
  });

  it("passes beyond the target and returns when overshoot is positive", () => {
    const policy = makePolicy((value) => {
      value.mouse.steps = 16;
      value.mouse.overshootRatio = 0.2;
      value.mouse.curvature = 0;
    });
    const points = planMousePath(start, end, policy, () => 0.5);
    const distance = Math.hypot(end.x - start.x, end.y - start.y);
    const projections = points.map((point) =>
      projectionAlong(start, end, point),
    );

    expect(Math.max(...projections)).toBeGreaterThan(distance + 1);
    expect(projections.at(-1)).toBeCloseTo(distance, 9);
  });

  it("changes lateral deviation with curvature", () => {
    const straightPolicy = makePolicy((value) => {
      value.mouse.steps = 16;
      value.mouse.overshootRatio = 0;
      value.mouse.curvature = 0;
    });
    const curvedPolicy = makePolicy((value) => {
      value.mouse.steps = 16;
      value.mouse.overshootRatio = 0;
      value.mouse.curvature = 0.8;
    });
    const straight = planMousePath(start, end, straightPolicy, () => 0.5);
    const curved = planMousePath(start, end, curvedPolicy, () => 0.5);
    const maxStraight = Math.max(
      ...straight.map((point) => lateralDistance(start, end, point)),
    );
    const maxCurved = Math.max(
      ...curved.map((point) => lateralDistance(start, end, point)),
    );

    expect(maxStraight).toBeLessThan(1e-9);
    expect(maxCurved).toBeGreaterThan(1);
  });

  it("handles zero distance without NaN", () => {
    const policy = createDefaultProfilePolicy();
    const point = { x: 50, y: 50 };
    const points = planMousePath(point, point, policy, () => 0.5);

    expect(points).toHaveLength(policy.mouse.steps + 1);

    for (const current of points) {
      expect(current).toEqual(point);
      expect(Number.isFinite(current.x)).toBe(true);
      expect(Number.isFinite(current.y)).toBe(true);
    }
  });

  it("is deterministic for the same seed", () => {
    const policy = createDefaultProfilePolicy();
    const first = planMousePath(start, end, policy, createSeededRandom(123));
    const second = planMousePath(start, end, policy, createSeededRandom(123));

    expect(first).toEqual(second);
  });

  it("returns three points for a single step with overshoot", () => {
    const policy = makePolicy((value) => {
      value.mouse.steps = 1;
      value.mouse.overshootRatio = 0.2;
    });
    const points = planMousePath(start, end, policy, () => 0.5);

    expect(points).toHaveLength(3);
    expect(points.at(0)).toEqual(start);
    expect(points.at(-1)).toEqual(end);
  });
});

describe("planScrollDeltas", () => {
  it("returns one delta per step", () => {
    const policy = createDefaultProfilePolicy();

    expect(planScrollDeltas(policy)).toHaveLength(policy.scroll.steps);
  });

  it("starts at the initial delta and decays", () => {
    const policy = makePolicy((value) => {
      value.scroll.initialDeltaPx = 1000;
      value.scroll.decay = 0.5;
      value.scroll.steps = 5;
    });

    expect(planScrollDeltas(policy)).toEqual([1000, 500, 250, 125, 63]);
  });

  it("keeps every delta positive, integral, and strictly decreasing", () => {
    const policy = createDefaultProfilePolicy();
    const deltas = planScrollDeltas(policy);

    for (let index = 0; index < deltas.length; index += 1) {
      const delta = at(deltas, index);

      expect(Number.isInteger(delta)).toBe(true);
      expect(delta).toBeGreaterThan(0);

      if (index > 0) {
        expect(delta).toBeLessThan(at(deltas, index - 1));
      }
    }
  });

  it("keeps a strictly decreasing sequence for a short initial delta", () => {
    const policy = makePolicy((value) => {
      value.scroll.initialDeltaPx = 5;
      value.scroll.decay = 0.5;
      value.scroll.steps = 8;
    });

    expect(planScrollDeltas(policy)).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
  });

  it("is deterministic", () => {
    const policy = createDefaultProfilePolicy();

    expect(planScrollDeltas(policy)).toEqual(planScrollDeltas(policy));
  });

  it("handles a single step", () => {
    const policy = makePolicy((value) => {
      value.scroll.initialDeltaPx = 480;
      value.scroll.steps = 1;
    });

    expect(planScrollDeltas(policy)).toEqual([480]);
  });
});

describe("readingDurationMs", () => {
  it("returns the minimum for empty text", () => {
    const policy = createDefaultProfilePolicy();

    expect(readingDurationMs(0, policy)).toBe(policy.reading.minMs);
  });

  it("clamps very long text to the maximum", () => {
    const policy = createDefaultProfilePolicy();

    expect(readingDurationMs(1_000_000, policy)).toBe(policy.reading.maxMs);
  });

  it("increases monotonically within the clamp range", () => {
    const policy = createDefaultProfilePolicy();
    const lengths = [0, 10, 20, 40, 80, 160, 1000];
    const durations = lengths.map((length) =>
      readingDurationMs(length, policy),
    );

    for (let index = 1; index < durations.length; index += 1) {
      expect(at(durations, index)).toBeGreaterThanOrEqual(
        at(durations, index - 1),
      );
    }

    expect(at(durations, 1)).toBeGreaterThan(at(durations, 0));
    expect(at(durations, 4)).toBeGreaterThan(at(durations, 3));
  });

  it("uses string code units", () => {
    const policy = createDefaultProfilePolicy();
    const text = "😀".repeat(10);

    expect(readingDurationMs(text.length, policy)).toBe(700);
  });

  it("returns integers", () => {
    const policy = createDefaultProfilePolicy();

    for (const length of [0, 1, 7, 99, 1000]) {
      expect(Number.isInteger(readingDurationMs(length, policy))).toBe(true);
    }
  });
});

describe("isWithinWorkingHours", () => {
  const policy = createDefaultProfilePolicy();
  const mondayNine = new Date(2026, 9, 26, 9, 0, 0);
  const mondayEightFiftyNine = new Date(2026, 9, 26, 8, 59, 0);
  const mondaySeventeenFiftyNine = new Date(2026, 9, 26, 17, 59, 0);
  const mondayEighteen = new Date(2026, 9, 26, 18, 0, 0);
  const saturdayTen = new Date(2026, 9, 31, 10, 0, 0);

  it("includes the start of the window", () => {
    expect(isWithinWorkingHours(policy, mondayNine)).toBe(true);
  });

  it("excludes the minute before the window", () => {
    expect(isWithinWorkingHours(policy, mondayEightFiftyNine)).toBe(false);
  });

  it("includes the last minute before the end", () => {
    expect(isWithinWorkingHours(policy, mondaySeventeenFiftyNine)).toBe(true);
  });

  it("excludes the end of the window", () => {
    expect(isWithinWorkingHours(policy, mondayEighteen)).toBe(false);
  });

  it("excludes a day that is not configured", () => {
    expect(isWithinWorkingHours(policy, saturdayTen)).toBe(false);
  });

  it("supports a custom day and window", () => {
    const custom = makePolicy((value) => {
      value.workingHours.days = [7];
      value.workingHours.start = "10:00";
      value.workingHours.end = "12:00";
    });
    const sundayEleven = new Date(2026, 10, 1, 11, 0, 0);
    const mondayEleven = new Date(2026, 9, 26, 11, 0, 0);

    expect(isWithinWorkingHours(custom, sundayEleven)).toBe(true);
    expect(isWithinWorkingHours(custom, mondayEleven)).toBe(false);
  });

  it("uses local machine time", () => {
    const localNine = new Date(2026, 9, 26, 9, 0, 0);

    expect(localNine.getHours()).toBe(9);
    expect(isWithinWorkingHours(policy, localNine)).toBe(true);
  });
});
