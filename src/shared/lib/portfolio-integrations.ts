// Plan 37 (portfolio-builder) tasks 1 & 2: optional AI persona and
// timeline integrations for the public portfolio.
//
// Both integrations are READ-ONLY and OPT-IN. They never invoke
// any AI endpoint from a public request, never include raw
// enrichment or timeline payloads, and surface the SAME shape
// the AI/timeline contract produces. The portfolio renderer
// (PublicPortfolio.tsx) consumes the public-safe output, not
// the raw row.
//
// A bad / stale / absent artifact returns null. The renderer
// treats null as "do not render this slot" — the public
// portfolio never shows a half-broken persona or timeline card.

import { z } from 'zod'
import { builderAIEnrichmentSchema } from './ai/enrichment'

/**
 * The public-safe AI persona shape. The renderer only sees these
 * fields; it never sees the raw enrichment payload.
 */
export const PortfolioAiPersonaSchema = z.object({
  summary: z.string().min(20).max(400),
  estimatedSeniority: z.enum(['junior', 'mid', 'senior', 'lead']),
  primaryFocus: z.string().min(3).max(120),
  strengths: z.array(z.string().min(2).max(40)).min(1).max(6),
  codingStyle: z.string().min(3).max(200),
  enrichedAt: z.string(), // ISO date — UI formats
  /** Provenance: which model produced the enrichment, for the
   *  "AI-summarized" disclosure. Never the prompt or anything
   *  beyond the model name. */
  model: z.string(),
})
export type PortfolioAiPersona = z.infer<typeof PortfolioAiPersonaSchema>

/**
 * The public-safe timeline shape. Only the fields the spec
 * approves leak to the public surface; the rest of the unified
 * timeline payload (drafts, restricted events) is filtered out.
 */
export const PortfolioTimelineEventSchema = z.object({
  id: z.string(),
  occurredAt: z.string(),
  kind: z.string(),
  title: z.string(),
  /** A redacted summary; never the raw payload. */
  summary: z.string().max(400),
})
export type PortfolioTimelineEvent = z.infer<typeof PortfolioTimelineEventSchema>

const FRESHNESS_MS = 90 * 24 * 60 * 60 * 1000 // 90 days

/**
 * Read the AI persona from a row's aiEnrichment artifact.
 *
 * - Returns null on any parse / shape / freshness failure
 * - The renderer treats null as "do not render this slot"
 * - The stale / invalid / absent cases are indistinguishable to
 *   a probe, so an attacker cannot tell whether a builder has a
 *   broken persona or none at all
 */
export function readAiPersonaForPortfolio(
  aiEnrichment: unknown,
  options: { now?: Date; staleAfterMs?: number; aiPersonaEnabled?: boolean } = {},
): PortfolioAiPersona | null {
  if (options.aiPersonaEnabled === false) return null
  const parsed = builderAIEnrichmentSchema.safeParse(aiEnrichment)
  if (!parsed.success) return null
  const enrichedAt = new Date(parsed.data.enrichedAt)
  if (Number.isNaN(enrichedAt.getTime())) return null
  const now = options.now ?? new Date()
  const ageMs = now.getTime() - enrichedAt.getTime()
  if (ageMs < 0) return null // future timestamp — never trust
  if (ageMs > (options.staleAfterMs ?? FRESHNESS_MS)) return null
  return {
    summary: parsed.data.summary,
    estimatedSeniority: parsed.data.estimatedSeniority,
    primaryFocus: parsed.data.primaryFocus,
    strengths: parsed.data.strengths,
    codingStyle: parsed.data.codingStyle,
    enrichedAt: enrichedAt.toISOString(),
    model: parsed.data.model,
  }
}

/**
 * Read the public timeline from a builder's events.
 *
 * This is a thin adapter: the unified-timeline feature ships its
 * own validation, and this function only ever sees what the
 * builder author has explicitly published. The shape is
 * allowlisted — anything outside the four fields above is
 * dropped.
 *
 * Returns an empty array on any failure. Empty is fine: the
 * renderer hides the timeline section.
 */
export function readTimelineForPortfolio(
  timeline: unknown,
  options: { timelineEnabled?: boolean; maxEvents?: number } = {},
): PortfolioTimelineEvent[] {
  if (options.timelineEnabled === false) return []
  if (!Array.isArray(timeline)) return []
  const limit = options.maxEvents ?? 5
  const out: PortfolioTimelineEvent[] = []
  for (const raw of timeline) {
    if (out.length >= limit) break
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    if (typeof r.id !== 'string' || r.id.length === 0 || r.id.length > 64) continue
    if (typeof r.occurredAt !== 'string') continue
    const occurred = new Date(r.occurredAt)
    if (Number.isNaN(occurred.getTime())) continue
    if (typeof r.kind !== 'string' || r.kind.length > 40) continue
    if (typeof r.title !== 'string' || r.title.length === 0 || r.title.length > 200) continue
    if (typeof r.summary !== 'string') continue
    out.push({
      id: r.id,
      occurredAt: occurred.toISOString(),
      kind: r.kind,
      title: r.title,
      summary: r.summary.length > 400 ? r.summary.slice(0, 397) + '...' : r.summary,
    })
  }
  return out
}
