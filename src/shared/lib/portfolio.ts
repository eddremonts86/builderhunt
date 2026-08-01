import { z } from 'zod'
import { PortfolioAiPersonaSchema, PortfolioTimelineEventSchema } from './portfolio-integrations'

export const PORTFOLIO_THEMES = ['default', 'minimal', 'terminal'] as const
export type PortfolioTheme = (typeof PORTFOLIO_THEMES)[number]

export const HEADLINE_MAX = 80
export const INTRODUCTION_MAX = 600
export const MAX_SELECTED_PROJECTS = 6

/**
 * Stored under `builder_claims.metadata.portfolio` — a sibling namespace to
 * any other feature that reads/writes `builder_claims.metadata`, never the
 * whole column. Every field here is owner-authored; nothing here is ever
 * auto-populated from scraped data without the owner explicitly selecting it
 * (see `selectedProjectIds`).
 */
export const PortfolioSettingsSchema = z.object({
  theme: z.enum(PORTFOLIO_THEMES).default('default'),
  headline: z.string().max(HEADLINE_MAX).default(''),
  introduction: z.string().max(INTRODUCTION_MAX).default(''),
  selectedProjectIds: z.array(z.string()).max(MAX_SELECTED_PROJECTS).default([]),
  showAiPersona: z.boolean().default(false),
  showTimeline: z.boolean().default(false),
  published: z.boolean().default(false),
  publishedAt: z.string().datetime().nullable().default(null),
  updatedAt: z.string().datetime().nullable().default(null),
})
export type PortfolioSettings = z.infer<typeof PortfolioSettingsSchema>

export const UNPUBLISHED_PORTFOLIO: PortfolioSettings = PortfolioSettingsSchema.parse({})

/** Owner-writable subset — `published`/`publishedAt` only change via the explicit publish/unpublish transition, never a plain settings PATCH. */
export const PortfolioDraftInputSchema = PortfolioSettingsSchema.pick({
  theme: true,
  headline: true,
  introduction: true,
  selectedProjectIds: true,
  showAiPersona: true,
  showTimeline: true,
}).partial()
export type PortfolioDraftInput = z.infer<typeof PortfolioDraftInputSchema>

export interface PortfolioProject {
  id: string
  name: string
  description: string | null
  url: string
  stars: number
  language: string | null
}

export const PublicPortfolioSchema = z.object({
  claimId: z.string(),
  source: z.string(),
  username: z.string(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  profileUrl: z.string(),
  theme: z.enum(PORTFOLIO_THEMES),
  headline: z.string(),
  introduction: z.string(),
  projects: z.array(z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    url: z.string(),
    stars: z.number(),
    language: z.string().nullable(),
  })),
  publishedAt: z.string().datetime(),
  /** Null unless the owner opted in (`showAiPersona`) AND a valid, fresh artifact of their OWN
   * exists — see `findClaimantOwnedAiEnrichment`'s doc comment for why "their own" is load-bearing. */
  aiPersona: PortfolioAiPersonaSchema.nullable(),
  /** Empty unless the owner opted in (`showTimeline`) — see `readTimelineForPortfolio`'s doc
   * comment for the allowlisted shape and bounded length. */
  timeline: z.array(PortfolioTimelineEventSchema),
})
export type PublicPortfolio = z.infer<typeof PublicPortfolioSchema>

/**
 * Version-fail-closed parse: invalid or unrecognized stored shape reads as
 * "no portfolio configured" rather than throwing — a corrupt/future-shaped
 * row must never 500 the owner's dashboard or the public page.
 */
export function parsePortfolioSettings(raw: unknown): PortfolioSettings {
  const parsed = PortfolioSettingsSchema.safeParse(raw)
  return parsed.success ? parsed.data : UNPUBLISHED_PORTFOLIO
}

/** Merges draft input into existing settings without touching sibling `metadata` keys (the caller does the actual jsonb read-modify-write; this just computes the new `portfolio` sub-object). */
export function mergePortfolioDraft(
  existing: PortfolioSettings,
  input: PortfolioDraftInput,
  now: string,
): PortfolioSettings {
  return PortfolioSettingsSchema.parse({
    ...existing,
    ...input,
    updatedAt: now,
  })
}

export function publishPortfolio(existing: PortfolioSettings, now: string): PortfolioSettings {
  return PortfolioSettingsSchema.parse({
    ...existing,
    published: true,
    publishedAt: existing.publishedAt ?? now,
    updatedAt: now,
  })
}

export function unpublishPortfolio(existing: PortfolioSettings, now: string): PortfolioSettings {
  return PortfolioSettingsSchema.parse({
    ...existing,
    published: false,
    updatedAt: now,
  })
}

/** Deterministic: stable order so the same input always yields the same public payload (no flapping between requests/cache entries). */
export function selectPortfolioProjects(
  candidates: PortfolioProject[],
  selectedIds: string[],
): PortfolioProject[] {
  const byId = new Map(candidates.map((c) => [c.id, c]))
  return selectedIds
    .map((id) => byId.get(id))
    .filter((p): p is PortfolioProject => p !== undefined)
}

export interface PublicPortfolioSource {
  claimId: string
  source: string
  username: string
  displayName: string | null
  avatarUrl: string | null
  profileUrl: string
  settings: PortfolioSettings
  projectCandidates: PortfolioProject[]
  /** Already read via `readAiPersonaForPortfolio` (fail-closed) — this function does not parse the
   * raw enrichment itself, it only enforces the opt-in gate a second time as defense in depth. */
  aiPersona?: import('./portfolio-integrations').PortfolioAiPersona | null
  /** Already read via `readTimelineForPortfolio` (fail-closed, allowlisted, bounded) — same
   * defense-in-depth opt-in gate as `aiPersona`. */
  timeline?: import('./portfolio-integrations').PortfolioTimelineEvent[]
}

/** Returns null (not an error) when the claim isn't published — the caller turns that into a 404 without leaking whether an unpublished draft exists. */
export function buildPublicPortfolio(input: PublicPortfolioSource): PublicPortfolio | null {
  if (!input.settings.published || !input.settings.publishedAt) return null
  return {
    claimId: input.claimId,
    source: input.source,
    username: input.username,
    displayName: input.displayName,
    avatarUrl: input.avatarUrl,
    profileUrl: input.profileUrl,
    theme: input.settings.theme,
    headline: input.settings.headline,
    introduction: input.settings.introduction,
    projects: selectPortfolioProjects(input.projectCandidates, input.settings.selectedProjectIds),
    publishedAt: input.settings.publishedAt,
    aiPersona: input.settings.showAiPersona ? (input.aiPersona ?? null) : null,
    timeline: input.settings.showTimeline ? (input.timeline ?? []) : [],
  }
}
