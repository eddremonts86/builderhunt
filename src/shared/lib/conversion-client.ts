/**
 * Client-side emitter for the conversion-event funnel (plan: audit-conversion).
 * Never blocks the action it instruments: consent-gated, best-effort, and
 * silent on failure — a dropped analytics POST must never prevent signup,
 * search, or navigation.
 */
import { parseConversionEvent, type ConversionEventName, type ConversionSurface } from './conversion-events'
import { getStableVariant } from './conversion-variant'

const SESSION_ID_KEY = 'bh-conversion-session-id'
// Matches CookieBanner.tsx's own storage key/shape — this module reads the
// same consent record rather than owning a second one.
const CONSENT_STORAGE_KEY = 'bh_cookie_consent'

function newUuid(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`
}

export function getConversionSessionId(): string {
  if (typeof window === 'undefined') return newUuid()
  try {
    const existing = window.sessionStorage.getItem(SESSION_ID_KEY)
    if (existing) return existing
    const fresh = newUuid()
    window.sessionStorage.setItem(SESSION_ID_KEY, fresh)
    return fresh
  } catch {
    return newUuid()
  }
}

export function hasAnalyticsConsent(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const raw = window.localStorage.getItem(CONSENT_STORAGE_KEY)
    if (!raw) return false
    const parsed = JSON.parse(raw) as { analytics?: unknown }
    return parsed.analytics === true
  } catch {
    return false
  }
}

// Guards against a duplicate send within the same page instance (e.g. React
// StrictMode's intentional double-invoke of effects) — the server's unique
// index is the real idempotency guarantee; this just avoids a redundant
// network round-trip for the common case.
const sentThisPageLoad = new Set<string>()

/**
 * Fires a conversion event if (and only if) the user has given explicit
 * analytics consent. Never throws, never awaits — callers should not (and
 * do not need to) block on this.
 */
export function trackConversionEvent(name: ConversionEventName, surface: ConversionSurface): void {
  if (!hasAnalyticsConsent()) return

  const sessionId = getConversionSessionId()
  const variant = getStableVariant()
  const dedupeKey = `${sessionId}:${name}:${surface}:${variant}`
  if (sentThisPageLoad.has(dedupeKey)) return
  sentThisPageLoad.add(dedupeKey)

  const candidate = { name, surface, sessionId, variant, occurredAt: new Date().toISOString() }
  const parsed = parseConversionEvent(candidate)
  // Fail closed: an internally-constructed event should always be valid: if
  // it isn't (a future refactor breaks the (name, surface) contract), don't
  // send malformed data — that's a bug to surface via tests, not traffic.
  if (!parsed.ok) return

  fetch('/api/analytics/conversion', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(parsed.event),
    keepalive: true,
  }).catch(() => {
    // Swallow — telemetry failures must never surface to the user or block
    // the product action being instrumented.
  })
}
