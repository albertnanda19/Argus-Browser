export const RESTART_DELAYS_MS = [1000, 2000, 4000] as const;
export const RESTART_WINDOW_MS = 5 * 60 * 1000;

export type RestartDecision =
  | { readonly action: "restart"; readonly delayMs: number }
  | { readonly action: "exhausted" };

export class RestartPolicy {
  private restartTimes: number[] = [];
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  next(): RestartDecision {
    const now = this.now();
    const windowStart = now - RESTART_WINDOW_MS;
    this.restartTimes = this.restartTimes.filter((at) => at > windowStart);

    if (this.restartTimes.length >= RESTART_DELAYS_MS.length) {
      return { action: "exhausted" };
    }

    const delayMs = RESTART_DELAYS_MS[this.restartTimes.length];
    if (delayMs === undefined) {
      return { action: "exhausted" };
    }

    this.restartTimes.push(now);
    return { action: "restart", delayMs };
  }

  reset(): void {
    this.restartTimes = [];
  }
}
