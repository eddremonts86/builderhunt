/**
 * The three new home-page sections, as data (plan: phase-2/08-homing-page-content-and-sections).
 *
 * Same discipline as `segment-pages.ts`, for the same reason: a landing page is the one surface where
 * a false statement is never corrected. There is no empty state to qualify it and no endpoint to
 * refuse it, and the person who believed it has already signed up.
 *
 * ## Every item names the plan that makes it true, and the badge is derived
 *
 * `planPath` is a real path under `plans/`, and **`shipped` is computed from it** rather than typed:
 * a plan living under `plans/implemented/` is shipped and anything else is not. Writing the badge by
 * hand is exactly how the draft of this section came to advertise Team shortlists as "Coming soon"
 * while `28-shared-resources` sat in `implemented/` — a page underselling a feature it already has,
 * which no reviewer catches because nobody audits a landing page for modesty.
 *
 * ## No number is typed here
 *
 * Not "no hand-written number" — **no number at all**, and the test enforces it against the resolved
 * string. The weaker rule is unenforceable: a test can see `3` in the output but not whether it came
 * from a constant or a keyboard, so it either lets both through or blocks both.
 *
 * Blocking both costs little. Tier limits belong on the pricing page, next to what they cost, where
 * a reader can act on them; a landing card that says "up to 3 at once" is a number without a price.
 * And the alternative has a record: nine surfaces hardcoded "12 sources" and all nine went stale the
 * day two connectors were retired, and an earlier draft of this very section carried
 * "Pro: 140 credits/month", a figure that appears nowhere in this repository at all.
 */
export interface SectionItem {
  title: string
  /** One line, in the second person, describing what the reader gets. */
  copy: string
  /** A real path under `plans/`, without a leading slash. The badge is derived from it. */
  planPath: string
}

/** A plan under `plans/implemented/` has shipped. Anywhere else it has not. */
export function isShipped(planPath: string): boolean {
  return planPath.startsWith('implemented/')
}

export const PIPELINE_SECTION = {
  eyebrow: 'Pipeline',
  heading: 'Three surfaces that turn a search into a system.',
  subheading:
    'Discovery is the entry point. Alerts, sprints and shared shortlists are what keep it running without you clicking refresh.',
  items: [
    {
      title: 'Keyword alerts',
      // Deliberately no channel named. Email is a paid action and a free workspace gets the feed
      // link instead, so naming email here would contradict the investing segment page.
      copy: 'Set the filter once. We tell you the moment a new builder matches.',
      planPath: 'implemented/phase-1/34-smart-alerts',
    },
    {
      title: 'AI sourcing sprints',
      copy: 'Give a role a deadline and let a sprint work the sources for you.',
      planPath: 'implemented/phase-1/41-ai-sourcing-sprints',
    },
    {
      title: 'Team shortlists',
      copy: 'Share saved searches and shortlists with your workspace. Private lists stay private.',
      planPath: 'implemented/phase-1/28-shared-resources',
    },
  ] satisfies SectionItem[],
} as const

export const AI_HELPERS_SECTION = {
  eyebrow: 'AI helpers',
  heading: 'Five places AI helps.',
  // No count of what costs credits: the allowances are not verifiable from this repository, and a
  // sentence that adds them up is arithmetic over numbers nobody can check.
  subheading: 'Every AI action runs through one credit ledger, and every cost is shown before you run it.',
  items: [
    {
      title: 'Semantic search',
      copy: 'Find builders by what they shipped, not by the words they chose for their profile.',
      planPath: 'implemented/phase-1/22-semantic-search',
    },
    {
      title: 'AI sourcing sprints',
      copy: 'Background re-runs of a saved search until it has found enough to be worth your time.',
      planPath: 'implemented/phase-1/41-ai-sourcing-sprints',
    },
    {
      title: 'Outreach copilot',
      copy: 'Draft the first note in your voice. You edit it before anything is sent.',
      planPath: 'implemented/phase-1/26-outreach-generator',
    },
    {
      title: 'Profile enrichment',
      copy: 'A verified claim holder gets an evidence-backed profile. It never affects search ranking.',
      planPath: 'implemented/phase-1/24-ai-profile-enrichment',
    },
    {
      title: 'CV generation and tailoring',
      copy: 'Generate a CV from confirmed facts, tailored to a role without inventing experience.',
      planPath: 'phase-4/ai-cv-generation-and-tailoring',
    },
  ] satisfies SectionItem[],
} as const

/**
 * What is coming, and nothing that already arrived.
 *
 * Seven, not the eight an earlier draft listed: Solutions Intelligence is in `implemented/` and would
 * have been advertised as upcoming. `isShipped` now makes that mistake impossible to write down — an
 * item whose path starts with `implemented/` fails the test below rather than reaching the page.
 */
export const ROADMAP_SECTION = {
  eyebrow: 'Coming soon',
  heading: 'What we are building next.',
  subheading: 'Each links to the full specification. When one ships, this section gets shorter.',
  items: [
    { title: 'Hiring pipeline kanban', copy: 'Stage the builders you are tracking, from first look to hired.', planPath: 'phase-4/hiring-pipeline-kanban' },
    { title: 'Why this match', copy: 'See which signal pushed a builder to the top of your results.', planPath: 'phase-4/match-evidence-panel' },
    { title: 'Saved search health', copy: 'Know which saved searches still return fresh matches and which have gone quiet.', planPath: 'phase-4/saved-search-health' },
    { title: 'Look-alike sourcing', copy: 'From a builder you already rate, find more like them.', planPath: 'phase-4/look-alike-sourcing' },
    { title: 'CV generation and tailoring', copy: 'A CV built from confirmed facts, tailored without inventing experience.', planPath: 'phase-4/ai-cv-generation-and-tailoring' },
    { title: 'Co-shipping graph', copy: 'See who has shipped alongside whom, and hire from that.', planPath: 'phase-4/collaboration-graph' },
    { title: 'Browser extension', copy: 'Match scores and your notes on a builder profile, without leaving the tab.', planPath: 'phase-4/browser-extension-overlay' },
  ] satisfies SectionItem[],
} as const

export const LANDING_SECTIONS = [PIPELINE_SECTION, AI_HELPERS_SECTION, ROADMAP_SECTION] as const
