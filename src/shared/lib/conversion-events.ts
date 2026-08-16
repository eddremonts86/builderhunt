/**
 * Closed conversion-event contract (plan: audit-conversion).
 *
 * A first-party, consent-aware, data-minimized event stream for the landing
 * → signup/guest-search funnel. No PII, no free text, no third-party SDK —
 * see the spec's "Non-goals" and "Event contract" sections.
 */
import { z } from 'zod'
import { SEGMENT_PRESETS, userSegmentSchema } from './user-segments'
import { ONBOARDING_STEP_KEYS } from './onboarding-v2'

export const CONVERSION_SURFACES = ['hero', 'final_cta', 'explore', 'signup', 'onboarding', 'settings', 'segment_page'] as const
export type ConversionSurface = (typeof CONVERSION_SURFACES)[number]

export const CONVERSION_EVENT_NAMES = [
  'landing_view',
  'hero_signup_click',
  'hero_explore_click',
  'explore_search_complete',
  'explore_signup_click',
  'signup_submit',
  'signup_complete',
  // Segmentation (plan: phase-2/02-segmentacion-usuarios). Same stream and the same rules: no
  // identity, no free text, nothing about a candidate. What a segment event adds is *which* choice
  // was made, and that is an enum either way.
  'segment_prompt_viewed',
  'segment_selected',
  'segment_changed',
  'segment_skipped',
  'activation_reached',
  // The onboarding funnel itself (plan: phase-2/03-onboarding-segmentado). One step is one event,
  // carrying which route and which flow version it belongs to — a funnel that only knew "onboarding"
  // could not answer whether v2 was better than v1, which is the whole question a cohort rollout asks.
  'onboarding_step_viewed',
  'onboarding_step_completed',
  'onboarding_flow_exited',
  // The segmented landing (plan: phase-2/06-landing-segmentada). Three events, because the funnel
  // question is which of three steps a visitor stops at: reaching a segment page, choosing a
  // different one from the selector, or pressing that page's CTA. One "landing_view" for all three
  // pages could not answer any of them.
  'segment_page_viewed',
  'segment_selector_click',
  'segment_page_cta_click',
] as const
export type ConversionEventName = (typeof CONVERSION_EVENT_NAMES)[number]

export const CONVERSION_VARIANTS = ['baseline', 'treatment'] as const
export type ConversionVariant = (typeof CONVERSION_VARIANTS)[number]

// The same semantic action (e.g. "clicked the signup CTA") can fire from more
// than one page position — `surface` disambiguates position, `name`
// disambiguates the action. This map is the actual "closed schema": any
// (name, surface) pair not listed here is rejected, so a typo or a new UI
// position can't silently start emitting an uncounted/miscounted event.
const ALLOWED_SURFACES_BY_NAME: Record<ConversionEventName, readonly ConversionSurface[]> = {
  landing_view: ['hero'],
  hero_signup_click: ['hero', 'final_cta'],
  hero_explore_click: ['hero'],
  explore_search_complete: ['explore'],
  explore_signup_click: ['explore'],
  signup_submit: ['signup'],
  signup_complete: ['signup'],
  segment_prompt_viewed: ['onboarding', 'settings'],
  segment_selected: ['onboarding', 'settings'],
  segment_changed: ['onboarding', 'settings'],
  segment_skipped: ['onboarding'],
  // Activation is reported from wherever the person reached it, so it is the one segment-adjacent
  // event with a wide surface list rather than a narrow one.
  activation_reached: ['onboarding', 'settings', 'explore'],
  onboarding_step_viewed: ['onboarding'],
  onboarding_step_completed: ['onboarding'],
  onboarding_flow_exited: ['onboarding'],
  segment_page_viewed: ['segment_page'],
  // The selector is on both the home page and every segment page, and which of the two a visitor
  // used is the difference between "arrived undecided" and "landed on the wrong one".
  segment_selector_click: ['hero', 'segment_page'],
  segment_page_cta_click: ['segment_page'],
}

/**
 * The three landing events, which describe a *page*, not a stored preference
 * (plan: phase-2/06-landing-segmentada).
 *
 * They carry the same segment context as the choice events and mean something different: `next` is
 * which page this was about, and `source` is always `landing`. Kept as a separate list rather than
 * folded into `SEGMENT_CHOICE_EVENTS` because an analysis that counted a page view as a choice would
 * report a segment for every visitor who read a page and picked nothing.
 */
export const SEGMENT_LANDING_EVENTS = [
  'segment_page_viewed',
  'segment_selector_click',
  'segment_page_cta_click',
] as const

/** The three that describe a position in a flow, and therefore the three that must carry one. */
export const ONBOARDING_FUNNEL_EVENTS = [
  'onboarding_step_viewed',
  'onboarding_step_completed',
  'onboarding_flow_exited',
] as const

/** The four that describe a choice, and therefore the four that must carry one. */
export const SEGMENT_CHOICE_EVENTS = [
  'segment_prompt_viewed',
  'segment_selected',
  'segment_changed',
  'segment_skipped',
] as const

/**
 * What a segment event may say, and nothing more.
 *
 * Two enums and a source. There is deliberately no field that could hold a name, an email, a query
 * or anything about a candidate — the spec lists those as forbidden, and the reliable way to honour
 * that is to give them nowhere to go rather than to strip them later.
 *
 * `previous` is nullable because a first choice has no predecessor, and `next` is nullable because
 * clearing a segment is a real event.
 */
const segmentContextShape = z.object({
  previous: userSegmentSchema.nullable(),
  next: userSegmentSchema.nullable(),
  source: z.enum(['onboarding', 'settings', 'landing']),
}).strict()

/** Coarse, and an enum — "what kind of first value did they reach", never which search or builder. */
export const ACTIVATION_TYPES = ['first_search', 'first_saved_builder', 'first_alert', 'profile_published'] as const
export type ActivationType = (typeof ACTIVATION_TYPES)[number]

/**
 * Where in which flow (plan: phase-2/03-onboarding-segmentado).
 *
 * Three enums, no free text and nothing identifying — same rules as the segment context. The step is
 * a **key**, never the v1 step number: `2` means a different screen on each route, so a funnel keyed
 * on it would silently add four different steps together.
 *
 * `flowVersion` is what makes the rollout measurable. Comparing v2 against v1 needs both cohorts in
 * one stream, distinguishable; without it, a drop in completion could not be told apart from a
 * change in who was being onboarded that week.
 */
const onboardingContextShape = z.object({
  flowVersion: z.union([z.literal(1), z.literal(2)]),
  preset: z.enum(SEGMENT_PRESETS),
  stepKey: z.enum(ONBOARDING_STEP_KEYS),
}).strict()

const conversionEventShape = z.object({
  name: z.enum(CONVERSION_EVENT_NAMES),
  surface: z.enum(CONVERSION_SURFACES),
  // Random UUID minted client-side into sessionStorage — never the auth
  // session cookie, never derived from any identifying value.
  sessionId: z.string().uuid(),
  variant: z.enum(CONVERSION_VARIANTS),
  occurredAt: z.string().datetime({ offset: true }),
  /** Present on exactly the four segment-choice events; rejected on any other. */
  segment: segmentContextShape.optional(),
  /** Present on exactly `activation_reached`; rejected on any other. */
  activationType: z.enum(ACTIVATION_TYPES).optional(),
  /** Present on exactly the three onboarding funnel events; rejected on any other. */
  onboarding: onboardingContextShape.optional(),
}).strict()

export type ConversionEvent = z.infer<typeof conversionEventShape>

export interface ParseConversionEventResult {
  ok: boolean
  event: ConversionEvent | null
  error: string | null
}

/**
 * The only entry point for validating an inbound event. Rejects unknown
 * keys (via `.strict()`), invalid enum values, non-UUID session ids,
 * malformed timestamps, and — the part `.strict()` can't express — a
 * `(name, surface)` combination the funnel doesn't define.
 */
export function parseConversionEvent(raw: unknown): ParseConversionEventResult {
  const parsed = conversionEventShape.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, event: null, error: parsed.error.issues[0]?.message ?? 'Invalid event' }
  }
  const allowed = ALLOWED_SURFACES_BY_NAME[parsed.data.name]
  if (!allowed.includes(parsed.data.surface)) {
    return { ok: false, event: null, error: `Event "${parsed.data.name}" cannot occur on surface "${parsed.data.surface}"` }
  }

  /**
   * The optional fields are optional to the *schema* and mandatory to the *contract*. Enforced here
   * because zod cannot express "required for these five names and forbidden for the rest" without
   * a discriminated union that would rewrite the whole shape.
   *
   * Both directions matter. A missing context makes a segment event uncountable; a context on a
   * landing event means a surface is sending data it has no business knowing.
   */
  const needsSegment =
    (SEGMENT_CHOICE_EVENTS as readonly string[]).includes(parsed.data.name) ||
    (SEGMENT_LANDING_EVENTS as readonly string[]).includes(parsed.data.name)
  if (needsSegment && !parsed.data.segment) {
    return { ok: false, event: null, error: `Event "${parsed.data.name}" requires segment context` }
  }
  if (!needsSegment && parsed.data.segment) {
    return { ok: false, event: null, error: `Event "${parsed.data.name}" must not carry segment context` }
  }

  const needsActivation = parsed.data.name === 'activation_reached'
  if (needsActivation && !parsed.data.activationType) {
    return { ok: false, event: null, error: 'Event "activation_reached" requires activationType' }
  }
  if (!needsActivation && parsed.data.activationType) {
    return { ok: false, event: null, error: `Event "${parsed.data.name}" must not carry activationType` }
  }

  const needsOnboarding = (ONBOARDING_FUNNEL_EVENTS as readonly string[]).includes(parsed.data.name)
  if (needsOnboarding && !parsed.data.onboarding) {
    return { ok: false, event: null, error: `Event "${parsed.data.name}" requires onboarding context` }
  }
  if (!needsOnboarding && parsed.data.onboarding) {
    return { ok: false, event: null, error: `Event "${parsed.data.name}" must not carry onboarding context` }
  }

  return { ok: true, event: parsed.data, error: null }
}

const FUTURE_SKEW_MS = 5 * 60 * 1000
const PAST_SKEW_MS = 5 * 60 * 1000

/** Server-side clock check — rejects timestamps outside a 5-minute window either direction. */
export function isWithinClockSkewWindow(occurredAt: string, now: Date = new Date()): boolean {
  const ts = Date.parse(occurredAt)
  if (isNaN(ts)) return false
  const diff = ts - now.getTime()
  return diff <= FUTURE_SKEW_MS && diff >= -PAST_SKEW_MS
}

const MIN_SAMPLE_FOR_CI = 30
const Z_95 = 1.959963985

export interface ConversionRate {
  numerator: number
  denominator: number
  rate: number | null
  /** 95% Wilson score confidence interval, or null when the sample is too small to be meaningful. */
  ci95: [number, number] | null
  insufficientSample: boolean
}

/**
 * Wilson score interval — more robust than a normal approximation at the
 * small-n, extreme-proportion cases a new funnel step will actually see
 * (e.g. 2/40 signups). `insufficientSample` is a separate, stricter flag:
 * it's true below `MIN_SAMPLE_FOR_CI`, distinct from "returns nothing" —
 * the raw rate is still reported, just not a confidence claim over it.
 */
export function computeConversionRate(numerator: number, denominator: number): ConversionRate {
  if (denominator <= 0) {
    return { numerator, denominator, rate: null, ci95: null, insufficientSample: true }
  }
  const phat = numerator / denominator
  const insufficientSample = denominator < MIN_SAMPLE_FOR_CI

  const n = denominator
  const z2 = Z_95 * Z_95
  const denom = 1 + z2 / n
  const center = phat + z2 / (2 * n)
  const adjustment = Z_95 * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n))
  const lower = Math.max(0, (center - adjustment) / denom)
  const upper = Math.min(1, (center + adjustment) / denom)

  return {
    numerator,
    denominator,
    rate: phat,
    ci95: insufficientSample ? null : [lower, upper],
    insufficientSample,
  }
}
