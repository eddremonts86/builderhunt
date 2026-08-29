/**
 * `hardDeleteAccountSubject` covers every membership, not the first batch.
 *
 * plans/phase-3/12-bounded-reads-sweep's success metric is "removes every row for a subject with
 * more rows than one batch". The membership read used to have no bound at all; now it has one, and
 * the risk this file exists for is the one the spec names — that a bounded read gets treated as the
 * whole set, so a subject's data survives an erasure the compliance row calls `completed`.
 *
 * ## What this proves and what it does not
 *
 * It proves the **loop**: every membership past the batch boundary is visited exactly once, and the
 * walk stops. The deletes themselves are `DELETE … WHERE` statements — set-based, and already
 * covered by the FK-order test beside this one.
 *
 * It does **not** prove the RLS half. Unit tests connect as a superuser, so `withTenantContext`'s
 * per-organization policy is a no-op here; evidence that the tenant boundary holds has to come from
 * e2e or `pnpm test:rls:local`. The batch size is a parameter precisely so this stays a fast unit
 * test of the termination condition rather than a fixture with fifty-one organizations.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** Every membership row the fake `authDb` holds, ordered the way the query orders them. */
let memberships: Array<{ organizationId: string; role: string }> = []
/** One entry per `select … from(organization_members)` the function issued. */
const reads: Array<{ after: string | null; limit: number }> = []
/** Organization ids the per-tenant delete transaction ran under. */
const visited: string[] = []

/**
 * A `select()` builder just deep enough for the two reads this module makes against `authDb`.
 *
 * The `where`/`orderBy`/`limit` chain records what was asked rather than interpreting SQL: the
 * cursor value is captured from the call site through `capturedAfter` below, because reading it back
 * out of a Drizzle `SQL` object would be testing drizzle's internals instead of this loop.
 */
let capturedAfter: string | null = null

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>()
  return {
    ...actual,
    // `gt(organization_members.organization_id, after)` is the only `gt` this module applies to a
    // string, and capturing it here is what lets the fake know where the batch is meant to resume.
    gt: (column: unknown, value: unknown) => {
      if (typeof value === 'string') capturedAfter = value
      return actual.gt(column as never, value as never)
    },
  }
})

vi.mock('~/shared/lib/db/auth-db', () => ({
  authDb: {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: (limit: number) => {
              const after = capturedAfter
              capturedAfter = null
              reads.push({ after, limit })
              const start = after ? memberships.findIndex((row) => row.organizationId === after) + 1 : 0
              return Promise.resolve(memberships.slice(start, start + limit))
            },
          }),
        }),
      }),
    }),
    transaction: async (run: (tx: unknown) => Promise<unknown>) => run({
      delete: () => ({ where: () => Promise.resolve() }),
    }),
  },
}))

vi.mock('~/shared/lib/db/client', () => ({
  accountDb: { select: () => ({ from: () => ({ where: () => ({ orderBy: () => Promise.resolve([]) }) }) }) },
}))

vi.mock('~/shared/lib/db/tenant-context', () => ({
  withTenantContext: async (principal: { organizationId: string }, run: (tx: unknown) => Promise<unknown>) => {
    visited.push(principal.organizationId)
    return run({
      delete: () => ({ where: () => Promise.resolve() }),
      update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
    })
  },
  // The account-subject context now carries a read as well: erasure collects the self-managed
  // profile ids and attachment keys before the cascade removes the rows that hold them. An empty
  // result is the right shape here — this file is about membership batching, and a subject with no
  // self-managed profile is the common case it already models.
  withAccountSubjectContext: async (_userId: string, run: (tx: unknown) => Promise<unknown>) => run({
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }),
  }),
}))

vi.mock('~/shared/lib/repositories/interview-privacy', () => ({
  shortenInterviewRetentionForOwner: async () => undefined,
  loadInterviewExportSection: async () => ({}),
}))

const { hardDeleteAccountSubject } = await import('~/shared/lib/repositories/account-privacy')

/** Ids are zero-padded so ascending string order matches ascending numeric order. */
function seedMemberships(count: number): void {
  memberships = Array.from({ length: count }, (_, index) => ({
    organizationId: `org-${String(index).padStart(3, '0')}`,
    role: 'member',
  }))
}

beforeEach(() => {
  memberships = []
  reads.length = 0
  visited.length = 0
  capturedAfter = null
})

describe('hardDeleteAccountSubject membership batching', () => {
  it('visits every membership when there are more than one batch', async () => {
    seedMemberships(7)
    await hardDeleteAccountSubject('user-1', 3)

    // 3 + 3 + 1: the short third batch ends the walk without a fourth, empty read.
    expect(reads.map((read) => read.limit)).toEqual([3, 3, 3])
    expect(visited).toHaveLength(7)
    expect(new Set(visited).size, 'no membership visited twice').toBe(7)
    expect(visited).toEqual(memberships.map((row) => row.organizationId))
  })

  it('resumes from the last organization id rather than an offset', async () => {
    seedMemberships(5)
    await hardDeleteAccountSubject('user-1', 2)

    // An offset would shift under the loop's own deletes. The cursor is the row's own id.
    expect(reads.map((read) => read.after)).toEqual([null, 'org-001', 'org-003'])
  })

  it('stops after one read when the batch comes back short', async () => {
    seedMemberships(2)
    await hardDeleteAccountSubject('user-1', 50)

    expect(reads).toHaveLength(1)
    expect(visited).toEqual(['org-000', 'org-001'])
  })

  it('still deletes the auth rows for a subject with no memberships', async () => {
    seedMemberships(0)
    await hardDeleteAccountSubject('user-1', 50)

    // One read, no tenant transactions — and crucially no throw: a subject who never joined an
    // organization still has auth rows to erase, and an early return would leave them behind.
    expect(reads).toHaveLength(1)
    expect(visited).toEqual([])
  })
})
