/**
 * The removal-request metric carries counts and nothing that could identify a requester (plan 52).
 *
 * A removal request is someone asking not to be in this product. The request is therefore *more* sensitive
 * than the profile it concerns: it reveals that a specific person objects to being indexed, which is precisely
 * the fact an operator has no business browsing while checking a dashboard.
 *
 * So this test is written as a denial rather than a confirmation. It seeds a request whose every field is a
 * recognisable canary, asks for the metric, and requires that **none** of those canaries appear anywhere in the
 * serialized payload. That shape matters: a test listing the fields it expects would pass forever while a
 * future column joined the aggregate by accident. A test listing the values that must never appear fails the
 * moment one does, whatever it is called and however deeply it is nested.
 */
import { describe, expect, it, vi } from 'vitest'
import { getRemovalRequestMetrics } from '~/shared/lib/repositories/profile-removal'

/** Values that identify a person. If any reaches the payload, the redaction has failed. */
const CANARIES = {
  requesterEmailHash: 'CANARY_EMAIL_HASH_9f2c',
  normalizedProfileUrl: 'https://canary.invalid/people/CANARY_PROFILE',
  sourceId: 'CANARY_SOURCE_ID_4471',
  challengeHash: 'CANARY_CHALLENGE_HASH_a17b',
  id: 'CANARY_REQUEST_ID_0001',
}

/**
 * A stand-in for the database that answers the two aggregate queries.
 *
 * Deliberately returns rows shaped like the *real* grouped result — `{ status, count }` and
 * `{ source, count }` — plus the canary columns a careless `select *` would drag along. If the implementation
 * ever widens its projection, those extra columns arrive here and the assertions below catch them.
 */
function fakeDb(rows: Array<Record<string, unknown>>) {
  let call = 0
  return {
    execute: vi.fn(async () => {
      call += 1
      return call === 1
        ? [{ status: 'pending', count: '2', ...CANARIES }, { status: 'verified', count: '1', ...CANARIES }]
        : rows
    }),
  } as unknown as Parameters<typeof getRemovalRequestMetrics>[0]
}

describe('removal-request metrics redaction', () => {
  it('reports counts by status and by source', async () => {
    const metrics = await getRemovalRequestMetrics(
      fakeDb([{ source: 'github', count: '2', ...CANARIES }, { source: 'linkedin', count: '1', ...CANARIES }]),
    )

    expect(metrics.byStatus.pending).toBe(2)
    expect(metrics.byStatus.verified).toBe(1)
    expect(metrics.bySource).toEqual([
      { source: 'github', count: 2 },
      { source: 'linkedin', count: 1 },
    ])
    expect(metrics.total).toBe(3)
  })

  it('reports every status, including the ones with no requests', async () => {
    /**
     * Zero rather than absent. A missing key reads as "no data" and invites a dashboard to render a gap where
     * the honest answer is "none yet" — and "we do not know how many rejections there were" is a very different
     * statement from "there were none".
     */
    const metrics = await getRemovalRequestMetrics(fakeDb([]))
    expect(Object.keys(metrics.byStatus).sort()).toEqual(['expired', 'pending', 'rejected', 'verified'])
    expect(metrics.byStatus.rejected).toBe(0)
    expect(metrics.byStatus.expired).toBe(0)
  })

  it('carries no value that could identify a requester', async () => {
    /**
     * The assertion this file exists for, and it is deliberately blunt: the whole payload is serialized and
     * searched for each canary. Blunt is right here — the danger is a field nobody thought to name, and a
     * precise assertion cannot fail on a column that does not exist yet.
     *
     * The hashed email is included on purpose. A hash is not anonymous, it is a *join key*: two systems holding
     * the same hash can be correlated, and an operator with a candidate address can confirm a match by hashing
     * it themselves. Counts cannot be correlated with anything.
     */
    const metrics = await getRemovalRequestMetrics(
      fakeDb([{ source: 'github', count: '2', ...CANARIES }]),
    )
    const serialized = JSON.stringify(metrics)

    for (const [field, value] of Object.entries(CANARIES)) {
      expect(serialized, `the metric payload leaked ${field}`).not.toContain(value)
    }
  })

  it('exposes only the three aggregate keys', async () => {
    // Paired with the canary check above: that one catches a leaked *value*, this catches a leaked *shape* —
    // a new key added to the return type without anyone deciding it is safe to publish.
    const metrics = await getRemovalRequestMetrics(fakeDb([]))
    expect(Object.keys(metrics).sort()).toEqual(['bySource', 'byStatus', 'total'])
  })
})
