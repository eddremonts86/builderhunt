import { z } from 'zod'

/** spec §10: body size cap for the evidence-refresh endpoint. */
export const MAX_EVIDENCE_REFRESH_BODY_BYTES = 16 * 1024

export const EvidenceRefreshBody = z.object({
  connectors: z.array(z.string().min(1).max(60)).min(1).max(10),
  submittedUrls: z.array(z.string().url()).max(10).default([]),
}).superRefine((data, ctx) => {
  const unique = new Set(data.connectors.map((id) => id.trim().toLowerCase()))
  if (unique.size !== data.connectors.length) {
    ctx.addIssue({ code: 'custom', path: ['connectors'], message: 'Duplicate connector ids' })
  }
})

export const EvidenceReviewBody = z.object({
  resolution: z.enum(['accepted', 'rejected']),
})

/**
 * Every field a connector is permitted to write. `.strict()` rejects unknown
 * keys outright — this is the structural block on email/phone/private-content
 * fields a connector might otherwise try to smuggle in (spec §6, §3).
 */
export const EnrichmentEvidencePayloadSchema = z.object({
  profileUrl: z.string().url().max(2048),
  username: z.string().max(100).optional(),
  displayName: z.string().max(200).optional(),
  headline: z.string().max(300).optional(),
  organization: z.string().max(200).optional(),
  role: z.string().max(200).optional(),
  location: z.string().max(200).optional(),
  bio: z.string().max(2000).optional(),
  topics: z.array(z.string().max(60)).max(20).default([]),
  recentActivitySummary: z.string().max(500).optional(),
}).strict()

const PROHIBITED_FIELD_PATTERNS = [
  /\bemail\b/i,
  /\bphone\b/i,
  /\bpassword\b/i,
  /\bssn\b/i,
  /\bdate.?of.?birth\b/i,
]

/**
 * Defense in depth beyond `.strict()`: rejects a payload where an *allowed*
 * free-text field (bio, headline, recentActivitySummary) itself contains an
 * obvious email address or phone-shaped string — connectors must not copy
 * contact details into permitted fields either.
 */
export function containsProhibitedContent(payload: Record<string, unknown>): boolean {
  const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i
  const PHONE_RE = /(?:\+?\d[\d\-.\s]{7,}\d)/
  for (const value of Object.values(payload)) {
    if (typeof value === 'string' && (EMAIL_RE.test(value) || PHONE_RE.test(value))) return true
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === 'string' && (EMAIL_RE.test(entry) || PHONE_RE.test(entry))) return true
      }
    }
  }
  return false
}

export function isProhibitedFieldName(name: string): boolean {
  return PROHIBITED_FIELD_PATTERNS.some((pattern) => pattern.test(name))
}
