/**
 * Fixed, stable-per-session experiment assignment for the landing-funnel
 * treatment (plan: audit-conversion). Never uses identity, protected traits,
 * acquisition data, or query text — a per-session random draw against a
 * build-time-configured allocation percentage, cached in sessionStorage so
 * a reload/navigation within the same session never flips the arm.
 */
import type { ConversionVariant } from './conversion-events'

const SESSION_VARIANT_KEY = 'bh-conversion-variant'
const DEFAULT_TREATMENT_PCT = 10

function readViteEnv(key: string): string | undefined {
  // import.meta.env is statically replaced at build time; guarded for the
  // (non-Vite) vitest/node execution contexts that import this module.
  try {
    return (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.[key]
  } catch {
    return undefined
  }
}

/** 0-100. Falls back to 10% on anything unset/unparseable/out of range. */
export function resolveTreatmentAllocationPct(): number {
  const raw = readViteEnv('VITE_LANDING_CONVERSION_TREATMENT_PCT')
  const parsed = raw !== undefined ? Number(raw) : NaN
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : DEFAULT_TREATMENT_PCT
}

/**
 * Draws a fresh variant. `VITE_LANDING_CONVERSION_VARIANT=baseline|treatment`
 * forces every session to that arm (manual QA / deterministic test runs);
 * otherwise a random draw against the configured allocation percentage.
 */
export function assignVariant(random: () => number = Math.random): ConversionVariant {
  const forced = readViteEnv('VITE_LANDING_CONVERSION_VARIANT')
  if (forced === 'baseline' || forced === 'treatment') return forced
  const pct = resolveTreatmentAllocationPct()
  return random() * 100 < pct ? 'treatment' : 'baseline'
}

/** Stable for the lifetime of the browser tab/session; assigns once, reuses after. */
export function getStableVariant(random: () => number = Math.random): ConversionVariant {
  if (typeof window === 'undefined') return 'baseline'
  try {
    const stored = window.sessionStorage.getItem(SESSION_VARIANT_KEY)
    if (stored === 'baseline' || stored === 'treatment') return stored
    const assigned = assignVariant(random)
    window.sessionStorage.setItem(SESSION_VARIANT_KEY, assigned)
    return assigned
  } catch {
    // sessionStorage unavailable (private mode, disabled storage) — draw
    // fresh each call rather than throwing; instrumentation degrades to
    // "always re-randomized", which is honest, not silently broken.
    return assignVariant(random)
  }
}
