/**
 * The public page for each segment (plan: phase-2/06-landing-segmentada).
 *
 * ## Every claim carries its evidence, in the type
 *
 * A landing page is the one surface where a false statement is never corrected: there is no empty
 * state to qualify it and no endpoint to refuse it, and the person who believed it has already
 * signed up. So a `Claim` cannot be written without an `evidence` string naming the file or route
 * that makes it true — the compiler asks for it, and `segment-pages.test.ts` refuses one that points
 * at nothing.
 *
 * That is the mechanical half of the message matrix
 * (`docs/marketing/phase-3-segment-message-matrix.es.md`). The judgement half — whether a promise is
 * about this product or about somebody else's behaviour — stays with the reviewer, but the promises
 * this product has already decided it must never make are a list, and the tests check it.
 *
 * ## Three pages, not four
 *
 * `other` has none. It is the home page, which is exactly what the rest of the product does with
 * `other`: the general experience rather than a fourth variant. A segmented landing that made
 * somebody choose before showing them anything would turn an optional question into a toll.
 */
import { SEARCH_SOURCE_COUNT } from '~/shared/lib/search-connectors'

/** The segments with a page of their own. `other` is the home page. */
export const SEGMENT_PAGE_KEYS = ['hiring', 'investing', 'building'] as const
export type SegmentPageKey = (typeof SEGMENT_PAGE_KEYS)[number]

export interface Claim {
  text: string
  /**
   * The file or route that makes this true. Not a URL and not prose: a reviewer has to be able to
   * open it. A claim whose evidence cannot be opened is a claim nobody checked.
   */
  evidence: string
}

export interface SegmentPageContent {
  segment: SegmentPageKey
  /** The path under `/for/`. Part of the contract because the sitemap and the tests both read it. */
  slug: string
  title: string
  metaDescription: string
  heading: string
  subheading: string
  /** What the page promises, each with the thing that makes it true. */
  claims: readonly Claim[]
  /** The objection this segment actually raises, answered rather than avoided. */
  objection: { question: string; answer: string }
  cta: { label: string; to: '/search' | '/onboarding/building' | '/auth/sign-up' }
  /**
   * What this page must be honest about. Rendered, not a comment: a limit that only lives in a
   * review note is a limit the reader never sees.
   */
  limits: readonly string[]
}

export const SEGMENT_PAGES: Record<SegmentPageKey, SegmentPageContent> = {
  hiring: {
    segment: 'hiring',
    slug: 'hiring-teams',
    title: 'Find builders by what they ship',
    metaDescription:
      `Search across ${SEARCH_SOURCE_COUNT} public sources for people actively shipping in your stack, and keep the search running.`,
    heading: 'Find people by what they ship, not by what their profile says',
    subheading:
      'A professional profile describes whoever wrote it, two years ago. What somebody shipped this week is somewhere else.',
    claims: [
      {
        text: `One search across ${SEARCH_SOURCE_COUNT} public sources, deduplicated.`,
        evidence: 'src/shared/lib/search-connectors.ts',
      },
      {
        text: 'Results ordered by recent activity, so the top of the list is the people shipping now.',
        evidence: 'src/routes/api/search/builders.ts',
      },
      {
        text: 'Save the people worth a conversation to a shortlist your workspace shares.',
        evidence: 'src/routes/api/lists/index.ts',
      },
      {
        text: 'Give a role a deadline and let a sourcing sprint work the sources for you.',
        evidence: 'src/routes/api/sprints/index.ts',
      },
    ],
    objection: {
      question: 'Is this another tool that scrapes LinkedIn?',
      answer:
        'No. The sources are public and listed by name, and the platforms whose terms forbid this are not connected — not quietly, not partially.',
    },
    cta: { label: 'Search builders', to: '/search' },
    limits: [
      'Recent activity is a signal about code, not about availability. Nobody here is marked as looking for work unless they said so on their own profile.',
      'We do not sell contact details.',
    ],
  },

  investing: {
    segment: 'investing',
    slug: 'investors',
    title: 'Track what is being built, and by whom',
    metaDescription:
      `Save a thesis as a search that keeps running across ${SEARCH_SOURCE_COUNT} public sources, and hear about what it finds.`,
    heading: 'Save a thesis as a search, and hear what it finds',
    subheading:
      'By the time something reaches a list, everybody has seen it. This watches the places the work actually happens.',
    claims: [
      {
        text: 'Turn a theme into a saved search that keeps running.',
        evidence: 'src/routes/api/queries/index.ts',
      },
      {
        text: 'Follow the people behind the work, not just the repositories.',
        evidence: 'src/routes/api/builders/track.ts',
      },
      {
        text: 'A private feed link carries the results on the free plan; email alerts are a Pro feature.',
        evidence: 'src/routes/api/queries/$id/feed-capability.ts',
      },
    ],
    objection: {
      question: 'Is this a startup database?',
      answer:
        'No. BuilderHunt tracks people and what they ship. It does not model companies, funding rounds or cap tables, and it will not pretend to until it does.',
    },
    cta: { label: 'Save a search', to: '/search' },
    limits: [
      'No funding source is connected. Nothing here detects a round.',
      'Email alerts need a paid plan. A new workspace gets the feed link instead, which runs the same search.',
    ],
  },

  building: {
    segment: 'building',
    slug: 'builders',
    title: 'Claim the profile we already indexed',
    metaDescription:
      'Your work is spread across five platforms. Claim the profile BuilderHunt indexed and decide what it says.',
    heading: 'Claim your profile, and decide what it says',
    subheading:
      'Your work is spread across five platforms and none of them puts it together. We already did — the question is whether it is yours to edit.',
    claims: [
      {
        text: 'Prove the account is yours by publishing a one-time challenge on it.',
        evidence: 'src/routes/api/builders/$builderId/claim.ts',
      },
      {
        text: 'Add your topics and what you are open to. What you fill in is what people see.',
        evidence: 'src/routes/_dashboard/me/index.tsx',
      },
      {
        text: 'Publish a portfolio page from the same profile.',
        evidence: 'src/routes/api/me/builder-claims/$claimId/portfolio/publish.ts',
      },
      {
        text: 'Or have the profile removed instead. That is a flow, not an email address.',
        evidence: 'src/shared/lib/profile-suppression.ts',
      },
    ],
    objection: {
      question: 'You have my data and I never agreed to that?',
      answer:
        'We index public activity, which is why claiming exists — and why removal does too. Both are flows you can start yourself.',
    },
    cta: { label: 'Find my profile', to: '/onboarding/building' },
    limits: [
      'Claiming proves you control that external account. It does not verify your identity or anything you have said about your experience.',
      'Claiming does not change where you rank, and it does not generate profile views or opportunities.',
    ],
  },
}

export function segmentPageFor(segment: string | null | undefined): SegmentPageContent | null {
  if (!segment) return null
  return (SEGMENT_PAGE_KEYS as readonly string[]).includes(segment)
    ? SEGMENT_PAGES[segment as SegmentPageKey]
    : null
}

export function segmentPageBySlug(slug: string): SegmentPageContent | null {
  return Object.values(SEGMENT_PAGES).find((page) => page.slug === slug) ?? null
}

/**
 * Promises this product has already decided it must never make.
 *
 * Every one is on the list because the specs forbid it by name, not because it reads as marketing
 * fluff: "deal flow" until the product models investment, and fabricated visits or opportunities for
 * builders. A reviewer can miss one of these in a paragraph; a test cannot.
 *
 * Deliberately not a general profanity-of-marketing filter. It catches the specific sentences this
 * product would be lying to say, and nothing else — a list that also flagged ordinary copy would be
 * turned off within a month.
 */
export const FORBIDDEN_LANDING_CLAIMS: readonly { pattern: RegExp; why: string }[] = [
  { pattern: /deal ?flow/i, why: 'the product models no companies, rounds or cap tables (spec: phase-2/03)' },
  { pattern: /\bhires?\b.*\bguarantee|guarantee.*\bhire/i, why: 'no outcome is measured' },
  { pattern: /available for hire|open to offers|actively looking/i, why: 'activity is not availability unless the person said so' },
  { pattern: /verified contact|email address(es)? included/i, why: 'the product does not sell contact details' },
  { pattern: /get noticed|recruiters will|land (a|your) job|more opportunities/i, why: 'spec: do not fabricate visits or opportunities' },
  { pattern: /profile views? guaranteed|boost your visibility/i, why: 'the product generates neither views nor reach; both would be a promise about other people' },
  { pattern: /funding (signals?|rounds?)|next round/i, why: 'no funding source is connected' },
  { pattern: /perfect (candidate|match)|ai (finds|picks) the/i, why: 'nothing here judges suitability' },
  { pattern: /gdpr[- ]compliant/i, why: 'compliance is a legal state, not a feature' },
  { pattern: /\b\d+[,.]?\d*\s*(users|companies|hires|placements)\b/i, why: 'no such number is measured' },
]
