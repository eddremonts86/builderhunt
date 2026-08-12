import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LOAD_CONFIG,
  DEFAULT_THRESHOLDS,
  expectedOfferedRate,
  jitterForUser,
  LOAD_EXIT_CODES,
  LOAD_ROUTES,
  LoadConfigError,
  SMOKE_LOAD_CONFIG,
  validateLoadConfig,
  type LoadConfig,
} from '../../../../scripts/load/config'

/**
 * Plan 55 phase 0 — the load contract.
 *
 * Every number in this file is a claim the certification report will make. The point of pinning them is
 * that relaxing one has to be a diff somebody reviews, not a flag on the run that finally went green.
 */
describe('the load contract', () => {
  it('pins 1,000 users at 400–500 requests per second', () => {
    expect(DEFAULT_LOAD_CONFIG.users).toBe(1_000)
    expect(DEFAULT_THRESHOLDS.offeredRatePerSecond).toEqual({ min: 400, max: 500 })
  })

  it('derives an offered rate that actually lands inside its own window', () => {
    /**
     * The check that matters most here, because it is the one that can be quietly wrong.
     *
     * The window is not asserted, it is *implied* by the user count and the think time — 1,000 users at
     * 2,000 ms plus 250 ms average jitter. If the arithmetic and the declared window ever disagree, the
     * run is measuring something other than the contract and every latency figure in the report is about
     * a different load than the one it names.
     */
    const rate = expectedOfferedRate(DEFAULT_LOAD_CONFIG)
    expect(rate).toBeGreaterThanOrEqual(DEFAULT_THRESHOLDS.offeredRatePerSecond.min)
    expect(rate).toBeLessThanOrEqual(DEFAULT_THRESHOLDS.offeredRatePerSecond.max)
    expect(Math.round(rate)).toBe(444)
  })

  it('keeps the think time, jitter bound and timeout the spec states', () => {
    expect(DEFAULT_LOAD_CONFIG.thinkTimeMs).toBe(2_000)
    expect(DEFAULT_LOAD_CONFIG.jitterMaxMs).toBe(500)
    expect(DEFAULT_LOAD_CONFIG.requestTimeoutMs).toBe(10_000)
  })

  it('ramps for two minutes before the window it reports on', () => {
    // Thresholds are evaluated after ramp-up. A report that included the ramp would show a p95 shaped by
    // the first users arriving against a cold cache.
    expect(DEFAULT_LOAD_CONFIG.stages.rampSeconds).toBe(120)
    expect(DEFAULT_LOAD_CONFIG.stages.steadySeconds).toBe(600)
  })

  it('carries every threshold from the spec table', () => {
    expect(DEFAULT_THRESHOLDS).toMatchObject({
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
    })
  })
})

describe('the route mix', () => {
  it('sums to 100 and is the five the spec names', () => {
    expect(LOAD_ROUTES.reduce((sum, r) => sum + r.weight, 0)).toBe(100)
    expect(LOAD_ROUTES.map((r) => [r.path, r.weight])).toEqual([
      ['/api/dashboard/overview', 45],
      ['/api/builders/recent', 15],
      ['/api/alerts/triggers/unread-count', 15],
      ['/api/recommendations', 15],
      ['/api/sprints/:sprintId/results', 10],
    ])
  })

  it('excludes federated search', () => {
    // Reported separately on purpose: third-party latency is not PostgreSQL capacity, so folding it in
    // would let a slow upstream fail a database certification — or a fast one hide a database problem.
    expect(LOAD_ROUTES.some((r) => /search/.test(r.path))).toBe(false)
  })
})

describe('validateLoadConfig', () => {
  const base = DEFAULT_LOAD_CONFIG

  it('accepts the shipped defaults and the smoke config', () => {
    expect(() => validateLoadConfig(base)).not.toThrow()
    expect(() => validateLoadConfig(SMOKE_LOAD_CONFIG)).not.toThrow()
  })

  it('refuses weights that do not sum to 100', () => {
    // The failure this exists to prevent: a run that discovers its mix is wrong after ninety minutes has
    // burned the host and produced a report nobody can use.
    const config: LoadConfig = {
      ...base,
      routes: [{ path: '/api/dashboard/overview', weight: 45 }, { path: '/api/builders/recent', weight: 52 }],
    }
    expect(() => validateLoadConfig(config)).toThrow(LoadConfigError)
    expect(() => validateLoadConfig(config)).toThrow(/sum to 100, got 97/)
  })

  it('refuses non-positive users and durations', () => {
    for (const patch of [
      { users: 0 },
      { users: -1 },
      { users: 1.5 },
      { thinkTimeMs: 0 },
      { requestTimeoutMs: 0 },
    ] as Array<Partial<LoadConfig>>) {
      expect(() => validateLoadConfig({ ...base, ...patch })).toThrow(LoadConfigError)
    }
  })

  it('bounds jitter above as well as below', () => {
    // 0–500 ms is in the spec. A wider jitter silently changes the offered rate the certification claims.
    expect(() => validateLoadConfig({ ...base, jitterMaxMs: -1 })).toThrow(/0\.\.500/)
    expect(() => validateLoadConfig({ ...base, jitterMaxMs: 501 })).toThrow(/0\.\.500/)
    expect(() => validateLoadConfig({ ...base, jitterMaxMs: 0 })).not.toThrow()
  })

  it('refuses a route that is not an /api/ path', () => {
    // An absolute URL here would send a thousand users somewhere the report does not name.
    const config: LoadConfig = { ...base, routes: [{ path: 'https://example.test/api/x', weight: 100 }] }
    expect(() => validateLoadConfig(config)).toThrow(/must be an \/api\/ path/)
  })

  it('refuses an empty mix and a zero-weight route', () => {
    expect(() => validateLoadConfig({ ...base, routes: [] })).toThrow(/must not be empty/)
    expect(() => validateLoadConfig({
      ...base,
      routes: [{ path: '/api/a', weight: 100 }, { path: '/api/b', weight: 0 }],
    })).toThrow(/non-positive weight/)
  })
})

describe('jitterForUser', () => {
  it('is deterministic, so two runs of one config are comparable', () => {
    // `Math.random()` here would mean a regression cannot be told apart from a different dice roll.
    expect(jitterForUser(7, 500)).toBe(jitterForUser(7, 500))
    expect(jitterForUser(7, 500)).not.toBe(jitterForUser(8, 500))
  })

  it('stays inside the bound for every user in a full run', () => {
    for (let index = 0; index < 1_000; index += 1) {
      const jitter = jitterForUser(index, 500)
      expect(jitter).toBeGreaterThanOrEqual(0)
      expect(jitter).toBeLessThanOrEqual(500)
    }
  })

  it('spreads across the range rather than clustering', () => {
    // Users arriving in lockstep measure the queue, not the capacity, so every bucket should be occupied.
    //
    // **Eleven, not ten** — the bound is inclusive, so the range is 0..500 and `floor(500 / 50)` is a
    // eleventh bucket holding exactly the maximum. My first version of this assertion said ten and failed;
    // the arithmetic was wrong, not the jitter.
    const buckets = new Set<number>()
    for (let index = 0; index < 1_000; index += 1) {
      buckets.add(Math.floor(jitterForUser(index, 500) / 50))
    }
    expect(buckets.size).toBe(11)
  })
})

describe('the smoke config', () => {
  it('shrinks the run and keeps every latency threshold', () => {
    // A smoke that relaxed them would go green against an app that had become four times slower.
    expect(SMOKE_LOAD_CONFIG.users).toBe(25)
    expect(SMOKE_LOAD_CONFIG.stages).toEqual({ rampSeconds: 5, steadySeconds: 30 })
    expect(SMOKE_LOAD_CONFIG.thresholds.httpP95Ms).toBe(DEFAULT_THRESHOLDS.httpP95Ms)
    expect(SMOKE_LOAD_CONFIG.thresholds.maxServerErrorRatio).toBe(DEFAULT_THRESHOLDS.maxServerErrorRatio)
  })

  it('drops only the offered-rate window', () => {
    // 25 users cannot offer 400 req/s, and asserting they do is how a smoke fails for arithmetic reasons.
    expect(SMOKE_LOAD_CONFIG.thresholds.offeredRatePerSecond.min).toBe(0)
    expect(SMOKE_LOAD_CONFIG.thresholds.offeredRatePerSecond.max).toBe(Number.POSITIVE_INFINITY)
  })

  it('uses the same route mix', () => {
    expect(SMOKE_LOAD_CONFIG.routes).toBe(LOAD_ROUTES)
  })
})

describe('the exit-code contract', () => {
  it('distinguishes a threshold breach from an aborted run', () => {
    /**
     * Two different facts, and collapsing them is the mistake.
     *
     * A run that never reached steady state has produced **no verdict** — fixture validation failed, or the
     * host died. Reporting that as a failed certification would let a dead host read as a capacity problem,
     * and somebody would go looking for a slow query that does not exist.
     */
    expect(LOAD_EXIT_CODES.pass).toBe(0)
    expect(LOAD_EXIT_CODES.thresholdBreach).toBe(2)
    expect(LOAD_EXIT_CODES.aborted).toBe(3)
    expect(new Set(Object.values(LOAD_EXIT_CODES)).size).toBe(3)
  })
})
