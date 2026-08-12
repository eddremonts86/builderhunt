/**
 * The load contract, in one place, as data (plan 55 phase 0).
 *
 * ## Why a module and not flags on a command
 *
 * Every number here is a claim the certification report will make: "1,000 sessions at 400–500 req/s with
 * p95 under 1.5 s". A threshold passed as a flag is a threshold somebody can quietly relax on the run
 * that finally goes green, and the report would still say it passed. Encoded here, changing one is a
 * diff.
 *
 * ## What "1,000 concurrent users" means, precisely
 *
 * Not 1,000 simultaneous TCP connections. One request per virtual user, then a wait, then repeat — so the
 * offered rate is a *consequence* of the user count and the think time, and `expectedOfferedRate()` below
 * derives it rather than asserting it. If the two ever disagree, the arithmetic is wrong and the run is
 * measuring something other than the contract.
 */

/** A route in the mix, with the share of requests it should receive. */
export interface LoadRoute {
  /** Path template. `:sprintId` is substituted per virtual user from its own seeded fixture. */
  path: string
  /** Share of total requests, in percent. The five must sum to 100. */
  weight: number
}

/**
 * Read-heavy and seeded-local-data only.
 *
 * The federated-search profile is deliberately **not** here. The spec keeps it separate and reported
 * separately, because third-party latency is not PostgreSQL capacity — folding it in would let a slow
 * upstream fail a database certification, or a fast one hide a database problem.
 */
export const LOAD_ROUTES: readonly LoadRoute[] = [
  { path: '/api/dashboard/overview', weight: 45 },
  { path: '/api/builders/recent', weight: 15 },
  { path: '/api/alerts/triggers/unread-count', weight: 15 },
  { path: '/api/recommendations', weight: 15 },
  { path: '/api/sprints/:sprintId/results', weight: 10 },
] as const

export interface LoadStages {
  /** Ramp 0 → target over this many seconds. Thresholds are evaluated *after* it. */
  rampSeconds: number
  /** The timed window the report is about. */
  steadySeconds: number
}

export interface LoadThresholds {
  offeredRatePerSecond: { min: number; max: number }
  httpP50Ms: number
  httpP95Ms: number
  httpP99Ms: number
  /** Fractions, not percentages — 0.001 is the spec's 0.1%. */
  maxServerErrorRatio: number
  maxUnexpectedNon2xxRatio: number
  maxPostgresConnections: number
  maxPgBouncerBackends: number
  /** Share of 5-second samples that must satisfy the PgBouncer wait targets. */
  minWaitSampleCompliance: number
  maxPgBouncerMaxWaitMs: number
  /** RSS growth from minute 15 to minute 120, as a fraction. */
  maxRssGrowthRatio: number
}

export interface LoadConfig {
  users: number
  /** Base think time between a user's requests. */
  thinkTimeMs: number
  /**
   * Deterministic jitter, 0–500 ms, added to the think time.
   *
   * Deterministic and not random: two runs of the same config must offer the same shape of load, or a
   * regression cannot be told apart from a different dice roll. The runner derives it from the virtual
   * user's index, which is why the bound lives here and the draw does not.
   */
  jitterMaxMs: number
  requestTimeoutMs: number
  stages: LoadStages
  routes: readonly LoadRoute[]
  thresholds: LoadThresholds
}

/** Every threshold in the spec's table, and nothing invented. */
export const DEFAULT_THRESHOLDS: LoadThresholds = {
  offeredRatePerSecond: { min: 400, max: 500 },
  httpP50Ms: 250,
  httpP95Ms: 1_500,
  httpP99Ms: 3_000,
  maxServerErrorRatio: 0.001,
  maxUnexpectedNon2xxRatio: 0.001,
  maxPostgresConnections: 100,
  maxPgBouncerBackends: 80,
  minWaitSampleCompliance: 0.95,
  maxPgBouncerMaxWaitMs: 50,
  maxRssGrowthRatio: 0.1,
}

export const DEFAULT_LOAD_CONFIG: LoadConfig = {
  users: 1_000,
  thinkTimeMs: 2_000,
  jitterMaxMs: 500,
  requestTimeoutMs: 10_000,
  // Two-minute ramp, then the ten-minute window the baseline and calibration stages report on. The
  // two-hour soak overrides `steadySeconds`; nothing else about the contract changes between stages.
  stages: { rampSeconds: 120, steadySeconds: 600 },
  routes: LOAD_ROUTES,
  thresholds: DEFAULT_THRESHOLDS,
}

/**
 * The CI smoke: same contract, smaller numbers.
 *
 * Its job is detecting broken wiring, not certifying capacity — so the *thresholds* are inherited
 * unchanged. A smoke that relaxes them would go green against an app that had become four times slower.
 * What it drops is the offered-rate window, because 25 users cannot offer 400 req/s and asserting they do
 * is how a smoke starts failing for arithmetic reasons.
 */
export const SMOKE_LOAD_CONFIG: LoadConfig = {
  ...DEFAULT_LOAD_CONFIG,
  users: 25,
  stages: { rampSeconds: 5, steadySeconds: 30 },
  thresholds: { ...DEFAULT_THRESHOLDS, offeredRatePerSecond: { min: 0, max: Number.POSITIVE_INFINITY } },
}

export class LoadConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LoadConfigError'
  }
}

/**
 * The offered rate the config implies, in requests per second.
 *
 * `users / (thinkTime + averageJitter)`. Derived rather than configured, so the declared 400–500 window
 * is checked against arithmetic instead of being taken on trust: 1,000 users at 2,000 ms + 250 ms average
 * is ~444 req/s, which is why the window is what it is.
 */
export function expectedOfferedRate(config: LoadConfig): number {
  const cycleMs = config.thinkTimeMs + config.jitterMaxMs / 2
  return (config.users * 1_000) / cycleMs
}

/**
 * Deterministic jitter for one virtual user.
 *
 * A cheap integer hash rather than `Math.random()`: the same user index must always draw the same delay,
 * so two runs of one config are comparable. Spread across the whole 0–`jitterMaxMs` range so users do not
 * arrive in lockstep — a thundering herd measures the queue, not the capacity.
 */
export function jitterForUser(userIndex: number, jitterMaxMs: number): number {
  const hashed = Math.imul(userIndex + 1, 2654435761) >>> 0
  return hashed % (jitterMaxMs + 1)
}

/**
 * Refuses a config that cannot mean what it says.
 *
 * Validated at load rather than at first request: a run that discovers its weights sum to 97 after ninety
 * minutes has wasted the host and produced a report nobody can use.
 */
export function validateLoadConfig(config: LoadConfig): LoadConfig {
  if (!Number.isInteger(config.users) || config.users <= 0) {
    throw new LoadConfigError(`users must be a positive integer, got ${config.users}`)
  }
  if (config.thinkTimeMs <= 0) {
    throw new LoadConfigError(`thinkTimeMs must be positive, got ${config.thinkTimeMs}`)
  }
  if (config.jitterMaxMs < 0 || config.jitterMaxMs > 500) {
    // Bounded above as well as below: the spec says 0–500 ms, and a wider jitter changes the offered rate
    // the certification claims.
    throw new LoadConfigError(`jitterMaxMs must be within 0..500, got ${config.jitterMaxMs}`)
  }
  if (config.requestTimeoutMs <= 0) {
    throw new LoadConfigError(`requestTimeoutMs must be positive, got ${config.requestTimeoutMs}`)
  }
  if (config.stages.rampSeconds < 0 || config.stages.steadySeconds <= 0) {
    throw new LoadConfigError('stages must have a non-negative ramp and a positive steady window')
  }
  if (config.routes.length === 0) {
    throw new LoadConfigError('routes must not be empty')
  }

  const total = config.routes.reduce((sum, route) => sum + route.weight, 0)
  if (total !== 100) {
    throw new LoadConfigError(`route weights must sum to 100, got ${total}`)
  }
  for (const route of config.routes) {
    if (route.weight <= 0) throw new LoadConfigError(`route ${route.path} has a non-positive weight`)
    if (!route.path.startsWith('/api/')) {
      // A relative or absolute URL here would send load somewhere the report does not name.
      throw new LoadConfigError(`route ${route.path} must be an /api/ path`)
    }
  }
  return config
}

/**
 * The exit-code contract, so the CI smoke and the operator read the same outcome.
 *
 * `2` for a threshold breach and `3` for an aborted run are deliberately distinct: a run that never
 * reached steady state has produced no verdict, and treating that as a failed certification would let a
 * dead host read as a capacity problem.
 */
export const LOAD_EXIT_CODES = {
  /** Every threshold met. */
  pass: 0,
  /** The run completed and something was out of budget. */
  thresholdBreach: 2,
  /** Fixture validation failed, or the run was interrupted before steady state. No verdict. */
  aborted: 3,
} as const

export type LoadExitCode = (typeof LOAD_EXIT_CODES)[keyof typeof LOAD_EXIT_CODES]
