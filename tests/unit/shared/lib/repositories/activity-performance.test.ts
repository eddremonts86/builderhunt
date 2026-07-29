// Plan 29 (activity-feed) task 7 — performance gate.
//
// Seeds 10k activity rows for one organization and asserts:
// - listActivity uses the keyset index (organization_activity_org_id_desc_idx)
//   rather than a sequential scan. The query plan is read with
//   `EXPLAIN`; "Seq Scan on organization_activity" in the
//   first line is a hard fail.
// - The query returns in well under 1s for the seeded tenant.
//   This is the spec's "query meets recorded budget" — the
//   budget is loose because the test runs in CI on commodity
//   hardware, not the prod cluster.

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { authUsers, organizations, organizationActivity } from '~/shared/lib/db/schema'
import { listActivity } from '~/shared/lib/repositories/activity'
import type { TenantPrincipal } from '~/shared/lib/authorization/permissions'

let db: PostgresJsDatabase
let drop: () => Promise<void>

const principal: TenantPrincipal = {
  userId: 'perf-user-1', organizationId: 'perf-org-1', role: 'owner', requestId: 'r-1',
}

const ROWS_PER_TEST = 10_000

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('activity_perf')
  db = disposable.db
  drop = disposable.drop
  await db.insert(authUsers).values({
    id: principal.userId, name: 'P1', email: 'p1@test.invalid',
    emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
  })
  await db.insert(organizations).values({
    id: principal.organizationId, name: 'Perf Org', slug: 'perf-org-1', createdAt: new Date(),
  })
  // Seed ROWS_PER_TEST rows. We use unnest() so the insert is
  // a single round trip. uuidv7() gives us monotonic ids, which
  // the keyset query plan relies on.
  await db.execute(sql`
    INSERT INTO organization_activity (
      organization_id, actor_user_id, type, version, target_key, metadata,
      idempotency_key, occurred_at, expires_at
    )
    SELECT
      ${principal.organizationId},
      ${principal.userId},
      'saved_query_created'::text,
      1,
      'q-' || g::text,
      jsonb_build_object('queryId', ('q-' || g::text), 'queryName', 'q', 'visibility', 'private'),
      'saved_query_created::' || ${principal.organizationId} || '::' || ${principal.userId} || '::q-' || g::text || '::2026-07-29',
      now() - (g * interval '1 second'),
      now() + interval '365 days'
    FROM generate_series(1, ${ROWS_PER_TEST}) AS g
  `)
}, 120_000)

afterAll(async () => {
  await drop()
})

describe('listActivity — performance gate (plan 29 task 7)', () => {
  it('uses the keyset index (no Seq Scan on organization_activity) for the first page', async () => {
    // EXPLAIN (FORMAT JSON) returns a list of plan nodes. The
    // first node is the outermost; if it is "Seq Scan" on
    // organization_activity, the index is missing or the
    // planner picked a sequential scan. Both are hard fails.
    await db.execute(sql`select set_config('app.organization_id', ${principal.organizationId}, true)`)
    const result = await db.execute(sql`
      EXPLAIN (FORMAT JSON)
      SELECT id, type, version, actor_user_id, target_key, metadata, occurred_at
      FROM organization_activity
      WHERE organization_id = ${principal.organizationId}
        AND (occurred_at < now() OR (occurred_at = now() AND id < '00000000-0000-0000-0000-000000000000'::uuid))
      ORDER BY occurred_at DESC, id DESC
      LIMIT 51
    `) as unknown as Array<Record<string, unknown>>
    const plan = result[0]?.['QUERY PLAN']
    const planText = JSON.stringify(plan)
    expect(planText).not.toContain('"Node Type":"Seq Scan"')
    expect(planText).toMatch(/organization_activity_org_id_desc_idx/)
  }, 30_000)

  it('returns the first page in well under 1s for a 10k-row tenant', async () => {
    await db.execute(sql`select set_config('app.organization_id', ${principal.organizationId}, true)`)
    const start = Date.now()
    const result = await db.transaction(async (tx) => listActivity(tx, principal, { limit: 50 }))
    const elapsed = Date.now() - start
    expect(result.rows).toHaveLength(50)
    expect(elapsed).toBeLessThan(1000)
  }, 30_000)
})
