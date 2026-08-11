/**
 * The observability queries, apart from the thing that schedules them (plan 55 phase 0).
 *
 * ## Why the SQL lives on its own
 *
 * Each of these is a statement about what a number means, and each is easy to get subtly wrong in a way that
 * still produces a plausible figure. `pg_stat_activity` counts *backends*, which includes this monitor's own
 * connection and every idle one; `SHOW POOLS` reports per-pool rows that have to be summed rather than read;
 * `maxwait` is seconds in one column and microseconds in another. Keeping them here means each can carry the
 * reasoning next to the query, and the scheduler in `monitor.ts` stays about timing.
 *
 * ## Why nothing here formats output
 *
 * Every function returns numbers. A connection string reaches this module and must not leave it, so no
 * function accepts a logger or builds a message — `assertNoSecrets` in `report.ts` is the last line of
 * defence, and it should never be the first one that gets a chance to fire.
 */

import type { Sql } from 'postgres'

export interface PostgresActivity {
  /** Backends against the target database, excluding this monitor's own connection. */
  connections: number
  /** Of those, the ones actually executing. A high total with a low active count is a pool holding idles. */
  active: number
  idleInTransaction: number
  waiting: number
}

/**
 * Counts backends for one database.
 *
 * Excludes `pid = pg_backend_pid()` — the monitor's own connection would otherwise add one to every sample,
 * which matters at a threshold of 100 and matters more when several monitors run.
 *
 * `datname` is compared to `current_database()` rather than to a name passed in, so the count cannot
 * accidentally describe a different database than the one this connection is pointed at.
 */
export async function readPostgresActivity(sql: Sql): Promise<PostgresActivity> {
  const [row] = await sql.unsafe<Array<{
    connections: number
    active: number
    idle_in_transaction: number
    waiting: number
  }>>(
    /**
     * The cast wraps the whole aggregate, parentheses included.
     *
     * `count(*)::int filter (where …)` is a syntax error — `FILTER` has to follow the aggregate call
     * directly, before any cast. The first version had it the other way round, so every sample threw, the
     * monitor counted three failures, and the report printed "PostgreSQL connections: 0 peak ✅" for a run
     * that had observed nothing at all. A threshold satisfied by the absence of data is the worst kind of
     * green, which is why `runner.ts` now aborts a run whose every sample failed.
     */
    `select
       (count(*) filter (where pid <> pg_backend_pid()))::int                          as connections,
       (count(*) filter (where state = 'active' and pid <> pg_backend_pid()))::int      as active,
       (count(*) filter (where state = 'idle in transaction'))::int                     as idle_in_transaction,
       (count(*) filter (where wait_event_type is not null and state = 'active'))::int  as waiting
     from pg_stat_activity
     where datname = current_database()`,
  )
  return {
    connections: Number(row?.connections ?? 0),
    active: Number(row?.active ?? 0),
    idleInTransaction: Number(row?.idle_in_transaction ?? 0),
    waiting: Number(row?.waiting ?? 0),
  }
}

export interface PgBouncerPools {
  /** Server-side connections PgBouncer holds open, summed across pools. */
  backends: number
  /** Clients queued for a server connection. The number the transaction-pooling target is about. */
  clientsWaiting: number
  /** Longest current wait, in milliseconds. */
  maxWaitMs: number
}

/**
 * Reads `SHOW POOLS` from the admin console.
 *
 * Three things this gets right that a naive version does not.
 *
 * `SHOW POOLS` returns one row per (database, user) pool, and the `pgbouncer` internal pool is one of them —
 * summing everything would count the admin console's own connection as application load. It is excluded by
 * name.
 *
 * `maxwait` is whole seconds and `maxwait_us` is the microsecond remainder, so the wait is
 * `maxwait * 1000 + maxwait_us / 1000`. Reading `maxwait` alone reports `0` for every wait under a second —
 * and the threshold this feeds is 50 ms, so the check would pass for every value it is meant to catch.
 *
 * The admin console does not speak the extended query protocol, which is why every call here is `unsafe`
 * with no parameters.
 */
export async function readPgBouncerPools(sql: Sql): Promise<PgBouncerPools> {
  const rows = await sql.unsafe<Array<Record<string, unknown>>>('SHOW POOLS')
  let backends = 0
  let clientsWaiting = 0
  let maxWaitMs = 0
  for (const row of rows) {
    if (String(row.database ?? '') === 'pgbouncer') continue
    backends += Number(row.sv_active ?? 0) + Number(row.sv_idle ?? 0) + Number(row.sv_used ?? 0)
    clientsWaiting += Number(row.cl_waiting ?? 0)
    const wait = Number(row.maxwait ?? 0) * 1_000 + Number(row.maxwait_us ?? 0) / 1_000
    if (wait > maxWaitMs) maxWaitMs = wait
  }
  return { backends, clientsWaiting, maxWaitMs: Math.round(maxWaitMs) }
}

export interface PgBouncerConfigFacts {
  poolMode: string | null
  maxClientConn: number | null
  defaultPoolSize: number | null
}

/**
 * The pooler's own view of its configuration.
 *
 * Read at the start of a run and printed in the report, because "pooled" is not one topology: the same
 * numbers mean different things under session and transaction pooling, and a run that believed it was
 * testing transaction mode against a session-mode pooler would report a capacity ceiling that is an artifact
 * of the configuration.
 */
export async function readPgBouncerConfig(sql: Sql): Promise<PgBouncerConfigFacts> {
  const rows = await sql.unsafe<Array<{ key?: string; value?: string }>>('SHOW CONFIG')
  const pick = (key: string): string | null => {
    const row = rows.find((entry) => String(entry.key ?? '') === key)
    return row?.value === undefined ? null : String(row.value)
  }
  const number = (key: string): number | null => {
    const value = pick(key)
    if (value === null) return null
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return {
    poolMode: pick('pool_mode'),
    maxClientConn: number('max_client_conn'),
    defaultPoolSize: number('default_pool_size'),
  }
}

export interface PgBouncerStats {
  /** Queries PgBouncer has proxied since it started, summed across pools. */
  totalQueryCount: number
  /** Mean query time in microseconds, as PgBouncer computes it over its own stats window. */
  avgQueryTimeUs: number
}

/**
 * Reads `SHOW STATS`, the other half of the spec's pooler contract.
 *
 * `SHOW POOLS` says how many connections are held right now; `SHOW STATS` says how much work went through
 * them. Both are needed to tell "the pooler is idle because the load stopped" from "the pooler is idle
 * because it is not in the path" — the second is a topology mistake that a pools-only reading cannot see.
 *
 * Cumulative counters, not rates. Reported as a peak, which for a monotonic counter is its final value, and
 * that is the honest thing to publish for a single run.
 */
export async function readPgBouncerStats(sql: Sql): Promise<PgBouncerStats> {
  const rows = await sql.unsafe<Array<Record<string, unknown>>>('SHOW STATS')
  let totalQueryCount = 0
  let avgQueryTimeUs = 0
  for (const row of rows) {
    if (String(row.database ?? '') === 'pgbouncer') continue
    totalQueryCount += Number(row.total_query_count ?? 0)
    // The maximum rather than a sum: an average summed across pools is not an average of anything.
    avgQueryTimeUs = Math.max(avgQueryTimeUs, Number(row.avg_query_time ?? 0))
  }
  return { totalQueryCount, avgQueryTimeUs: Math.round(avgQueryTimeUs) }
}
