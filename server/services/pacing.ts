/**
 * Call pacing. Free API plans ask for calls to be spaced out (Alpha Vantage: at least one second apart), so
 * calls to a provider on a free plan wait until two seconds have passed since its previous call. Calls to the
 * same provider queue behind each other; different providers don't wait for one another.
 */

export const FREE_PLAN_INTERVAL_MS = 2000;

export interface Pacer {
  /** Resolve when a call to `key` may go out, at least `intervalMs` after the previous one. */
  wait(key: string, intervalMs: number): Promise<void>;
}

export function createPacer(
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Pacer {
  const next = new Map<string, number>(); // earliest time the next call to a key may start
  const tail = new Map<string, Promise<void>>(); // queue per key, so concurrent callers line up
  return {
    wait(key, intervalMs) {
      if (intervalMs <= 0) return Promise.resolve();
      const turn = (tail.get(key) ?? Promise.resolve()).then(async () => {
        const delay = (next.get(key) ?? 0) - now();
        if (delay > 0) await sleep(delay);
        next.set(key, now() + intervalMs);
      });
      tail.set(key, turn.catch(() => {}));
      return turn;
    },
  };
}

// Tests set PFAT_PACING=off so fake providers answer instantly; real runs always pace.
const off = (() => {
  try {
    return Deno.env.get("PFAT_PACING") === "off";
  } catch {
    return false;
  }
})();

export const pacer: Pacer = off ? { wait: () => Promise.resolve() } : createPacer();
