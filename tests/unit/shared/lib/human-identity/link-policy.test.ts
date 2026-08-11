/**
 * plans/implemented/43-solutions-intelligence Phase 3 — the pure decision layer behind identity linking.
 *
 * `tests/unit/security/human-identity-linking.test.ts` proves the behaviour end to end against a
 * real database. This file covers the edges that never reach the database: score clamping, the
 * field-precedence tie-breaks, and queue ordering.
 */
import { describe, expect, it } from 'vitest'
import {
  chooseFieldValue,
  compareReviewQueue,
  decideLink,
  isActiveState,
  LINK_METHODS,
  type LinkMethod,
} from '~/shared/lib/human-identity/link-policy'

describe('decideLink', () => {
  it.each([0, 5_000, 9_999, 10_000])('queues a probabilistic signal at %i bps', (similarityBps) => {
    const decision = decideLink({ kind: 'probabilistic', basis: 'combined', similarityBps })
    // The score is data, never authority — asserted across the whole range so no threshold can
    // creep in later.
    expect(decision.reviewState).toBe('pending_review')
    expect(decision.method).toBe('probabilistic_candidate')
  })

  it.each([
    [-1, 0],
    [10_001, 10_000],
    // Non-finite is "no answer", not "maximally certain" — a broken scorer must not outrank genuine
    // high-confidence candidates in the review queue. See `clampBps`.
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0],
    [Number.NEGATIVE_INFINITY, 0],
  ])('clamps a similarity of %s to %i', (input, expected) => {
    // The scorer is upstream and may be wrong; the column has a 0-10000 CHECK and an out-of-range
    // value would fail the insert rather than the comparison.
    expect(decideLink({ kind: 'probabilistic', basis: 'display_name', similarityBps: input }).confidenceBps).toBe(expected)
  })

  it('rates a bidirectional cross-link above a one-way one', () => {
    const oneWay = decideLink({ kind: 'explicit_cross_link', fromBuilderIdentityId: 'a', declaredUrl: 'https://x.test/b', bidirectional: false })
    const both = decideLink({ kind: 'explicit_cross_link', fromBuilderIdentityId: 'a', declaredUrl: 'https://x.test/b', bidirectional: true })
    // Both sides publishing is harder to fake than one side pointing anywhere it likes.
    expect(both.confidenceBps).toBeGreaterThan(oneWay.confidenceBps)
    expect(oneWay.reviewState).toBe('auto_approved')
  })

  it('gives a verified claim full confidence', () => {
    const decision = decideLink({ kind: 'verified_claim', claimId: 'c1', subjectUserId: 'u1' })
    expect(decision.confidenceBps).toBe(10_000)
    expect(decision.reviewState).toBe('auto_approved')
  })

  it('stores a deterministic match as a digest, never a plaintext value', () => {
    const decision = decideLink({ kind: 'reviewed_deterministic', signal: 'verified_email_hash', reviewedByUserId: 'r1', digest: 'deadbeef' })
    // `human_source_links` is global-public; an email address has no business on it.
    expect(decision.evidence).toEqual({ signal: 'verified_email_hash', digest: 'deadbeef', reviewedByUserId: 'r1' })
    expect(JSON.stringify(decision.evidence)).not.toMatch(/@/)
  })

  it('always explains itself, so the review queue and audit trail are readable', () => {
    for (const method of LINK_METHODS) {
      const signal = SIGNAL_FOR[method]
      expect(decideLink(signal).rationale.length).toBeGreaterThan(0)
    }
  })
})

const SIGNAL_FOR: Record<LinkMethod, Parameters<typeof decideLink>[0]> = {
  verified_claim: { kind: 'verified_claim', claimId: 'c', subjectUserId: 'u' },
  explicit_cross_link: { kind: 'explicit_cross_link', fromBuilderIdentityId: 'a', declaredUrl: 'https://x.test/b', bidirectional: true },
  reviewed_deterministic: { kind: 'reviewed_deterministic', signal: 'signing_key', reviewedByUserId: 'r', digest: 'd' },
  probabilistic_candidate: { kind: 'probabilistic', basis: 'topic_overlap', similarityBps: 5_000 },
}

describe('isActiveState', () => {
  it.each([['auto_approved', true], ['approved', true], ['pending_review', false], ['rejected', false]] as const)(
    '%s -> %s',
    (state, expected) => expect(isActiveState(state)).toBe(expected),
  )
})

describe('chooseFieldValue', () => {
  const at = (iso: string) => new Date(iso)

  it('takes any value over an absent one', () => {
    const result = chooseFieldValue(null, { value: 'Alice', sourceLinkId: 'l1', method: 'probabilistic_candidate', observedAt: at('2026-01-01T00:00:00Z') })
    expect(result).toMatchObject({ value: 'Alice', replaced: true })
  })

  it('lets stronger evidence win regardless of recency', () => {
    const result = chooseFieldValue(
      { value: 'Old', sourceLinkId: 'l1', method: 'reviewed_deterministic', observedAt: at('2026-08-01T00:00:00Z') },
      { value: 'New', sourceLinkId: 'l2', method: 'verified_claim', observedAt: at('2026-01-01T00:00:00Z') },
    )
    // A claim the subject proved outranks a stale-but-recent inference.
    expect(result).toMatchObject({ value: 'New', sourceLinkId: 'l2', replaced: true })
  })

  it('keeps the stronger existing value against weaker newer evidence', () => {
    const result = chooseFieldValue(
      { value: 'Verified', sourceLinkId: 'l1', method: 'verified_claim', observedAt: at('2026-01-01T00:00:00Z') },
      { value: 'Guessed', sourceLinkId: 'l2', method: 'explicit_cross_link', observedAt: at('2026-08-01T00:00:00Z') },
    )
    expect(result).toMatchObject({ value: 'Verified', replaced: false })
  })

  it('breaks a tie in evidence strength by recency', () => {
    const result = chooseFieldValue(
      { value: 'Older', sourceLinkId: 'l1', method: 'explicit_cross_link', observedAt: at('2026-01-01T00:00:00Z') },
      { value: 'Newer', sourceLinkId: 'l2', method: 'explicit_cross_link', observedAt: at('2026-08-01T00:00:00Z') },
    )
    expect(result).toMatchObject({ value: 'Newer', replaced: true })
  })

  it('does not replace on an equal-strength, equal-time collision', () => {
    const same = at('2026-08-01T00:00:00Z')
    const result = chooseFieldValue(
      { value: 'Incumbent', sourceLinkId: 'l1', method: 'explicit_cross_link', observedAt: same },
      { value: 'Challenger', sourceLinkId: 'l2', method: 'explicit_cross_link', observedAt: same },
    )
    // Deterministic: two observations arriving with identical timestamps must not make the
    // projection depend on evaluation order.
    expect(result).toMatchObject({ value: 'Incumbent', replaced: false })
  })

  it('never lets a queued proposal supply a field, even against nothing', () => {
    const result = chooseFieldValue(
      { value: 'Real', sourceLinkId: 'l1', method: 'reviewed_deterministic', observedAt: at('2026-01-01T00:00:00Z') },
      { value: 'Guess', sourceLinkId: 'l2', method: 'probabilistic_candidate', observedAt: at('2026-12-01T00:00:00Z') },
    )
    expect(result).toMatchObject({ value: 'Real', replaced: false })
  })
})

describe('compareReviewQueue', () => {
  it('orders by confidence first, then oldest, so nothing starves', () => {
    const entries = [
      { id: 'low-new', confidenceBps: 4_000, createdAt: new Date('2026-08-01T00:00:00Z') },
      { id: 'high-new', confidenceBps: 9_000, createdAt: new Date('2026-08-01T00:00:00Z') },
      { id: 'high-old', confidenceBps: 9_000, createdAt: new Date('2026-01-01T00:00:00Z') },
    ]
    expect([...entries].sort(compareReviewQueue).map((e) => e.id)).toEqual(['high-old', 'high-new', 'low-new'])
  })
})
