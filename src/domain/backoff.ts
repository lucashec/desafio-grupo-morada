export type BackoffConfig = { baseMs: number; maxMs: number };

/** REQ-RETRY-01: full jitter, delay = random(0, min(max, base * 2^(attempt-1))). */
export function computeDelay(attempt: number, cfg: BackoffConfig, random: () => number = Math.random): number {
  const cap = Math.min(cfg.maxMs, cfg.baseMs * 2 ** (attempt - 1));
  return Math.floor(random() * cap);
}

/** Ambiguous outcomes wait at least `baseMs` before reconciling (mitigates P-03). */
export function computeAmbiguousDelay(attempt: number, cfg: BackoffConfig, random: () => number = Math.random): number {
  return Math.max(cfg.baseMs, computeDelay(attempt, cfg, random));
}
