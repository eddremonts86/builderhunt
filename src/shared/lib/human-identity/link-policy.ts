/**
 * Which evidence may attach a source account to a canonical human, and which may only ask
 * (plan 43 — solutions-intelligence Phase 3, "Implement reversible identity linking").
 *
 * Pure functions on purpose: this is the decision that, if it gets it wrong, merges two real people
 * into one. It must be testable without a database, and it must be the *only* place the decision is
 * made — the storage layer enforces the same rule as a CHECK constraint
 * (`human_source_links_probabilistic_needs_review_check`) precisely so that a future caller cannot
 * route around this module.
 *
 * The rule that matters: resemblance is not evidence. Plan 43 Phase 2 removed a username-equality
 * merge from `dedup.ts` that silently fused unrelated people who shared a handle, and made the
 * losers unfindable. Nothing here may repeat that, no matter how confident a similarity score looks.
 */
import type { ComponentKind } from '~/shared/lib/solutions/contracts'

export const LINK_METHODS = [
  'verified_claim',
  'explicit_cross_link',
  'reviewed_deterministic',
  'probabilistic_candidate',
] as const
export type LinkMethod = (typeof LINK_METHODS)[number]

export const LINK_REVIEW_STATES = ['auto_approved', 'pending_review', 'approved', 'rejected'] as const
export type LinkReviewState = (typeof LINK_REVIEW_STATES)[number]

/**
 * The signals a linker can present. Each variant carries what a human reviewer would need to check
 * the claim independently — an identifier, not a score.
 */
export type LinkSignal =
  /**
   * The person proved control of the account through the claim flow: `builder_claims.status =
   * 'verified'` with this `subjectUserId`. The strongest signal available, because the subject
   * themselves produced it.
   */
  | { kind: 'verified_claim'; claimId: string; subjectUserId: string }
  /**
   * Account A publicly points at account B — a profile link, a bio URL. Bidirectional or not, it was
   * published by whoever controls A, which is what makes it evidence rather than inference.
   */
  | { kind: 'explicit_cross_link'; fromBuilderIdentityId: string; declaredUrl: string; bidirectional: boolean }
  /**
   * A deterministic match a human has already reviewed: identical verified-email hash, the same
   * signing key, a shared account identifier issued by the platform. Deterministic means "equal or
   * not equal", never "similar".
   */
  | { kind: 'reviewed_deterministic'; signal: 'verified_email_hash' | 'signing_key' | 'platform_account_id'; reviewedByUserId: string; digest: string }
  /**
   * Anything inferred: matching display names, overlapping topics, embedding proximity. May only ever
   * produce a queued proposal.
   */
  | { kind: 'probabilistic'; basis: 'display_name' | 'topic_overlap' | 'embedding_proximity' | 'combined'; similarityBps: number }

export interface LinkDecision {
  method: LinkMethod
  reviewState: LinkReviewState
  confidenceBps: number
  /** Stored on the link row. Never a raw payload — an identifier a reviewer can go and check. */
  evidence: Record<string, unknown>
  /** Why this state, in one line, for the review queue and the audit trail. */
  rationale: string
}

/** Bidirectional cross-links are stronger than one-way ones: both sides had to publish. */
const CROSS_LINK_ONE_WAY_BPS = 7500
const CROSS_LINK_BIDIRECTIONAL_BPS = 9500

/**
 * Maps one signal to the link it justifies.
 *
 * Note what `probabilistic` does with its score: it is recorded, and it is *ignored* for the review
 * state. A 9999-bps name match is still `pending_review`. Confidence orders the review queue; it
 * never shortcuts it. Any future "if similarity > threshold then auto-approve" is the bug this
 * function exists to prevent, and the database would reject it anyway.
 */
export function decideLink(signal: LinkSignal): LinkDecision {
  switch (signal.kind) {
    case 'verified_claim':
      return {
        method: 'verified_claim',
        reviewState: 'auto_approved',
        confidenceBps: 10_000,
        evidence: { claimId: signal.claimId, subjectUserId: signal.subjectUserId },
        rationale: 'Subject proved control of this account through the claim flow',
      }

    case 'explicit_cross_link':
      return {
        method: 'explicit_cross_link',
        reviewState: 'auto_approved',
        confidenceBps: signal.bidirectional ? CROSS_LINK_BIDIRECTIONAL_BPS : CROSS_LINK_ONE_WAY_BPS,
        evidence: {
          fromBuilderIdentityId: signal.fromBuilderIdentityId,
          declaredUrl: signal.declaredUrl,
          bidirectional: signal.bidirectional,
        },
        rationale: signal.bidirectional
          ? 'Both accounts publicly link to each other'
          : 'One account publicly links to the other',
      }

    case 'reviewed_deterministic':
      return {
        method: 'reviewed_deterministic',
        reviewState: 'auto_approved',
        confidenceBps: 9_000,
        // The digest, not the value: an email hash is a pseudonymous identifier and the plaintext
        // has no business on a global-public row.
        evidence: { signal: signal.signal, digest: signal.digest, reviewedByUserId: signal.reviewedByUserId },
        rationale: `Reviewed deterministic match on ${signal.signal}`,
      }

    case 'probabilistic':
      return {
        method: 'probabilistic_candidate',
        // Unconditional. See the doc comment above: the score does not participate in this choice.
        reviewState: 'pending_review',
        confidenceBps: clampBps(signal.similarityBps),
        evidence: { basis: signal.basis, similarityBps: clampBps(signal.similarityBps) },
        rationale: `Similarity on ${signal.basis} — queued for review, cannot auto-link`,
      }
  }
}

/**
 * Clamps a scorer's output into the 0-10000 the column's CHECK constraint allows.
 *
 * A non-finite input (NaN, ±Infinity) becomes 0, not 10000. That is deliberate: a broken scorer has
 * not produced a confident answer, it has produced no answer, and mapping garbage to "maximally
 * certain" would push it to the top of the review queue ahead of genuine high-confidence candidates.
 * Review state is unaffected either way — a probabilistic signal is queued regardless — so the only
 * thing this ordering decides is whose time gets wasted first.
 */
function clampBps(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(10_000, Math.round(value)))
}

/** True when the link is currently attaching the account to the human. */
export function isActiveState(reviewState: LinkReviewState): boolean {
  return reviewState === 'auto_approved' || reviewState === 'approved'
}

/**
 * Ordering for the human review queue: highest confidence first, then oldest, so a reviewer works
 * the most likely matches while the oldest proposals cannot starve indefinitely.
 */
export function compareReviewQueue(
  a: { confidenceBps: number; createdAt: Date },
  b: { confidenceBps: number; createdAt: Date },
): number {
  return b.confidenceBps - a.confidenceBps || a.createdAt.getTime() - b.createdAt.getTime()
}

/**
 * Which of two observations of the same field wins the canonical projection, and why.
 *
 * Stronger evidence wins; equal evidence defers to the more recent observation. Returning the
 * reason — not just the winner — is what makes the projection reversible: `field_provenance` records
 * which link supplied each value, so unmerging can detach exactly the fields the merge brought in
 * instead of leaving orphaned values behind.
 */
export function chooseFieldValue<T>(
  current: { value: T; sourceLinkId: string; method: LinkMethod; observedAt: Date } | null,
  candidate: { value: T; sourceLinkId: string; method: LinkMethod; observedAt: Date },
): { value: T; sourceLinkId: string; observedAt: Date; replaced: boolean } {
  if (!current) {
    return { ...candidate, replaced: true }
  }
  const currentRank = METHOD_STRENGTH[current.method]
  const candidateRank = METHOD_STRENGTH[candidate.method]
  if (candidateRank > currentRank) return { ...candidate, replaced: true }
  if (candidateRank < currentRank) return { ...current, replaced: false }
  return candidate.observedAt > current.observedAt
    ? { ...candidate, replaced: true }
    : { ...current, replaced: false }
}

const METHOD_STRENGTH: Record<LinkMethod, number> = {
  verified_claim: 4,
  explicit_cross_link: 3,
  reviewed_deterministic: 2,
  // A queued proposal is not attached to the human at all, so it can never supply a projected field.
  probabilistic_candidate: 0,
}

/** The entity kind a canonical human is indexed under in the shared vector projection. */
export const CANONICAL_HUMAN_ENTITY_KIND: ComponentKind = 'human_profile'
