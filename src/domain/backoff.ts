export type BackoffConfig = { baseMs: number; maxMs: number };

export function computeDelay(attempt: number, cfg: BackoffConfig, random: () => number = Math.random): number {
  const cap = Math.min(cfg.maxMs, cfg.baseMs * 2 ** (attempt - 1));
  return Math.floor(random() * cap);
}

export function computeAmbiguousDelay(attempt: number, cfg: BackoffConfig, random: () => number = Math.random): number {
  return Math.max(cfg.baseMs, computeDelay(attempt, cfg, random));
}
