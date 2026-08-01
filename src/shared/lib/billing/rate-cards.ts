import type { CatalogTier } from './catalog'

/**
 * Server-owned, versioned per-operation billing limits
 * (plans/phase-1/30-stripe-billing-platform/tasks.md §4 "Expose server-only feature
 * billing contracts"). Every reservation goes through `getRateCard` — client
 * input can never widen `maxUnits`/`maxDurationSeconds` beyond what's defined
 * here (spec.md: "Client input cannot extend operation limits").
 *
 * `minimumTier: null` means available to every tier including free (no
 * subscription required). Bumping a rate card's numbers for an operation
 * that's already live should also bump `version` — `billing_credit_reservations.rateCardVersion`
 * records which version governed a given reservation, so a rate change never
 * silently reinterprets history.
 */

export interface RateCard {
  operation: string
  version: number
  maxUnits: number
  maxDurationSeconds: number
  settlementGraceSeconds: number
  minimumTier: CatalogTier | null
}

const TIER_RANK: Record<CatalogTier, number> = { free: 0, pro: 1, pro_max: 2, team: 2 }

export const RATE_CARDS: Record<string, RateCard> = {
  ai_sourcing_sprint: {
    operation: 'ai_sourcing_sprint', version: 1, maxUnits: 50, maxDurationSeconds: 600,
    settlementGraceSeconds: 120, minimumTier: 'pro_max',
  },
  semantic_search_query: {
    operation: 'semantic_search_query', version: 1, maxUnits: 5, maxDurationSeconds: 30,
    settlementGraceSeconds: 30, minimumTier: 'pro',
  },
  builder_work_sample_analysis: {
    operation: 'builder_work_sample_analysis', version: 1, maxUnits: 20, maxDurationSeconds: 180,
    settlementGraceSeconds: 60, minimumTier: 'pro_max',
  },

  // ── Solutions Intelligence (plan 43, Phase 6 "Register Solutions rate cards with billing") ────
  //
  // Registered here rather than kept as local constants in `solutions/config.ts`, because local constants
  // are how the interview module shipped an operation name the platform had never heard of: every
  // `reserveCredits` call with it would have thrown `unknown_feature`. `solutions.generate.v1` and
  // `solutions.regenerate.v1` were in exactly that state — declared locally, unregistered, unbillable.
  // `SOLUTIONS_RATE_CARD_KEYS` now derives from these entries so one price has one source.
  //
  // ## Where the numbers come from
  //
  // spec.md's "Premium contract" fixes them, and fixes them as *prices* rather than ceilings:
  // "`solutions.generate.v1`: fixed 10-credit settlement after a usable result" and
  // "`solutions.regenerate.v1`: fixed 3-credit settlement when the rerun invokes providers".
  //
  // So `maxUnits` here is the whole price, not a budget the run consumes against. A first draft of these
  // entries read 12 and 5, sized to bound provider usage the way `interview_live_transcription` does, and
  // that was wrong in a way worth naming: it would have billed each user a different amount for the same
  // product depending on how many clarification rounds their brief needed, which is neither what spec.md
  // promises nor something a confirmation prompt can state in advance.
  //
  // Provider cost therefore does not set the price — it only has to stay under it. A generate run is at most
  // two interpretation calls (one clarification round, kept inside the reservation) and three explanation
  // calls, one per offered route; retrieval and composition touch no provider at all. That worst case is
  // computed from declared token budgets in `~/shared/lib/solutions/cost-model.ts` and certified against the
  // 10-credit price in `docs/operations/solutions-cost-certification.md`, which also records the multiple by
  // which provider prices could rise before the margin inverts.
  //
  // A regenerate carries no interpretation — it reuses the stored interpretation and retrieval and only
  // re-explains — which is why it is priced lower, and why it settles nothing at all when the rerun turned
  // out to need no provider.
  //
  // `maxDurationSeconds` is the reservation's lifetime, and both are generous on purpose: a run that
  // exceeds it has its hold expired by the platform, and expiring a reservation for a run that was merely
  // slow charges the user nothing while losing them the result. 300s is past the sum of every task's own
  // timeout.
  //
  // `minimumTier: 'pro'` from spec.md's premium contract — free organizations cannot reach this at all,
  // which `SOLUTIONS_ENTITLEMENT_TIERS` states and `checkEntitlement` enforces from this field.
  solutions_generate: {
    operation: 'solutions_generate', version: 1, maxUnits: 10, maxDurationSeconds: 300,
    settlementGraceSeconds: 120, minimumTier: 'pro',
  },
  solutions_regenerate: {
    operation: 'solutions_regenerate', version: 1, maxUnits: 3, maxDurationSeconds: 180,
    settlementGraceSeconds: 120, minimumTier: 'pro',
  },

  // ── Interview intelligence (plan: calendar-scheduling-interview-intelligence, Phase 7) ────────
  //
  // spec.md "Usage credits and pricing" fixes the numbers: brief 5, transcription 1 credit per
  // provider-billed minute, contextual questions included, final report 5, and "typical 60-minute
  // interview: 70 credits" — which is 5 + 60 + 5 and is asserted as an arithmetic identity in
  // `src/modules/interviews/billing.ts`, so a rate change cannot silently contradict the marketing
  // figure.
  //
  // `minimumTier: 'pro'` on all four, from spec.md "Sensitive brief/transcription/report: Pro, Pro
  // Max, and Team plus sufficient credits". Free tier cannot reach any of them.
  interview_brief: {
    operation: 'interview_brief', version: 1, maxUnits: 5, maxDurationSeconds: 300,
    settlementGraceSeconds: 60, minimumTier: 'pro',
  },
  // `maxUnits` is a per-reservation ceiling, not the price of an interview: transcription bills by the
  // minute and extends as it runs, so this bounds how much one reservation may ever consume before the
  // caller has to extend it. Three hours is well past any interview and still a real cap — an unbounded
  // reservation is how a stuck session eats a month of credits.
  interview_live_transcription: {
    operation: 'interview_live_transcription', version: 1, maxUnits: 180, maxDurationSeconds: 10_800,
    settlementGraceSeconds: 300, minimumTier: 'pro',
  },
  // Zero units, deliberately. spec.md: contextual questions are "included during active paid
  // transcription", so there is nothing to reserve — but the card still exists, because it is what
  // gates the feature by tier. `checkEntitlement` returns `tier_too_low` for a free-tier caller
  // without any reservation being attempted. The "only while transcription is active" half cannot be
  // expressed here and is enforced in `src/modules/interviews/billing.ts`.
  interview_contextual_question: {
    operation: 'interview_contextual_question', version: 1, maxUnits: 0, maxDurationSeconds: 30,
    settlementGraceSeconds: 30, minimumTier: 'pro',
  },
  interview_final_report: {
    operation: 'interview_final_report', version: 1, maxUnits: 5, maxDurationSeconds: 300,
    settlementGraceSeconds: 60, minimumTier: 'pro',
  },
}

export function getRateCard(operation: string): RateCard | null {
  return RATE_CARDS[operation] ?? null
}

/** Whether `tier` meets or exceeds `minimumTier` — `pro_max` and `team` rank equally (catalog.ts: Team includes everything Pro Max has). */
export function tierMeetsMinimum(tier: CatalogTier, minimumTier: CatalogTier | null): boolean {
  if (!minimumTier) return true
  return TIER_RANK[tier] >= TIER_RANK[minimumTier]
}
