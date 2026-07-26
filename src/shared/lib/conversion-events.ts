/**
 * Closed conversion-event contract (plan: audit-conversion).
 *
 * A first-party, consent-aware, data-minimized event stream for the landing
 * → signup/guest-search funnel. No PII, no free text, no third-party SDK —
 * see the spec's "Non-goals" and "Event contract" sections.
 */
import { z } from 'zod'

export const CONVERSION_SURFACES = ['hero', 'final_cta', 'explore', 'signup'] as const
export type ConversionSurface = (typeof CONVERSION_SURFACES)[number]

export const CONVERSION_EVENT_NAMES = [
  'landing_view',
  'hero_signup_click',
  'hero_explore_click',
  'explore_search_complete',
  'explore_signup_click',
  'signup_submit',
  'signup_complete',
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
}

const conversionEventShape = z.object({
  name: z.enum(CONVERSION_EVENT_NAMES),
  surface: z.enum(CONVERSION_SURFACES),
  // Random UUID minted client-side into sessionStorage — never the auth
  // session cookie, never derived from any identifying value.
  sessionId: z.string().uuid(),
  variant: z.enum(CONVERSION_VARIANTS),
  occurredAt: z.string().datetime({ offset: true }),
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
