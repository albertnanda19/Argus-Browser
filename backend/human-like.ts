import type { ProfilePolicy } from "../shared/profile-policy";

export type RandomSource = () => number;

export type MousePoint = {
  readonly x: number;
  readonly y: number;
};

const defaultRandomSource: RandomSource = Math.random;
const TYPING_JITTER_MIN = 0.85;
const TYPING_JITTER_SPAN = 0.3;
const MOUSE_RETURN_SEGMENT_RATIO = 0.25;

function normalizeRandom(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.5;
  }

  return Math.min(1 - Number.EPSILON, Math.max(Number.EPSILON, value));
}

function sampleStandardNormal(random: RandomSource): number {
  const first = normalizeRandom(random());
  const second = normalizeRandom(random());

  return (
    Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second)
  );
}

function typingJitter(random: RandomSource): number {
  return TYPING_JITTER_MIN + TYPING_JITTER_SPAN * normalizeRandom(random());
}

function quadraticPoint(
  start: MousePoint,
  control: MousePoint,
  end: MousePoint,
  t: number,
): MousePoint {
  const inverse = 1 - t;

  return {
    x:
      inverse * inverse * start.x +
      2 * inverse * t * control.x +
      t * t * end.x,
    y:
      inverse * inverse * start.y +
      2 * inverse * t * control.y +
      t * t * end.y,
  };
}

function timeToMinutes(value: string): number {
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
}

export function sampleActionDelay(
  policy: ProfilePolicy,
  random: RandomSource = defaultRandomSource,
): number {
  const normal = sampleStandardNormal(random);
  const raw = Math.exp(
    policy.actionDelay.mu + policy.actionDelay.sigma * normal,
  );
  const clamped = Math.min(
    policy.actionDelay.maxMs,
    Math.max(policy.actionDelay.minMs, raw),
  );

  return Math.round(clamped);
}

export function planTypingDelays(
  text: string,
  policy: ProfilePolicy,
  random: RandomSource = defaultRandomSource,
): readonly number[] {
  const {
    baseIntervalMs,
    burstIntervalMs,
    burstLength,
    afterBurstPauseMs,
  } = policy.typing;
  const delays: number[] = [];

  for (let index = 0; index < text.length; index += 1) {
    const position = index % burstLength;
    const jitter = typingJitter(random);
    let delay: number;

    if (index === 0) {
      delay = baseIntervalMs * jitter;
    } else if (position === 0) {
      delay = baseIntervalMs * jitter + afterBurstPauseMs;
    } else {
      delay = burstIntervalMs * jitter;
    }

    delays.push(Math.max(0, Math.round(delay)));
  }

  return delays;
}

export function planMousePath(
  start: MousePoint,
  end: MousePoint,
  policy: ProfilePolicy,
  random: RandomSource = defaultRandomSource,
): readonly MousePoint[] {
  const steps = policy.mouse.steps;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.hypot(dx, dy);

  if (distance === 0) {
    return Array.from({ length: steps + 1 }, () => ({
      x: start.x,
      y: start.y,
    }));
  }

  const unitX = dx / distance;
  const unitY = dy / distance;
  const normalX = -unitY;
  const normalY = unitX;
  const lateralDirection = normalizeRandom(random()) < 0.5 ? -1 : 1;
  const lateralOffset = distance * policy.mouse.curvature * lateralDirection;
  const overshootDistance = distance * policy.mouse.overshootRatio;
  const overshootPoint: MousePoint = {
    x: end.x + unitX * overshootDistance,
    y: end.y + unitY * overshootDistance,
  };

  if (steps === 1) {
    if (policy.mouse.overshootRatio === 0) {
      return [
        { x: start.x, y: start.y },
        { x: end.x, y: end.y },
      ];
    }

    return [
      { x: start.x, y: start.y },
      overshootPoint,
      { x: end.x, y: end.y },
    ];
  }

  if (policy.mouse.overshootRatio === 0) {
    const control: MousePoint = {
      x: (start.x + end.x) / 2 + normalX * lateralOffset,
      y: (start.y + end.y) / 2 + normalY * lateralOffset,
    };
    const points: MousePoint[] = [];

    for (let index = 0; index <= steps; index += 1) {
      points.push(quadraticPoint(start, control, end, index / steps));
    }

    points[0] = { x: start.x, y: start.y };
    points[points.length - 1] = { x: end.x, y: end.y };

    return points;
  }

  const returnSegments = Math.min(
    Math.max(1, Math.round(steps * MOUSE_RETURN_SEGMENT_RATIO)),
    steps - 1,
  );
  const mainSegments = steps - returnSegments;
  const control: MousePoint = {
    x: (start.x + overshootPoint.x) / 2 + normalX * lateralOffset,
    y: (start.y + overshootPoint.y) / 2 + normalY * lateralOffset,
  };
  const points: MousePoint[] = [];

  for (let index = 0; index <= mainSegments; index += 1) {
    points.push(
      quadraticPoint(
        start,
        control,
        overshootPoint,
        index / mainSegments,
      ),
    );
  }

  points[0] = { x: start.x, y: start.y };
  points[points.length - 1] = {
    x: overshootPoint.x,
    y: overshootPoint.y,
  };

  for (let index = 1; index <= returnSegments; index += 1) {
    const t = index / returnSegments;
    points.push({
      x: overshootPoint.x + (end.x - overshootPoint.x) * t,
      y: overshootPoint.y + (end.y - overshootPoint.y) * t,
    });
  }

  points[points.length - 1] = { x: end.x, y: end.y };

  return points;
}

export function planScrollDeltas(
  policy: ProfilePolicy,
): readonly number[] {
  const { initialDeltaPx, decay, steps } = policy.scroll;
  const deltas: number[] = [];
  let previous = 0;

  for (let index = 0; index < steps; index += 1) {
    const remaining = steps - index;
    const raw = Math.round(initialDeltaPx * decay ** index);
    const candidate = Math.max(raw, remaining);
    const delta =
      index === 0 ? candidate : Math.min(candidate, previous - 1);

    deltas.push(delta);
    previous = delta;
  }

  return deltas;
}

export function readingDurationMs(
  textLength: number,
  policy: ProfilePolicy,
): number {
  const length = Number.isFinite(textLength)
    ? Math.max(0, Math.trunc(textLength))
    : 0;
  const duration = length * policy.reading.msPerCharacter;
  const clamped = Math.min(
    policy.reading.maxMs,
    Math.max(policy.reading.minMs, duration),
  );

  return Math.round(clamped);
}

export function isWithinWorkingHours(
  policy: ProfilePolicy,
  at: Date,
): boolean {
  const day = at.getDay();
  const isoDay = day === 0 ? 7 : day;
  const minutes = at.getHours() * 60 + at.getMinutes();
  const start = timeToMinutes(policy.workingHours.start);
  const end = timeToMinutes(policy.workingHours.end);

  return (
    policy.workingHours.days.includes(isoDay) &&
    minutes >= start &&
    minutes < end
  );
}
