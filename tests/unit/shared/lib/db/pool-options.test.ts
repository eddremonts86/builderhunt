import { afterEach, describe, expect, it } from 'vitest'
import { poolOptions, POOL_ROLES, totalPoolMax, type PoolRole } from '../../../../../src/shared/lib/db/pool-options'

/**
 * Plan 55 phase 2 — the per-role connection pools.
 *
 * A pool size is the application's claim on a finite `max_connections`, and getting one wrong does not
 * fail where it was written. It fails much later, in an unrelated request, as `too many clients
 * already` — which is why these assert the exact option objects rather than "looks about right", and
 * why the total is asserted against the topology's budget rather than left implied.
 */

const OVERRIDE_KEYS = POOL_ROLES.map((role) => `LOAD_POOL_MAX_${role.toUpperCase()}`)

afterEach(() => {
  for (const key of [...OVERRIDE_KEYS, 'E2E_MODE']) delete process.env[key]
})

describe('poolOptions', () => {
  it('gives every role the exact option object, not an approximation', () => {
    // Spelled out per role. A loop over expected values would pass a table that had drifted from the
    // reasoning in the module comment, which is where the sizes are justified.
    expect(poolOptions('runtime')).toEqual({
      prepare: false,
      max: 12,
      idle_timeout: 30,
      connect_timeout: 5,
      connection: { application_name: 'builderhunt_runtime' },
    })
    expect(poolOptions('auth')).toEqual({
      prepare: false,
      max: 4,
      idle_timeout: 30,
      connect_timeout: 5,
      connection: { application_name: 'builderhunt_auth' },
    })
    expect(poolOptions('worker')).toEqual({
      prepare: false,
      max: 4,
      idle_timeout: 30,
      connect_timeout: 5,
      connection: { application_name: 'builderhunt_worker' },
    })
    expect(poolOptions('platform')).toEqual({
      prepare: false,
      max: 3,
      idle_timeout: 30,
      connect_timeout: 5,
      connection: { application_name: 'builderhunt_platform' },
    })
    expect(poolOptions('capability')).toEqual({
      prepare: false,
      max: 3,
      idle_timeout: 30,
      connect_timeout: 5,
      connection: { application_name: 'builderhunt_capability' },
    })
  })

  it('never prepares statements, on any role or environment', () => {
    /**
     * The one option that is not a preference.
     *
     * Production runs behind a transaction-pooling proxy, where a prepared statement does not survive
     * between checkouts — so `prepare: true` anywhere is a `prepared statement "s1" does not exist`
     * waiting for the day the pooler is in the path.
     */
    for (const role of POOL_ROLES) expect(poolOptions(role).prepare).toBe(false)
    process.env.E2E_MODE = 'true'
    for (const role of POOL_ROLES) expect(poolOptions(role).prepare).toBe(false)
  })

  it('names each pool so pg_stat_activity can tell them apart', () => {
    // Without this, a capacity problem shows N identical rows and no way to know which pool grew.
    const names = POOL_ROLES.map((role) => poolOptions(role).connection.application_name)
    expect(new Set(names).size).toBe(POOL_ROLES.length)
  })

  it('keeps E2E on its own small numbers, for every role', () => {
    /**
     * Playwright spawns a Vite server per worker, so the caps multiply by worker count.
     *
     * This is the regression that reached 197 idle connections against a 200-connection cluster twice
     * while the interview suite was being built, and it presented as a database error in whichever
     * spec happened to be running when the pool ran dry.
     */
    process.env.E2E_MODE = 'true'
    for (const role of POOL_ROLES) {
      expect(poolOptions(role)).toEqual({
        prepare: false,
        max: 3,
        idle_timeout: 20,
        connect_timeout: 5,
        connection: { application_name: `builderhunt_${role}` },
      })
    }
  })

  it('E2E overrides the per-role cap rather than being overridden by it', () => {
    // Order matters: an override read first would let a stray env var reintroduce the 197-connection
    // failure in a suite that had deliberately capped itself.
    process.env.E2E_MODE = 'true'
    process.env.LOAD_POOL_MAX_RUNTIME = '40'
    expect(poolOptions('runtime').max).toBe(3)
  })

  it('accepts a valid override', () => {
    process.env.LOAD_POOL_MAX_RUNTIME = '25'
    expect(poolOptions('runtime').max).toBe(25)
    // And only for the role named.
    expect(poolOptions('auth').max).toBe(4)
  })

  it('falls back to the default for an unusable override instead of trusting it', () => {
    /**
     * `postgres.js` treats a `NaN` max as unbounded.
     *
     * So the dangerous outcome is not a rejected value, it is an accepted one — a typo would remove the
     * cap entirely and the process would look configured. Production refuses these at startup
     * (`env.ts`); here the fallback is what keeps a local typo from becoming an unbounded pool.
     */
    for (const bad of ['abc', '0', '-1', '101', '3.5', 'Infinity', 'NaN']) {
      process.env.LOAD_POOL_MAX_PLATFORM = bad
      expect(poolOptions('platform').max).toBe(3)
    }
  })

  it('treats an empty override as absent', () => {
    process.env.LOAD_POOL_MAX_WORKER = ''
    expect(poolOptions('worker').max).toBe(4)
  })
})

describe('totalPoolMax', () => {
  it('fits inside the load topology\'s connection budget', () => {
    /**
     * The number the per-role caps exist to control.
     *
     * The load compose sets PostgreSQL `max_connections=120` and PgBouncer `max_db_connections=80`. One
     * app process must stay well inside that with room for the pooler's own backends, the migration
     * connection and a monitor — and four processes must not be able to exhaust the cluster between
     * them. Asserting the total rather than each cap means raising one cap has to face the sum.
     */
    const total = totalPoolMax()
    expect(total).toBe(26)
    expect(total * 4).toBeLessThan(120)
    expect(total).toBeLessThan(80)
  })

  it('covers every role, so a new pool cannot be added without landing in the total', () => {
    const roles: PoolRole[] = ['runtime', 'auth', 'worker', 'platform', 'capability']
    expect([...POOL_ROLES]).toEqual(roles)
  })
})
