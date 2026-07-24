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

export interface RevocationCandidateSession {
  id: string
  token: string
  createdAt: Date
}

/**
 * One-in-one-out: picks the single oldest of the *other* live sessions to revoke when a new
 * session pushes the user over their tier cap. Never targets the just-created session itself —
 * callers must exclude it from `sessions` before calling this. Returns `null` for an empty list
 * (nothing to revoke, e.g. the over-cap count came from a race that already resolved).
 */
export function selectSessionToRevoke(sessions: RevocationCandidateSession[]): RevocationCandidateSession | null {
  if (sessions.length === 0) return null
  return sessions.reduce((oldest, session) => (session.createdAt < oldest.createdAt ? session : oldest))
}

export interface SessionTimeoutConfig {
  expiresIn: number
  updateAge: number
}

/**
 * Maps the two abuse-and-usage-integrity env vars onto better-auth's native
 * session model: `expiresIn` (seconds) is the outer bound a session can go
 * without being refreshed before it dies outright — driven by
 * `SESSION_ABSOLUTE_TIMEOUT_HOURS`; `updateAge` (seconds) is how much of that
 * window must remain before an active request bumps `expiresAt` forward by
 * `expiresIn` again — driven by `SESSION_IDLE_TIMEOUT_MINUTES`, whose default
 * (7 days) reproduces better-auth's own built-in `updateAge` default. This is
 * a sliding window, not a hard "even a daily user gets logged out on day N"
 * cap — see `better-auth.ts`'s comment where this is wired in.
 */
export function resolveSessionTimeoutConfig(absoluteTimeoutHours: number, idleTimeoutMinutes: number): SessionTimeoutConfig {
  return {
    expiresIn: absoluteTimeoutHours * 60 * 60,
    updateAge: idleTimeoutMinutes * 60,
  }
}
