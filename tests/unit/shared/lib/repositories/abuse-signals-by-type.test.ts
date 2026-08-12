import { describe, expect, it, vi } from 'vitest'
import {
  ACCOUNT_ANOMALY_TYPES,
  countAbuseSignalsByType,
} from '~/shared/lib/repositories/abuse-signals'

/**
 * `countAbuseSignalsByType` — the account-anomaly aggregate (plan 57, Admin track).
 *
 * ## Why this is a unit test with an injected `db`
 *
 * The function takes its database as a third parameter, so the two properties worth pinning can be checked without
 * a database at all: the zero-fill, and the vocabulary validation. Both are decisions in this function rather than
 * facts about Postgres.
 *
 * What a unit test cannot prove is that the query runs, and this repository has three defects on record from
 * exactly that gap — a superuser connection hides missing GRANTs. `abuse_signals` is worker-role-only with no RLS,
 * and `countAbuseSignalsBySeverity` beside it already executes against the real database through
 * `/api/admin/metrics/sections` in `admin-metrics-shell.spec.ts`, which is the same table, role and grant. The
 * `IN` clause is the only difference.
 */
describe('countAbuseSignalsByType', () => {
  /** A drizzle-shaped chain that records the filter it was handed and answers with fixed rows. */
  function fakeDb(rows: Array<{ type: string; total: number }>) {
    const groupBy = vi.fn().mockResolvedValue(rows)
    const where = vi.fn().mockReturnValue({ groupBy })
    const from = vi.fn().mockReturnValue({ where })
    const select = vi.fn().mockReturnValue({ from })
    return { db: { select } as never, select, from, where, groupBy }
  }

  it('returns every requested type, including the ones with no rows', async () => {
    /**
     * The property that keeps the distribution's shape stable between reads. Postgres returns no row for a type
     * with no signals, so without the pre-seeded zeros an operator comparing two windows would watch a type
     * vanish rather than watch it fall to nothing.
     */
    const { db } = fakeDb([{ type: 'impossible_travel', total: 3 }])
    const counts = await countAbuseSignalsByType(new Date('2026-08-11T00:00:00.000Z'), undefined, db)

    expect([...counts.keys()]).toEqual([...ACCOUNT_ANOMALY_TYPES])
    expect(counts.get('impossible_travel')).toBe(3)
    expect(counts.get('ua_change')).toBe(0)
    expect(counts.get('concurrent_sessions')).toBe(0)
    expect(counts.get('seat_overuse')).toBe(0)
  })

  it('ignores a row for a type it did not ask for', async () => {
    // The `IN` list bounds the query, and this bounds the result: a row arriving for something outside the
    // requested set would otherwise become a metric key nobody declared.
    const { db } = fakeDb([
      { type: 'impossible_travel', total: 1 },
      { type: 'credit_farming', total: 900 },
    ])
    const counts = await countAbuseSignalsByType(new Date(), undefined, db)
    expect(counts.has('credit_farming')).toBe(false)
    expect([...counts.values()].reduce((a, b) => a + b, 0)).toBe(1)
  })

  it('refuses a type that could not be a safe metric key, without querying for it', async () => {
    /**
     * These names become `account_anomaly_<type>` on an operator page, so an unvalidated value is unbounded label
     * cardinality. The callers all pass literals today; the validation is for the one that does not.
     */
    const { db, where } = fakeDb([])
    const counts = await countAbuseSignalsByType(new Date(), ['impossible_travel', 'DROP TABLE', 'ua-change'], db)
    expect([...counts.keys()]).toEqual(['impossible_travel'])
    expect(where).toHaveBeenCalledTimes(1)
  })

  it('does not query at all when every requested type was refused', async () => {
    // An empty `IN ()` is a syntax error in Postgres, so the guard is load-bearing rather than tidy.
    const { db, select } = fakeDb([])
    const counts = await countAbuseSignalsByType(new Date(), ['../../etc/passwd'], db)
    expect(counts.size).toBe(0)
    expect(select).not.toHaveBeenCalled()
  })

  it('excludes the three allowed types that no detector writes', async () => {
    /**
     * `abuse_signals_type_check` allows fourteen values; `signup_velocity`, `linked_account` and `reserve_leak`
     * are written by nothing — reserved in the vocabulary, never built. Grouping over the constraint would render
     * three permanent zeros, and "0 signup velocity anomalies" reads as a clean signal rather than as an absent
     * detector. This asserts the default set is the four with a real emitter.
     */
    for (const undetected of ['signup_velocity', 'linked_account', 'reserve_leak']) {
      expect(ACCOUNT_ANOMALY_TYPES as readonly string[]).not.toContain(undetected)
    }
    expect(ACCOUNT_ANOMALY_TYPES).toHaveLength(4)
  })
})
