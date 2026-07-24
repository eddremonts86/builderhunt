import type { AnomalyEmitContext } from './anomalies'
import { emitAbuseSignal, type EmitAbuseSignalDeps } from './signals'

/**
 * Lightweight, proportionate automation heuristics for the export path (abuse-and-usage-integrity
 * plan, Phase 4 "Export burst throttle + proportionate anti-automation"). Distinct from — and
 * independent of — the per-seat daily export CAP (`SEAT_DAILY_EXPORTS`, enforced separately in
 * `export/builders.ts` via `meterSeatActionAndEmit`/`detectSeatOveruse`): these heuristics can flag
 * a single request as automation-shaped regardless of whether the day's cap was crossed. Per the
 * task's own wording, these heuristics only ever raise a signal, never block on their own — a
 * false positive (a legitimate CLI/script user) should never lose access, only get noticed.
 */

export interface RequestHeadersInput {
  userAgent: string | null
  accept: string | null
}

// Common non-browser HTTP client signatures. Deliberately narrow and well-known-library-specific
// (not "anything unusual") — the goal is catching the overwhelmingly common case of an
// unmodified scraping script, not fingerprinting every possible automated client.
const SUSPICIOUS_USER_AGENT_PATTERNS: RegExp[] = [
  /^curl\//i,
  /^wget\//i,
  /^python-requests\//i,
  /^go-http-client/i,
  /^postmanruntime/i,
  /^okhttp/i,
  /^axios\//i,
  /^node-fetch/i,
  /^scrapy/i,
]

/** True when the request has no User-Agent, no Accept header, or a known non-browser client signature. */
export function detectMissingOrImplausibleHeaders(input: RequestHeadersInput): boolean {
  if (!input.userAgent) return true
  if (SUSPICIOUS_USER_AGENT_PATTERNS.some((pattern) => pattern.test(input.userAgent as string))) return true
  if (!input.accept) return true
  return false
}

/**
 * True when less than `minHumanIntervalMs` elapsed since the previous request from the same
 * identity — a human clicking "export" repeatedly cannot sustain sub-second cadence; a script can.
 * `previousRequestAt === null` (no prior request seen) is never flagged — there's nothing to
 * compare against yet.
 */
export function detectNonInteractiveCadence(
  previousRequestAt: number | null,
  now: number,
  minHumanIntervalMs = 500,
): boolean {
  if (previousRequestAt === null) return false
  return now - previousRequestAt < minHumanIntervalMs
}

// Module-scoped, in-memory only — same "lightweight, best-effort" precedent as rate-limit.ts's
// in-memory fallback bucket: a process restart resets it, which is acceptable for a heuristic that
// only ever signals, never blocks. Not wall-clock-persisted or shared across instances.
const lastRequestAtByKey = new Map<string, number>()

/** Records this request's timestamp for `key` and returns whether the cadence looks non-interactive. */
export function recordExportRequestCadence(key: string, now: number = Date.now()): boolean {
  const previous = lastRequestAtByKey.get(key) ?? null
  lastRequestAtByKey.set(key, now)
  return detectNonInteractiveCadence(previous, now)
}

export interface AutomationHeuristicsInput {
  suspiciousHeaders: boolean
  nonInteractiveCadence: boolean
}

/** Emits `export_burst` when either automation heuristic fires. Detection only — never blocks. */
export async function checkExportBurstAndEmit(
  input: AutomationHeuristicsInput,
  context: AnomalyEmitContext,
  deps?: EmitAbuseSignalDeps,
): Promise<boolean> {
  const flagged = input.suspiciousHeaders || input.nonInteractiveCadence
  if (flagged) {
    await emitAbuseSignal({
      type: 'export_burst',
      severity: 'medium',
      userId: context.userId,
      organizationId: context.organizationId ?? undefined,
      requestId: context.requestId,
      details: {
        suspiciousHeaders: input.suspiciousHeaders,
        nonInteractiveCadence: input.nonInteractiveCadence,
      },
    }, deps)
  }
  return flagged
}
