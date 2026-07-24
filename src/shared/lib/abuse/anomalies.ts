import { emitAbuseSignal, type EmitAbuseSignalDeps } from './signals'

/**
 * Pure anomaly-detection functions (abuse-and-usage-integrity plan, Phase 2
 * "Anomaly computations → signals"). Each `detect*` function is pure and
 * takes already-resolved inputs — none of these do IP-to-geo/ASN resolution
 * themselves (no such lookup capability exists yet, a separate later task);
 * they only compute whether a given set of resolved facts is anomalous. Each
 * `check*AndEmit` wraps its pure detector with `emitAbuseSignal`, ready for a
 * future request-path wiring task to call — this task builds the detection
 * library, matching how Phase 0 built `abuse/`'s lib+repos before Phase 1
 * wired them into `better-auth.ts`.
 */

export interface GeoPoint {
  lat: number
  lng: number
  at: Date
}

const EARTH_RADIUS_KM = 6371
/**
 * Faster than any commercial flight (~900 km/h cruise) with headroom — a
 * conservative bound so ordinary layovers/connections rarely false-positive
 * while still catching genuinely impossible jumps (e.g. two logins minutes
 * apart from different continents).
 */
export const DEFAULT_MAX_PLAUSIBLE_SPEED_KMH = 1000

function haversineDistanceKm(a: GeoPoint, b: GeoPoint): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h))
}

export interface ImpossibleTravelInput {
  previous: GeoPoint
  current: GeoPoint
  maxPlausibleSpeedKmh?: number
}

/**
 * True when the implied speed between two geo points exceeds a plausible
 * travel speed. Same location at any elapsed time, or any location reached
 * after enough elapsed time, is never flagged — only a genuinely impossible
 * distance/time combination is.
 */
export function detectImpossibleTravel(input: ImpossibleTravelInput): boolean {
  const distanceKm = haversineDistanceKm(input.previous, input.current)
  if (distanceKm === 0) return false
  const elapsedHours = Math.abs(input.current.at.getTime() - input.previous.at.getTime()) / (1000 * 60 * 60)
  if (elapsedHours <= 0) return true
  const impliedSpeedKmh = distanceKm / elapsedHours
  return impliedSpeedKmh > (input.maxPlausibleSpeedKmh ?? DEFAULT_MAX_PLAUSIBLE_SPEED_KMH)
}

/**
 * True only when both families are known and genuinely differ. A missing/
 * unknown family on either side never flags — a false "change" manufactured
 * from absent data is worse than missing a real one.
 */
export function detectMidSessionUaChange(originalFamily: string | null | undefined, currentFamily: string | null | undefined): boolean {
  if (!originalFamily || !currentFamily) return false
  if (originalFamily === 'unknown' || currentFamily === 'unknown') return false
  return originalFamily !== currentFamily
}

/**
 * True when a user's concurrently-live sessions span more than one distinct
 * network identifier (raw IP or coarse ASN — whichever the caller resolves
 * and passes in). Nulls (unresolved) are ignored rather than counted as a
 * distinct value.
 */
export function detectConcurrentDistinctIp(identifiers: Array<string | null | undefined>): boolean {
  const distinct = new Set(identifiers.filter((value): value is string => Boolean(value)))
  return distinct.size > 1
}

export interface SeatOveruseInput {
  count: number
  cap: number
}

/** True when today's usage count for a metered action exceeds its per-seat daily cap. */
export function detectSeatOveruse(input: SeatOveruseInput): boolean {
  return input.count > input.cap
}

/**
 * Parses `ABUSE_ALLOWLIST_ASNS` (comma-separated, e.g. known corporate egress
 * or VPN providers) and reports whether a given ASN is on it — suppresses
 * IP-churn-only signals for legitimate shared/roaming egress (the OWASP
 * NAT/VPN caveat this plan's spec.md calls out).
 */
export function isAllowlistedAsn(asn: string | null | undefined, allowlistCsv: string): boolean {
  if (!asn) return false
  const allowlist = allowlistCsv.split(',').map((entry) => entry.trim()).filter(Boolean)
  return allowlist.includes(asn)
}

export interface AnomalyEmitContext {
  userId: string
  organizationId?: string | null
  requestId: string
}

/** Emits `impossible_travel` if the two points imply impossible travel, unless the current ASN is allowlisted. */
export async function checkImpossibleTravelAndEmit(
  input: ImpossibleTravelInput,
  context: AnomalyEmitContext,
  currentAsn: string | null,
  allowlistCsv: string,
  deps?: EmitAbuseSignalDeps,
): Promise<boolean> {
  if (isAllowlistedAsn(currentAsn, allowlistCsv)) return false
  const flagged = detectImpossibleTravel(input)
  if (flagged) {
    await emitAbuseSignal({
      type: 'impossible_travel',
      severity: 'high',
      userId: context.userId,
      organizationId: context.organizationId ?? undefined,
      requestId: context.requestId,
      details: { previous: input.previous, current: input.current },
    }, deps)
  }
  return flagged
}

/** Emits `ua_change` if the UA family genuinely changed mid-session. */
export async function checkMidSessionUaChangeAndEmit(
  originalFamily: string | null | undefined,
  currentFamily: string | null | undefined,
  context: AnomalyEmitContext,
  deps?: EmitAbuseSignalDeps,
): Promise<boolean> {
  const flagged = detectMidSessionUaChange(originalFamily, currentFamily)
  if (flagged) {
    await emitAbuseSignal({
      type: 'ua_change',
      severity: 'medium',
      userId: context.userId,
      organizationId: context.organizationId ?? undefined,
      requestId: context.requestId,
      details: { originalFamily, currentFamily },
    }, deps)
  }
  return flagged
}

/** Emits `concurrent_sessions` if concurrently-live sessions span more than one network identifier, unless allowlisted. */
export async function checkConcurrentDistinctIpAndEmit(
  identifiers: Array<string | null | undefined>,
  context: AnomalyEmitContext,
  allowlistCsv: string,
  deps?: EmitAbuseSignalDeps,
): Promise<boolean> {
  const nonAllowlisted = identifiers.filter((value) => !isAllowlistedAsn(value, allowlistCsv))
  const flagged = detectConcurrentDistinctIp(nonAllowlisted)
  if (flagged) {
    await emitAbuseSignal({
      type: 'concurrent_sessions',
      severity: 'medium',
      userId: context.userId,
      organizationId: context.organizationId ?? undefined,
      requestId: context.requestId,
      details: { identifiers: [...new Set(nonAllowlisted.filter(Boolean))] },
    }, deps)
  }
  return flagged
}

/** Emits `seat_overuse` if today's usage for a metered action exceeds its per-seat daily cap. */
export async function checkSeatOveruseAndEmit(
  input: SeatOveruseInput & { action: string },
  context: AnomalyEmitContext,
  deps?: EmitAbuseSignalDeps,
): Promise<boolean> {
  const flagged = detectSeatOveruse(input)
  if (flagged) {
    await emitAbuseSignal({
      type: 'seat_overuse',
      severity: 'low',
      userId: context.userId,
      organizationId: context.organizationId ?? undefined,
      requestId: context.requestId,
      details: { action: input.action, count: input.count, cap: input.cap },
    }, deps)
  }
  return flagged
}
