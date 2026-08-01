/**
 * plans/phase-1/43-solutions-intelligence Phase 3, "Implement reversible identity linking".
 * Verify line: "collision/adversarial fixtures prove username similarity cannot merge people and
 * unmerge restores every source account and organization reference."
 *
 * The adversary here is not a hacker, it is a plausible-looking similarity score. Plan 43 Phase 2
 * removed a username-equality merge from `dedup.ts` that fused unrelated people who shared a handle
 * and made the losers unfindable; the point of these tests is that no amount of resemblance can
 * reproduce that outcome through this module.
 */
import { and, eq, isNull } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { authUsers, builderIdentities, canonicalHumans, humanMergeEvents, humanSourceLinks } from '~/shared/lib/db/schema'
import {
  findCanonicalHuman,
  findCanonicalHumanForAccount,
  linkSourceAccount,
  listLinkReviewQueue,
  listMergeHistory,
  mergeCanonicalHumans,
  resolveLinkReview,
  unmergeCanonicalHumans,
  withdrawSourceLink,
} from '~/shared/lib/repositories/human-profiles'

let db: PostgresJsDatabase
let drop: () => Promise<void>

const REVIEWER = 'hil-reviewer'

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('human_identity_linking')
  db = disposable.db
  drop = disposable.drop
  await db.insert(authUsers).values({
    id: REVIEWER, name: 'Reviewer', email: 'hil-reviewer@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
  })
}, 180_000)

afterAll(async () => { await drop() })

beforeEach(async () => {
  await db.delete(humanMergeEvents)
  await db.delete(humanSourceLinks)
  await db.delete(canonicalHumans)
  await db.delete(builderIdentities)
  // Two different people who both call themselves "alice".
  await db.insert(builderIdentities).values([
    { id: 'gh-alice', source: 'github', sourceId: 'gh-1', username: 'alice', displayName: 'Alice Alpha', profileUrl: 'https://github.com/alice' },
    { id: 'hn-alice', source: 'hn', sourceId: 'hn-1', username: 'alice', displayName: 'Alice Beta', profileUrl: 'https://news.ycombinator.com/user?id=alice' },
    { id: 'gl-alice', source: 'gitlab', sourceId: 'gl-1', username: 'alice', displayName: 'Alice Alpha', profileUrl: 'https://gitlab.com/alice' },
  ])
})

describe('similarity cannot merge people', () => {
  it('queues a near-certain name match instead of linking it', async () => {
    const result = await linkSourceAccount({
      builderIdentityId: 'gh-alice',
      signal: { kind: 'probabilistic', basis: 'display_name', similarityBps: 9_999 },
    }, db)

    // 9999/10000 is as confident as a similarity signal can be, and it still only asks.
    expect(result.reviewState).toBe('pending_review')
    expect(result.active).toBe(false)
    // Crucially: not attached. A queued proposal must not change what the public sees.
    expect(await findCanonicalHumanForAccount('gh-alice', db)).toBeNull()
  })

  it('does not let a queued proposal claim the account before a verified claim arrives', async () => {
    const proposal = await linkSourceAccount({
      builderIdentityId: 'gh-alice',
      signal: { kind: 'probabilistic', basis: 'combined', similarityBps: 9_800 },
    }, db)

    const verified = await linkSourceAccount({
      builderIdentityId: 'gh-alice',
      signal: { kind: 'verified_claim', claimId: 'claim-1', subjectUserId: 'user-1' },
    }, db)

    // The real owner wins, and the guess is still sitting in the queue where it belongs.
    expect(verified.active).toBe(true)
    const attached = await findCanonicalHumanForAccount('gh-alice', db)
    expect(attached?.id).toBe(verified.canonicalHumanId)
    expect(attached?.id).not.toBe(proposal.canonicalHumanId)
  })

  it('keeps two same-username accounts as separate people when only resemblance connects them', async () => {
    const first = await linkSourceAccount({
      builderIdentityId: 'gh-alice',
      signal: { kind: 'verified_claim', claimId: 'claim-1', subjectUserId: 'user-1' },
      projected: { displayName: 'Alice Alpha' },
    }, db)
    // Someone proposes that the HN "alice" is the same person, on the strength of the handle.
    await linkSourceAccount({
      builderIdentityId: 'hn-alice',
      canonicalHumanId: first.canonicalHumanId,
      signal: { kind: 'probabilistic', basis: 'display_name', similarityBps: 10_000 },
    }, db)

    const human = await findCanonicalHuman(first.canonicalHumanId, db)
    // One account attached, one queued. This is the regression that made a real builder unfindable.
    expect(human?.activeBuilderIdentityIds).toEqual(['gh-alice'])
    expect(await findCanonicalHumanForAccount('hn-alice', db)).toBeNull()
  })

  it('records the similarity score without letting it decide', async () => {
    await linkSourceAccount({
      builderIdentityId: 'gh-alice',
      signal: { kind: 'probabilistic', basis: 'embedding_proximity', similarityBps: 9_400 },
    }, db)
    const [queued] = await listLinkReviewQueue(50, db)
    // The score is kept — it orders the reviewer's work — but it is not authority.
    expect(queued.confidenceBps).toBe(9_400)
    expect(queued.linkMethod).toBe('probabilistic_candidate')
  })

  it('never writes a projected field from a queued proposal', async () => {
    const proposal = await linkSourceAccount({
      builderIdentityId: 'hn-alice',
      signal: { kind: 'probabilistic', basis: 'display_name', similarityBps: 9_900 },
      projected: { displayName: 'Alice Beta', country: 'PT' },
    }, db)

    const human = await findCanonicalHuman(proposal.canonicalHumanId, db)
    // Otherwise an unreviewed guess would silently rewrite a person's public country.
    expect(human?.displayName).toBeNull()
    expect(human?.country).toBeNull()
  })
})

describe('evidence links, and only a reviewer promotes a guess', () => {
  it.each([
    ['verified_claim', { kind: 'verified_claim', claimId: 'c1', subjectUserId: 'u1' } as const, 10_000],
    ['explicit_cross_link (bidirectional)', { kind: 'explicit_cross_link', fromBuilderIdentityId: 'hn-alice', declaredUrl: 'https://github.com/alice', bidirectional: true } as const, 9_500],
    ['explicit_cross_link (one-way)', { kind: 'explicit_cross_link', fromBuilderIdentityId: 'hn-alice', declaredUrl: 'https://github.com/alice', bidirectional: false } as const, 7_500],
    ['reviewed_deterministic', { kind: 'reviewed_deterministic', signal: 'verified_email_hash', reviewedByUserId: REVIEWER, digest: 'abc' } as const, 9_000],
  ])('%s attaches immediately', async (_label, signal, expectedBps) => {
    const result = await linkSourceAccount({ builderIdentityId: 'gh-alice', signal }, db)
    expect(result.active).toBe(true)
    const [row] = await db.select().from(humanSourceLinks)
    expect(row.confidenceBps).toBe(expectedBps)
  })

  it('approving a queued proposal is what makes it active', async () => {
    const proposal = await linkSourceAccount({
      builderIdentityId: 'gh-alice',
      signal: { kind: 'probabilistic', basis: 'combined', similarityBps: 8_000 },
    }, db)
    expect(await findCanonicalHumanForAccount('gh-alice', db)).toBeNull()

    const resolved = await resolveLinkReview({ sourceLinkId: proposal.sourceLinkId, verdict: 'approved', reviewerUserId: REVIEWER }, db)

    expect(resolved).toBe(true)
    expect((await findCanonicalHumanForAccount('gh-alice', db))?.id).toBe(proposal.canonicalHumanId)
  })

  it('rejecting leaves the account unattached and frees it for a correct link', async () => {
    const proposal = await linkSourceAccount({
      builderIdentityId: 'gh-alice',
      signal: { kind: 'probabilistic', basis: 'display_name', similarityBps: 9_000 },
    }, db)
    await resolveLinkReview({ sourceLinkId: proposal.sourceLinkId, verdict: 'rejected', reviewerUserId: REVIEWER }, db)

    expect(await findCanonicalHumanForAccount('gh-alice', db)).toBeNull()
    const correct = await linkSourceAccount({
      builderIdentityId: 'gh-alice',
      signal: { kind: 'verified_claim', claimId: 'c1', subjectUserId: 'u1' },
    }, db)
    expect((await findCanonicalHumanForAccount('gh-alice', db))?.id).toBe(correct.canonicalHumanId)
  })

  it('refuses a second verdict on an already-resolved proposal', async () => {
    const proposal = await linkSourceAccount({
      builderIdentityId: 'gh-alice',
      signal: { kind: 'probabilistic', basis: 'combined', similarityBps: 8_000 },
    }, db)
    expect(await resolveLinkReview({ sourceLinkId: proposal.sourceLinkId, verdict: 'approved', reviewerUserId: REVIEWER }, db)).toBe(true)
    // Two reviewers racing must not have the second silently overwrite the first's decision.
    expect(await resolveLinkReview({ sourceLinkId: proposal.sourceLinkId, verdict: 'rejected', reviewerUserId: REVIEWER }, db)).toBe(false)
  })

  it('lets one person hold several accounts', async () => {
    const first = await linkSourceAccount({
      builderIdentityId: 'gh-alice',
      signal: { kind: 'verified_claim', claimId: 'c1', subjectUserId: 'u1' },
    }, db)
    await linkSourceAccount({
      builderIdentityId: 'gl-alice',
      canonicalHumanId: first.canonicalHumanId,
      signal: { kind: 'explicit_cross_link', fromBuilderIdentityId: 'gh-alice', declaredUrl: 'https://gitlab.com/alice', bidirectional: true },
    }, db)

    const human = await findCanonicalHuman(first.canonicalHumanId, db)
    expect(human?.activeBuilderIdentityIds).toEqual(['gh-alice', 'gl-alice'])
  })
})

describe('field provenance', () => {
  it('lets stronger evidence take over a field and records where the value came from', async () => {
    const weak = await linkSourceAccount({
      builderIdentityId: 'gl-alice',
      signal: { kind: 'explicit_cross_link', fromBuilderIdentityId: 'gh-alice', declaredUrl: 'https://gitlab.com/alice', bidirectional: false },
      projected: { displayName: 'A. Alpha' },
    }, db)
    await linkSourceAccount({
      builderIdentityId: 'gh-alice',
      canonicalHumanId: weak.canonicalHumanId,
      signal: { kind: 'verified_claim', claimId: 'c1', subjectUserId: 'u1' },
      projected: { displayName: 'Alice Alpha' },
    }, db)

    const [human] = await db.select().from(canonicalHumans).where(eq(canonicalHumans.id, weak.canonicalHumanId))
    expect(human.displayName).toBe('Alice Alpha')
    // The provenance points at the link that supplied the surviving value, which is what an unmerge
    // needs in order to detach it again.
    const provenance = human.fieldProvenance as Record<string, { sourceLinkId: string }>
    expect(provenance.displayName.sourceLinkId).not.toBe(weak.sourceLinkId)
  })

  it('does not let weaker evidence overwrite a stronger value', async () => {
    const strong = await linkSourceAccount({
      builderIdentityId: 'gh-alice',
      signal: { kind: 'verified_claim', claimId: 'c1', subjectUserId: 'u1' },
      projected: { displayName: 'Alice Alpha' },
    }, db)
    await linkSourceAccount({
      builderIdentityId: 'gl-alice',
      canonicalHumanId: strong.canonicalHumanId,
      signal: { kind: 'explicit_cross_link', fromBuilderIdentityId: 'gh-alice', declaredUrl: 'https://gitlab.com/alice', bidirectional: false },
      projected: { displayName: 'Something Else' },
    }, db)

    const [human] = await db.select().from(canonicalHumans).where(eq(canonicalHumans.id, strong.canonicalHumanId))
    expect(human.displayName).toBe('Alice Alpha')
  })
})

describe('withdrawal keeps history and frees the account', () => {
  it('detaches without deleting, and allows a correct re-link elsewhere', async () => {
    const wrong = await linkSourceAccount({
      builderIdentityId: 'gh-alice',
      signal: { kind: 'reviewed_deterministic', signal: 'verified_email_hash', reviewedByUserId: REVIEWER, digest: 'oops' },
    }, db)

    expect(await withdrawSourceLink({ sourceLinkId: wrong.sourceLinkId }, db)).toBe(true)
    expect(await findCanonicalHumanForAccount('gh-alice', db)).toBeNull()

    const right = await linkSourceAccount({
      builderIdentityId: 'gh-alice',
      signal: { kind: 'verified_claim', claimId: 'c1', subjectUserId: 'u1' },
    }, db)
    expect((await findCanonicalHumanForAccount('gh-alice', db))?.id).toBe(right.canonicalHumanId)

    // The mistake is still on the record — the row was invalidated, not erased.
    const all = await db.select().from(humanSourceLinks)
    expect(all).toHaveLength(2)
    expect(all.filter((r) => r.validUntil !== null)).toHaveLength(1)
  })

  it('is idempotent — withdrawing twice reports the second as a no-op', async () => {
    const link = await linkSourceAccount({
      builderIdentityId: 'gh-alice',
      signal: { kind: 'verified_claim', claimId: 'c1', subjectUserId: 'u1' },
    }, db)
    expect(await withdrawSourceLink({ sourceLinkId: link.sourceLinkId }, db)).toBe(true)
    expect(await withdrawSourceLink({ sourceLinkId: link.sourceLinkId }, db)).toBe(false)
  })
})

describe('unmerge restores every source account', () => {
  async function twoPeopleThenMerge() {
    const alpha = await linkSourceAccount({
      builderIdentityId: 'gh-alice',
      signal: { kind: 'verified_claim', claimId: 'c1', subjectUserId: 'u1' },
      projected: { displayName: 'Alice Alpha', country: 'ES' },
    }, db)
    const beta = await linkSourceAccount({
      builderIdentityId: 'hn-alice',
      signal: { kind: 'verified_claim', claimId: 'c2', subjectUserId: 'u2' },
      projected: { displayName: 'Alice Beta', language: 'pt' },
    }, db)
    const merge = await mergeCanonicalHumans({
      targetCanonicalHumanId: alpha.canonicalHumanId,
      sourceCanonicalHumanId: beta.canonicalHumanId,
      reason: 'Confirmed same person on both platforms',
      performedByUserId: REVIEWER,
    }, db)
    return { alpha, beta, merge }
  }

  it('moves the absorbed accounts to the surviving human', async () => {
    const { alpha, merge } = await twoPeopleThenMerge()
    expect(merge.movedSourceLinkIds).toHaveLength(1)

    const human = await findCanonicalHuman(alpha.canonicalHumanId, db)
    expect(human?.activeBuilderIdentityIds).toEqual(['gh-alice', 'hn-alice'])
  })

  it('fills only fields the survivor was missing', async () => {
    const { alpha } = await twoPeopleThenMerge()
    const [human] = await db.select().from(canonicalHumans).where(eq(canonicalHumans.id, alpha.canonicalHumanId))
    // Its own displayName survives; the absorbed language fills a gap.
    expect(human.displayName).toBe('Alice Alpha')
    expect(human.country).toBe('ES')
    expect(human.language).toBe('pt')
  })

  it('puts every account back on unmerge', async () => {
    const { alpha, beta, merge } = await twoPeopleThenMerge()

    expect(await unmergeCanonicalHumans({ mergeEventId: merge.mergeEventId, revertedByUserId: REVIEWER }, db)).toBe(true)

    // This is the property the whole design exists for: a mistaken merge of two real people is
    // fully recoverable, including which account belonged to whom.
    expect((await findCanonicalHuman(alpha.canonicalHumanId, db))?.activeBuilderIdentityIds).toEqual(['gh-alice'])
    expect((await findCanonicalHuman(beta.canonicalHumanId, db))?.activeBuilderIdentityIds).toEqual(['hn-alice'])
  })

  it('restores both projections, not just the account assignment', async () => {
    const { alpha, beta, merge } = await twoPeopleThenMerge()
    await unmergeCanonicalHumans({ mergeEventId: merge.mergeEventId }, db)

    const [restoredAlpha] = await db.select().from(canonicalHumans).where(eq(canonicalHumans.id, alpha.canonicalHumanId))
    const [restoredBeta] = await db.select().from(canonicalHumans).where(eq(canonicalHumans.id, beta.canonicalHumanId))
    // Alpha must not keep Beta's language: a half-restored projection is not a restored one.
    expect(restoredAlpha.language).toBeNull()
    expect(restoredAlpha.displayName).toBe('Alice Alpha')
    expect(restoredBeta.displayName).toBe('Alice Beta')
    expect(restoredBeta.language).toBe('pt')
  })

  it('refuses to revert the same merge twice', async () => {
    const { merge } = await twoPeopleThenMerge()
    expect(await unmergeCanonicalHumans({ mergeEventId: merge.mergeEventId }, db)).toBe(true)
    // A double-click must not go on to undo later, unrelated work.
    expect(await unmergeCanonicalHumans({ mergeEventId: merge.mergeEventId }, db)).toBe(false)
  })

  it('keeps the lineage readable from either side, with its reverted state', async () => {
    const { alpha, beta, merge } = await twoPeopleThenMerge()
    await unmergeCanonicalHumans({ mergeEventId: merge.mergeEventId, revertedByUserId: REVIEWER }, db)

    for (const id of [alpha.canonicalHumanId, beta.canonicalHumanId]) {
      const history = await listMergeHistory(id, 20, db)
      expect(history).toHaveLength(1)
      expect(history[0].reason).toBe('Confirmed same person on both platforms')
      expect(history[0].revertedAt).not.toBeNull()
    }
  })

  it('rejects merging a human into itself', async () => {
    const alpha = await linkSourceAccount({
      builderIdentityId: 'gh-alice',
      signal: { kind: 'verified_claim', claimId: 'c1', subjectUserId: 'u1' },
    }, db)
    await expect(mergeCanonicalHumans({
      targetCanonicalHumanId: alpha.canonicalHumanId,
      sourceCanonicalHumanId: alpha.canonicalHumanId,
      reason: 'nonsense',
    }, db)).rejects.toThrow(/into itself/)
  })

  it('leaves a merge that moved a withdrawn link reversible', async () => {
    const { alpha, beta, merge } = await twoPeopleThenMerge()
    // Something changed after the merge — a link was withdrawn.
    const [moved] = await db.select().from(humanSourceLinks).where(and(eq(humanSourceLinks.builderIdentityId, 'hn-alice'), isNull(humanSourceLinks.validUntil)))
    await withdrawSourceLink({ sourceLinkId: moved.id }, db)

    // Unmerge reads the captured snapshot rather than inferring from current state, so it still
    // knows where the link belongs even though it is no longer active.
    expect(await unmergeCanonicalHumans({ mergeEventId: merge.mergeEventId }, db)).toBe(true)
    const [restored] = await db.select().from(humanSourceLinks).where(eq(humanSourceLinks.id, moved.id))
    expect(restored.canonicalHumanId).toBe(beta.canonicalHumanId)
    // Still withdrawn — unmerge restores ownership, it does not resurrect a decision someone made.
    expect(restored.validUntil).not.toBeNull()
    expect((await findCanonicalHuman(alpha.canonicalHumanId, db))?.activeBuilderIdentityIds).toEqual(['gh-alice'])
  })
})
