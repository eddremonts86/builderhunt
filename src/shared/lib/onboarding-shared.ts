/**
 * Client-safe onboarding constants — split out from `onboarding.ts` because
 * that file also pulls in drizzle-orm/db schema for its server-only
 * functions, and importing anything from it (even a plain constant) drags
 * that whole server module graph into the client bundle, which fails at
 * runtime ("crypto has been externalized for browser compatibility").
 *
 * The same rule applies to everything added here for v2: presentation only, no imports that reach
 * the database layer.
 */
import type { SegmentPreset } from './user-segments'

/**
 * The v1 list, kept as the general route's queries.
 *
 * Still exported under its original name because `search.tsx` and its e2e both reference it, and
 * renaming a constant to express that it is now one of five would have been a rename with no
 * behavioural meaning.
 */
export const STARTER_QUERIES = [
  'rust async runtime',
  'indie hackers in EU',
  'AI agents in production',
  'react performance',
  'python ML engineers',
] as const

export const TOTAL_STEPS = 3

/**
 * What each route suggests searching for (plan: phase-2/03-onboarding-segmentado).
 *
 * Five queries each, because the step renders them as chips and the layout is built for that count
 * — a route with three would look unfinished beside one with five, and the difference would read as
 * a bug rather than as a choice.
 *
 * The queries differ by *what the person is looking for*, not by tone. Somebody hiring wants people
 * available for a role; somebody investing wants what is being built and by whom; a builder wants to
 * find themselves. Rewriting the same five queries in four voices would have been personalisation
 * that changes titles rather than workflow, which the phase README names as the failure mode.
 */
export const STARTER_QUERIES_BY_PRESET: Record<SegmentPreset, readonly string[]> = {
  general: STARTER_QUERIES,
  other: STARTER_QUERIES,
  hiring: [
    'senior rust engineers open to work',
    'react developers in EU',
    'ML engineers with production experience',
    'founding engineers',
    'devops open to contract',
  ],
  investing: [
    'AI agents in production',
    'developer tools with traction',
    'open source maintainers shipping weekly',
    'infrastructure startups',
    'climate tech builders',
  ],
  building: [
    'rust async runtime',
    'react performance',
    'python ML engineers',
    'open source maintainers',
    'indie hackers in EU',
  ],
}

export interface OnboardingStepCopy {
  heading: string
  body: string
}

/**
 * The heading and subtitle of the search step, per route.
 *
 * Deliberately the only copy that varies. The rest of the step — the input, the chips, the source
 * count — is the same product doing the same thing, and changing more would be dressing rather than
 * difference.
 */
export const SEARCH_STEP_COPY: Record<SegmentPreset, OnboardingStepCopy> = {
  general: {
    heading: 'What are you looking for?',
    body: 'Pick a starter query or type your own.',
  },
  other: {
    heading: 'What are you looking for?',
    body: 'Pick a starter query or type your own.',
  },
  hiring: {
    heading: 'Who are you looking to hire?',
    body: 'Start with a role, a stack or a location. Save the people worth a conversation.',
  },
  investing: {
    heading: 'What are you tracking?',
    body: 'Start with a technology, a space or a kind of builder. Save the search to keep watching it.',
  },
  building: {
    heading: 'Find yourself',
    body: 'Search for your own handle, your projects or your stack — then claim the profile.',
  },
}

/** One place, so a caller never indexes a record with a value that might not be a key. */
export function starterQueriesFor(preset: SegmentPreset): readonly string[] {
  return STARTER_QUERIES_BY_PRESET[preset] ?? STARTER_QUERIES
}

export function searchStepCopyFor(preset: SegmentPreset): OnboardingStepCopy {
  return SEARCH_STEP_COPY[preset] ?? SEARCH_STEP_COPY.general
}

/**
 * The light thesis an investing route starts from (plan: phase-2/03-onboarding-segmentado).
 *
 * Themes, not a questionnaire. The spec asks for "technologies, industry or type of builder", and
 * the honest way to collect that in one step is a handful of chips that expand into search keywords
 * the product already understands — every keyword here is the kind of term the connectors index.
 *
 * Deliberately no sector taxonomy, no cheque size and no stage. The product models people and what
 * they ship; asking for a fund's parameters would imply it does something with them.
 */
export interface ThesisTheme {
  id: string
  label: string
  keywords: readonly string[]
}

export const INVESTING_THESIS_THEMES: readonly ThesisTheme[] = [
  { id: 'ai-infrastructure', label: 'AI infrastructure', keywords: ['ai agents', 'llm infrastructure'] },
  { id: 'developer-tools', label: 'Developer tools', keywords: ['developer tools', 'sdk'] },
  { id: 'open-source', label: 'Open source', keywords: ['open source maintainer'] },
  { id: 'climate', label: 'Climate tech', keywords: ['climate tech', 'energy'] },
  { id: 'fintech', label: 'Fintech', keywords: ['fintech', 'payments'] },
  { id: 'security', label: 'Security', keywords: ['security', 'cryptography'] },
  { id: 'robotics', label: 'Robotics and hardware', keywords: ['robotics', 'embedded'] },
  { id: 'health', label: 'Health tech', keywords: ['health tech', 'bioinformatics'] },
] as const

/**
 * The longest thesis that may travel in a URL.
 *
 * `onboarding/search` caps its own prefill at 300 characters, and composing past that here would
 * produce a query that silently arrives truncated — a saved search whose name does not match what
 * the person selected. Capped at the source instead, on a keyword boundary.
 */
const MAX_THESIS_LENGTH = 300

/**
 * Turns the selected themes and any free text into one search string.
 *
 * Free text goes first: somebody who typed something specific meant it more than the chip they also
 * tapped. Duplicates are dropped case-insensitively so picking two overlapping themes does not
 * produce a query that searches the same term twice, and the result is capped on a keyword boundary
 * rather than mid-word.
 */
export function composeThesisQuery(themeIds: readonly string[], freeText = ''): string {
  const parts: string[] = []
  const seen = new Set<string>()
  const push = (value: string) => {
    const trimmed = value.trim()
    if (!trimmed) return
    const key = trimmed.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    parts.push(trimmed)
  }

  push(freeText)
  for (const id of themeIds) {
    const theme = INVESTING_THESIS_THEMES.find((candidate) => candidate.id === id)
    if (!theme) continue
    for (const keyword of theme.keywords) push(keyword)
  }

  const kept: string[] = []
  for (const part of parts) {
    const candidate = kept.length === 0 ? part : `${kept.join(', ')}, ${part}`
    if (candidate.length > MAX_THESIS_LENGTH) break
    kept.push(part)
  }
  return kept.join(', ')
}

/** The keywords a saved search is created with — the same list, unjoined. */
export function thesisKeywords(themeIds: readonly string[], freeText = ''): string[] {
  const composed = composeThesisQuery(themeIds, freeText)
  return composed ? composed.split(', ') : []
}

/** Where the goal step sends somebody once they have answered. */
export function entryRouteFor(
  preset: SegmentPreset,
): '/onboarding/investing' | '/onboarding/building' | '/onboarding/search' {
  if (preset === 'investing') return '/onboarding/investing'
  if (preset === 'building') return '/onboarding/building'
  return '/onboarding/search'
}

/** The routes the last onboarding step is allowed to send somebody to. */
export type SuccessDestination = '/dashboard' | '/search' | '/alerts' | '/me'

export interface SuccessStepCopy {
  heading: string
  body: string
  next: readonly string[]
  primary: { to: SuccessDestination; label: string }
  secondary: { to: SuccessDestination; label: string }
}

/**
 * The last screen, per route (plan: phase-2/03-onboarding-segmentado).
 *
 * The spec asks for "success with one concrete next action", and the concrete action is different
 * for each route: a recruiter goes back to searching, an investor to the searches now watching for
 * them, a builder to the profile they just claimed.
 *
 * Nothing here claims an outcome. "Your radar is live" is a statement about the product running;
 * there is no promise of visits, opportunities or deal flow, because the product does not produce
 * any of those on its own and saying so would be the fabrication the spec forbids by name.
 */
export const SUCCESS_STEP_COPY: Record<SegmentPreset, SuccessStepCopy> = {
  general: {
    heading: 'Your radar is live',
    body: 'Fresh picks land in your dashboard, and your saved searches keep running.',
    next: [
      'Your "For you" section starts filling in today',
      'Save a search from any result to add another radar',
      'Search your own handle to find and claim your profile',
    ],
    primary: { to: '/dashboard', label: 'Go to dashboard' },
    secondary: { to: '/search', label: 'Run another search' },
  },
  other: {
    heading: 'Your radar is live',
    body: 'Fresh picks land in your dashboard, and your saved searches keep running.',
    next: [
      'Your "For you" section starts filling in today',
      'Save a search from any result to add another radar',
      'Search your own handle to find and claim your profile',
    ],
    primary: { to: '/dashboard', label: 'Go to dashboard' },
    secondary: { to: '/search', label: 'Run another search' },
  },
  hiring: {
    heading: 'Your shortlist has started',
    body: 'The builders you saved are tracked, and the search that found them keeps running.',
    next: [
      'Your saved builders are on the dashboard, with what they ship',
      'Save a search from any result to widen the shortlist',
      'Turn a search into an alert to hear about new matches',
    ],
    primary: { to: '/dashboard', label: 'Go to dashboard' },
    secondary: { to: '/search', label: 'Search for more people' },
  },
  investing: {
    heading: 'Your thesis is running',
    body: 'The search you saved keeps watching, and what it finds comes to you.',
    next: [
      'Your saved searches are on the dashboard with their latest results',
      'Add another theme as a second search whenever you like',
      'Track individual builders to follow what they ship',
    ],
    primary: { to: '/alerts', label: 'See what is watching' },
    secondary: { to: '/dashboard', label: 'Go to dashboard' },
  },
  building: {
    heading: 'The profile is yours',
    body: 'It is linked to your account. What you add to it is what people see.',
    next: [
      'Add your topics and what you are open to, on your profile',
      'Publish a portfolio page from the same place',
      'Anything you do not fill in simply is not shown',
    ],
    primary: { to: '/me', label: 'Go to my profile' },
    secondary: { to: '/dashboard', label: 'Go to dashboard' },
  },
}

export function successStepCopyFor(preset: SegmentPreset): SuccessStepCopy {
  return SUCCESS_STEP_COPY[preset] ?? SUCCESS_STEP_COPY.general
}

/** The onboarding screens that report a position in the flow. */
export const ONBOARDING_ROUTE_NAMES = [
  'welcome',
  'goal',
  'search',
  'save',
  'investing',
  'building',
  'success',
] as const
export type OnboardingRouteName = (typeof ONBOARDING_ROUTE_NAMES)[number]

/**
 * Which step key a screen is, on a given route (plan: phase-2/03-onboarding-segmentado).
 *
 * A screen is not a step: `onboarding/search` is `hiring_search` on one route and
 * `investing_discovery` on another, and a funnel that recorded "the search screen" would add four
 * different things together. Written out per route rather than derived from a position, because the
 * flows have different lengths and an index would quietly drift the day one of them gains a step.
 *
 * `building` and `investing` map the screens they never visit to the general keys. They can still be
 * reached by typing the URL, and reporting a step from another route's flow would be worse than
 * reporting the general one — `resumeStep` would then bounce the person back to the start.
 */
const STEP_KEY_BY_ROUTE: Record<OnboardingRouteName, Record<SegmentPreset, string>> = {
  welcome: { general: 'welcome', other: 'welcome', hiring: 'welcome', investing: 'welcome', building: 'welcome' },
  goal: { general: 'goal', other: 'goal', hiring: 'goal', investing: 'goal', building: 'goal' },
  search: {
    general: 'general_search',
    other: 'general_search',
    hiring: 'hiring_search',
    investing: 'investing_discovery',
    building: 'general_search',
  },
  save: {
    general: 'general_save',
    other: 'general_save',
    hiring: 'hiring_save',
    investing: 'investing_save',
    building: 'general_save',
  },
  investing: {
    general: 'general_search', other: 'general_search', hiring: 'general_search',
    investing: 'investing_thesis', building: 'general_search',
  },
  building: {
    general: 'general_search', other: 'general_search', hiring: 'general_search',
    investing: 'general_search', building: 'building_locate',
  },
  success: {
    general: 'confirmation', other: 'confirmation', hiring: 'confirmation',
    investing: 'confirmation', building: 'confirmation',
  },
}

export function stepKeyForRoute(route: OnboardingRouteName, preset: SegmentPreset): string {
  return STEP_KEY_BY_ROUTE[route][preset] ?? STEP_KEY_BY_ROUTE[route].general
}
