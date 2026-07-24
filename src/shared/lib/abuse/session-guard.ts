export interface SessionConcurrencyConfig {
  free: number
  pro: number
  teamPerSeat: number
}

/**
 * Maps an organization's billing tier to its per-user concurrent-session cap.
 * `pro_max` shares the `pro` cap (no separate env var exists for it — it's a
 * pricing variant of `pro`, not a distinct concurrency tier). Any other/
 * unrecognized tier falls back to the `free` cap — the more conservative
 * default fail-closed for concurrency, unlike feature access which fails
 * closed the other way.
 */
export function resolveSessionCap(tier: string, config: SessionConcurrencyConfig): number {
  switch (tier) {
    case 'pro':
    case 'pro_max':
      return config.pro
    case 'team':
      return config.teamPerSeat
    case 'free':
    default:
      return config.free
  }
}

export interface SessionConcurrencyInput {
  tier: string
  liveSessionCount: number
  config: SessionConcurrencyConfig
}

export interface SessionConcurrencyResult {
  cap: number
  overCap: boolean
}

/** `liveSessionCount` counts the just-created session, so `overCap` means "including this one, over the cap." */
export function evaluateSessionConcurrency(input: SessionConcurrencyInput): SessionConcurrencyResult {
  const cap = resolveSessionCap(input.tier, input.config)
  return { cap, overCap: input.liveSessionCount > cap }
}
