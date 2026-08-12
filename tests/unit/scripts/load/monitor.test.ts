import { describe, expect, it } from 'vitest'
import type { Sql } from 'postgres'
import { parseDockerBytes, startMonitor } from '../../../../scripts/load/monitor'
import { readPgBouncerPools, readPgBouncerStats, readPostgresActivity } from '../../../../scripts/load/sql'

/**
 * Plan 55 phase 0 — the observability sampler.
 *
 * These protect the three ways a monitor lies without failing. It can report a number that is off by a
 * factor (units), it can report a number that is somebody else's (its own connection, the pooler's internal
 * pool), and it can report zero for something it never managed to look at. The last one is the dangerous
 * one: a threshold satisfied by the absence of data is indistinguishable from a threshold met.
 */

/** A stand-in for `postgres`'s tagged client: `unsafe(query)` returns whatever the script maps for it. */
function fakeSql(handler: (query: string) => unknown): Sql {
  return {
    unsafe: (query: string) => Promise.resolve(handler(query)),
    end: () => Promise.resolve(),
  } as unknown as Sql
}

describe('readPostgresActivity', () => {
  it('reads the four counters the spec names', async () => {
    const sql = fakeSql(() => [{ connections: 42, active: 7, idle_in_transaction: 2, waiting: 1 }])
    await expect(readPostgresActivity(sql)).resolves.toEqual({
      connections: 42,
      active: 7,
      idleInTransaction: 2,
      waiting: 1,
    })
  })

  it('excludes the monitor\'s own backend, and asks about the connected database only', async () => {
    // Both are properties of the query text, and both were wrong once: an unfiltered count adds one per
    // monitor at a threshold of 100, and a `datname` compared to a passed-in name can describe a different
    // database than the connection is pointed at.
    let seen = ''
    const sql = fakeSql((query) => {
      seen = query
      return [{ connections: 1, active: 0, idle_in_transaction: 0, waiting: 0 }]
    })
    await readPostgresActivity(sql)
    expect(seen).toContain('pid <> pg_backend_pid()')
    expect(seen).toContain('datname = current_database()')
  })

  it('puts FILTER before the cast, because the other order is a syntax error', async () => {
    /**
     * The regression this exists for.
     *
     * `count(*)::int filter (where …)` does not parse. Every sample threw, the monitor counted three
     * failures, and the report printed "PostgreSQL connections: 0 peak ✅" — a green check with no
     * observation behind it. A real database proves the fix; this keeps the shape from drifting back.
     */
    let seen = ''
    const sql = fakeSql((query) => {
      seen = query
      return [{ connections: 0, active: 0, idle_in_transaction: 0, waiting: 0 }]
    })
    await readPostgresActivity(sql)
    expect(seen).not.toMatch(/count\(\*\)::int\s+filter/i)
    expect(seen).toMatch(/\(count\(\*\)\s+filter\s*\(where[^)]*\)\)::int/i)
  })
})

describe('readPgBouncerPools', () => {
  const pools = (rows: Array<Record<string, unknown>>) => fakeSql(() => rows)

  it('sums server connections across pools', async () => {
    const sql = pools([
      { database: 'builderhunt', sv_active: 4, sv_idle: 2, sv_used: 1, cl_waiting: 0, maxwait: 0, maxwait_us: 0 },
      { database: 'builderhunt', sv_active: 3, sv_idle: 0, sv_used: 0, cl_waiting: 2, maxwait: 0, maxwait_us: 0 },
    ])
    const result = await readPgBouncerPools(sql)
    expect(result.backends).toBe(10)
    expect(result.clientsWaiting).toBe(2)
  })

  it('excludes the pooler\'s own admin pool', async () => {
    // Counting it reports the monitor's own console session as application load.
    const sql = pools([
      { database: 'pgbouncer', sv_active: 5, sv_idle: 5, sv_used: 0, cl_waiting: 9, maxwait: 3, maxwait_us: 0 },
      { database: 'builderhunt', sv_active: 1, sv_idle: 0, sv_used: 0, cl_waiting: 0, maxwait: 0, maxwait_us: 0 },
    ])
    const result = await readPgBouncerPools(sql)
    expect(result.backends).toBe(1)
    expect(result.clientsWaiting).toBe(0)
    expect(result.maxWaitMs).toBe(0)
  })

  it('combines maxwait seconds with the microsecond remainder', async () => {
    /**
     * The threshold this feeds is 50 ms.
     *
     * `maxwait` is whole seconds, so reading it alone reports `0` for every wait shorter than a second —
     * meaning the check would pass for every value it exists to catch. 12,000 µs is 12 ms and has to show up
     * as 12.
     */
    const sql = pools([
      { database: 'builderhunt', sv_active: 0, sv_idle: 0, sv_used: 0, cl_waiting: 1, maxwait: 0, maxwait_us: 12_000 },
    ])
    await expect(readPgBouncerPools(sql)).resolves.toMatchObject({ maxWaitMs: 12 })

    const overASecond = pools([
      { database: 'builderhunt', sv_active: 0, sv_idle: 0, sv_used: 0, cl_waiting: 1, maxwait: 2, maxwait_us: 500_000 },
    ])
    await expect(readPgBouncerPools(overASecond)).resolves.toMatchObject({ maxWaitMs: 2_500 })
  })

  it('reports the longest wait, not the sum of waits', async () => {
    const sql = pools([
      { database: 'a', sv_active: 0, sv_idle: 0, sv_used: 0, cl_waiting: 1, maxwait: 0, maxwait_us: 10_000 },
      { database: 'b', sv_active: 0, sv_idle: 0, sv_used: 0, cl_waiting: 1, maxwait: 0, maxwait_us: 30_000 },
    ])
    await expect(readPgBouncerPools(sql)).resolves.toMatchObject({ maxWaitMs: 30 })
  })
})

describe('readPgBouncerStats', () => {
  it('sums the query counter and takes the highest mean, never a sum of means', async () => {
    const sql = fakeSql(() => [
      { database: 'builderhunt', total_query_count: 1_000, avg_query_time: 400 },
      { database: 'builderhunt', total_query_count: 500, avg_query_time: 900 },
      { database: 'pgbouncer', total_query_count: 99, avg_query_time: 99_999 },
    ])
    await expect(readPgBouncerStats(sql)).resolves.toEqual({ totalQueryCount: 1_500, avgQueryTimeUs: 900 })
  })
})

describe('parseDockerBytes', () => {
  it('treats MiB and GiB as binary, because Docker does', () => {
    // Reading MiB as 10⁶ understates RSS by ~5%, which is inside the spec's 10% leak threshold — so the
    // wrong unit turns a real leak into a passing run.
    expect(parseDockerBytes('412.3MiB')).toBe(Math.round(412.3 * 1024 ** 2))
    expect(parseDockerBytes('1.5GiB')).toBe(Math.round(1.5 * 1024 ** 3))
  })

  it('still reads the decimal spellings', () => {
    expect(parseDockerBytes('100MB')).toBe(100_000_000)
    expect(parseDockerBytes('512B')).toBe(512)
  })

  it('returns null rather than a guess for anything it does not recognise', () => {
    for (const value of ['', 'lots', '12', '3 Pib', 'NaNMiB']) expect(parseDockerBytes(value)).toBeNull()
  })
})

describe('startMonitor', () => {
  it('records a sample even when the query fails, and counts the failure', async () => {
    /**
     * The gap that has to stay visible.
     *
     * A monitor that swallows a failed query produces a run with fewer data points, which reads as a shorter
     * run rather than as a broken sampler. Pushing the sample and counting the failure keeps the two apart.
     */
    const errors: string[] = []
    const monitor = await startMonitor({
      // Never connected: `postgres()` is lazy, so the first query is what fails.
      databaseUrl: 'postgresql://nobody:nothing@127.0.0.1:1/builderhunt_load_test_absent',
      intervalMs: 60_000,
      onError: (kind) => errors.push(kind),
    })
    await monitor.stop()

    expect(monitor.samples).toHaveLength(1)
    expect(monitor.failures.postgres).toBe(1)
    expect(errors).toEqual(['postgres'])
    // Null, not zero: nothing was observed, and the report has to be able to tell.
    expect(monitor.samples[0].postgresActive).toBeNull()
  })

  it('leaves every pooler field null when no pooler is configured', async () => {
    // A direct baseline has no PgBouncer numbers at all. Zeroes here would make `report.ts` evaluate pooled
    // thresholds against a topology that has no pooler in it.
    const monitor = await startMonitor({
      databaseUrl: 'postgresql://nobody:nothing@127.0.0.1:1/builderhunt_load_test_absent',
      intervalMs: 60_000,
    })
    await monitor.stop()
    const [sample] = monitor.samples
    expect(sample.pgBouncerBackends).toBeNull()
    expect(sample.pgBouncerClientsWaiting).toBeNull()
    expect(sample.pgBouncerMaxWaitMs).toBeNull()
    expect(sample.pgBouncerTotalQueryCount).toBeNull()
    expect(monitor.poolerConfig).toBeNull()
  })

  it('leaves container fields null when no container is named, without calling docker', async () => {
    const monitor = await startMonitor({
      databaseUrl: 'postgresql://nobody:nothing@127.0.0.1:1/builderhunt_load_test_absent',
      intervalMs: 60_000,
    })
    await monitor.stop()
    const [sample] = monitor.samples
    expect(sample.containerCpuPercent).toBeNull()
    expect(sample.containerRestarts).toBeNull()
    expect(sample.openFileDescriptors).toBeNull()
    expect(monitor.failures.container).toBe(0)
  })

  it('stops sampling once stopped', async () => {
    const monitor = await startMonitor({
      databaseUrl: 'postgresql://nobody:nothing@127.0.0.1:1/builderhunt_load_test_absent',
      intervalMs: 10,
    })
    await monitor.stop()
    const after = monitor.samples.length
    // Six intervals' worth of waiting: a timer that survived `stop()` would have fired several times.
    await new Promise((done) => setTimeout(done, 60))
    // A timer left running outsurvives the run and keeps writing into the array the report was built from.
    expect(monitor.samples.length).toBe(after)
  })
})
