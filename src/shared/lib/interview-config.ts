/**
 * Shared feature/catalog configuration for Calendar, Scheduling, and Interview Intelligence
 * (plan: calendar-scheduling-interview-intelligence, tasks.md "Define shared feature/catalog
 * configuration"). Pure, no I/O beyond reading `env`. Imports `CatalogTier` from the billing
 * platform's catalog but defines no price, tax, grant-expiry, or pack authority here — those stay
 * owned by `billing/catalog.ts` and the platform ledger.
 */
import type { CatalogTier } from './billing/catalog'
import { getRateCard } from './billing/rate-cards'
import { env } from './env'

// ── Document upload contract (spec.md "Private file contract") ──────────────────────────────
// Formats: PDF, DOCX, and TXT. 10 MB each, 25 MB total per invitation.

export const INTERVIEW_DOCUMENT_MIME_TYPES = {
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'text/plain': '.txt',
} as const satisfies Record<string, string>

export type InterviewDocumentMimeType = keyof typeof INTERVIEW_DOCUMENT_MIME_TYPES

export function isSupportedDocumentMimeType(mimeType: string): mimeType is InterviewDocumentMimeType {
  return Object.prototype.hasOwnProperty.call(INTERVIEW_DOCUMENT_MIME_TYPES, mimeType)
}

export const INTERVIEW_DOCUMENT_MAX_BYTES_PER_FILE = 10 * 1024 * 1024
export const INTERVIEW_DOCUMENT_MAX_BYTES_TOTAL = 25 * 1024 * 1024

// spec.md "Candidate URLs are imported only when..." — the SSRF-safe fetch pipeline in
// src/lib/enrichment/ caps the response at 2 MB.
export const CANDIDATE_WEB_IMPORT_MAX_BYTES = 2 * 1024 * 1024

/** Rejects non-finite, zero, and negative limits — a limit of 0 would silently accept nothing and reject everything, which is never the intended config state. */
export function assertPositiveByteLimit(bytes: number, label: string): number {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    throw new Error(`${label} must be a positive number of bytes, got ${bytes}`)
  }
  return bytes
}

assertPositiveByteLimit(INTERVIEW_DOCUMENT_MAX_BYTES_PER_FILE, 'INTERVIEW_DOCUMENT_MAX_BYTES_PER_FILE')
assertPositiveByteLimit(INTERVIEW_DOCUMENT_MAX_BYTES_TOTAL, 'INTERVIEW_DOCUMENT_MAX_BYTES_TOTAL')
assertPositiveByteLimit(CANDIDATE_WEB_IMPORT_MAX_BYTES, 'CANDIDATE_WEB_IMPORT_MAX_BYTES')

// ── Retention defaults (spec.md "Consent, privacy, and retention" → Defaults) ────────────────
// These are the product defaults an organization gets unless it selects a shorter period.
// `env.ts`'s INTERVIEW_*_RETENTION_* vars are the separate operator-wide ceiling the retention
// worker enforces — this module never exceeds them.

export const INTERVIEW_RETENTION_DEFAULTS = {
  transcriptSegmentDays: 90,
  documentAndReportDays: 180,
  consentAuditMonths: 24,
} as const

/**
 * Resolves the retention period an organization actually gets: its own shorter selection if
 * valid, otherwise the product default — never more than the operator-wide ceiling.
 */
export function resolveRetentionDays(params: { requestedDays?: number; defaultDays: number; ceilingDays: number }): number {
  const { requestedDays, defaultDays, ceilingDays } = params
  if (requestedDays === undefined) return defaultDays
  if (!Number.isFinite(requestedDays) || requestedDays <= 0) {
    throw new Error(`Requested retention of ${requestedDays} days must be a positive number`)
  }
  if (requestedDays > ceilingDays) {
    throw new Error(`Requested retention of ${requestedDays} days exceeds the ${ceilingDays}-day operator ceiling`)
  }
  return requestedDays
}

// ── Chrome desktop support matrix (spec.md "Live capture contract") ──────────────────────────
// "Chrome desktop stable, current and previous major, on macOS and Windows is the v1 supported
// remote environment." Chrome ships a new major roughly every 4 weeks — an operator must bump
// `CHROME_CURRENT_SUPPORTED_MAJOR` periodically; the comparison logic below never needs to change.

export const CHROME_CURRENT_SUPPORTED_MAJOR = 139
export const CHROME_SUPPORTED_MAJORS = [CHROME_CURRENT_SUPPORTED_MAJOR, CHROME_CURRENT_SUPPORTED_MAJOR - 1] as const

export function isSupportedChromeMajor(major: number): boolean {
  return (CHROME_SUPPORTED_MAJORS as readonly number[]).includes(major)
}

// ── Capture modes and languages (spec.md "Live capture contract") ───────────────────────────
// "manual-only" is a fallback *state* the session can enter (unsupported browser, withdrawn
// consent, provider outage) — not a third capture mode value; every session still starts as one
// of these two.

export const INTERVIEW_CAPTURE_MODES = ['in_person', 'remote_call'] as const
export type InterviewCaptureMode = (typeof INTERVIEW_CAPTURE_MODES)[number]

export const INTERVIEW_CAPTURE_CAPABILITIES = [
  'microphone_and_shared_audio_available',
  'microphone_only',
  'audio_capture_unsupported',
] as const
export type InterviewCaptureCapability = (typeof INTERVIEW_CAPTURE_CAPABILITIES)[number]

// English + Danish: the acceptance bar in spec.md is "a real 30-minute bilingual interview" and
// the product operates out of Denmark (Danish recording-consent guidance is referenced directly).
export const INTERVIEW_SUPPORTED_LANGUAGES = ['en', 'da'] as const
export type InterviewSupportedLanguage = (typeof INTERVIEW_SUPPORTED_LANGUAGES)[number]

export function isSupportedInterviewLanguage(language: string): language is InterviewSupportedLanguage {
  return (INTERVIEW_SUPPORTED_LANGUAGES as readonly string[]).includes(language)
}

// ── Booking horizon (spec.md "buffers, minimum notice, and booking horizon") ────────────────
// availability_rules.horizon_days is organizer-configurable with "bounded positive checks"; these
// are that bound and the product default.

export const AVAILABILITY_HORIZON_DEFAULT_DAYS = 60
export const AVAILABILITY_HORIZON_MAX_DAYS = 365

export function assertValidHorizonDays(days: number): number {
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error(`Booking horizon of ${days} days must be a positive number`)
  }
  if (days > AVAILABILITY_HORIZON_MAX_DAYS) {
    throw new Error(`Booking horizon of ${days} days exceeds the ${AVAILABILITY_HORIZON_MAX_DAYS}-day maximum`)
  }
  return days
}

// ── Interview operation rate-card keys (spec.md "Usage credits and pricing") ────────────────
//
// **Derived from `billing/rate-cards.ts`, not declared here.** These used to be local constants with
// their own operation names (`interview.brief.v1`) and their own copy of the unit counts, described in
// this very comment as "not registered with the billing platform's RATE_CARDS map yet". That made two
// sources of truth for one price — and worse, the names were unregistered, so `reserveCredits` with
// any of them would have thrown `unknown_feature`: interview code could not actually have billed
// anything through the platform.
//
// Now the platform registry is the single source. `units` is the rate card's `maxUnits`, which for
// these operations *is* the price (transcription's card is the per-minute unit, and the worker
// extends the reservation as it runs). Version bumps happen in one place, so a rate change cannot
// leave a stale copy behind.

export interface InterviewRateCardKey {
  operationKey: string
  version: number
  units: number
}

function fromRateCard(operation: string): InterviewRateCardKey {
  const card = getRateCard(operation)
  // A missing card means the registry and this map disagree about what exists — a mistake that would
  // otherwise surface as an `unknown_feature` reservation failure at the worst possible moment.
  if (!card) throw new Error(`Interview rate card '${operation}' is not registered in billing/rate-cards.ts`)
  return { operationKey: card.operation, version: card.version, units: card.maxUnits }
}

export const INTERVIEW_RATE_CARD_KEYS = {
  brief: fromRateCard('interview_brief'),
  // The card's `maxUnits` is 180 — a three-hour reservation ceiling, not a price — so the per-minute
  // unit is stated here explicitly. It is asserted against the card in
  // `tests/unit/shared/lib/interview-config.test.ts` so the two cannot drift apart silently.
  transcriptionPerMinute: { operationKey: 'interview_live_transcription', version: 1, units: 1 },
  contextualQuestion: fromRateCard('interview_contextual_question'),
  report: fromRateCard('interview_final_report'),
} as const satisfies Record<string, InterviewRateCardKey>

export type InterviewRateCardOperation = keyof typeof INTERVIEW_RATE_CARD_KEYS

/** Throws on an unrecognized key rather than returning null/undefined, since callers build a real credit reservation from the result and a silent fallback would misprice it. */
export function getInterviewRateCardKey(operation: string): InterviewRateCardKey {
  const entry = (INTERVIEW_RATE_CARD_KEYS as Record<string, InterviewRateCardKey>)[operation]
  if (!entry) {
    throw new Error(`Unknown interview rate-card operation: ${operation}`)
  }
  return entry
}

/** spec.md "Typical 60-minute interview: 70 credits" — brief(5) + 60 * transcriptionPerMinute(1) + report(5). */
export const INTERVIEW_TYPICAL_60_MINUTE_ESTIMATE_UNITS =
  INTERVIEW_RATE_CARD_KEYS.brief.units + 60 * INTERVIEW_RATE_CARD_KEYS.transcriptionPerMinute.units + INTERVIEW_RATE_CARD_KEYS.report.units

// ── Low-balance warnings (spec.md "Enforcement": "warn at 80%, 90%, and ten remaining minutes") ─

export const LIVE_TRANSCRIPTION_LOW_BALANCE_WARNING_FRACTIONS = [0.8, 0.9] as const
export const LIVE_TRANSCRIPTION_LOW_BALANCE_WARNING_MINUTES_REMAINING = 10

// ── Entitlement gating (spec.md "Usage credits and pricing" tiers) ──────────────────────────

export const INTERVIEW_ENTITLEMENT_TIERS: readonly Exclude<CatalogTier, 'free'>[] = ['pro', 'pro_max', 'team']

// ── Public feature-flag DTO ──────────────────────────────────────────────────────────────────
// Safe to send to the client: booleans only, never a provider secret or config value.

export interface InterviewPublicFeatureFlagsDto {
  calendarEnabled: boolean
  schedulingEnabled: boolean
  candidateUploadsEnabled: boolean
  candidateWebImportEnabled: boolean
  sensitiveAiEnabled: boolean
  transcriptionEnabled: boolean
  contextualQuestionsEnabled: boolean
  operationalLayersEnabled: boolean
}

export function getInterviewFeatureFlags(): InterviewPublicFeatureFlagsDto {
  return {
    calendarEnabled: env.CALENDAR_ENABLED === 'true',
    schedulingEnabled: env.SCHEDULING_ENABLED === 'true',
    candidateUploadsEnabled: env.CANDIDATE_UPLOADS_ENABLED === 'true',
    candidateWebImportEnabled: env.CANDIDATE_WEB_IMPORT_ENABLED === 'true',
    sensitiveAiEnabled: env.SENSITIVE_AI_ENABLED === 'true',
    transcriptionEnabled: env.INTERVIEW_TRANSCRIPTION_ENABLED === 'true',
    contextualQuestionsEnabled: env.INTERVIEW_CONTEXTUAL_QUESTIONS_ENABLED === 'true',
    operationalLayersEnabled: env.CALENDAR_OPERATIONAL_LAYERS_ENABLED === 'true',
  }
}
