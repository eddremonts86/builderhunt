// Pure module (no I/O) — canonical embedding document builder + content
// hashing for the semantic-search plan. Same profile content always
// produces the same hash, which makes re-embedding idempotent: unchanged
// profiles are never re-sent to the embedding provider.
import { createHash } from 'node:crypto'
import { z } from 'zod'

const MAX_DOC_LENGTH = 6000

/** The minimal public payload needed to render a `PersonResultCard` from a
 * local (embedded) hit without refetching the source. Public data only —
 * no userId, no tenant-scoped fields. */
export const embeddedProfileSchema = z.object({
  username: z.string(),
  displayName: z.string().optional(),
  avatarUrl: z.string().optional(),
  bio: z.string().optional(),
  profileUrl: z.string(),
  followersCount: z.number().optional(),
  language: z.string().optional(),
  country: z.string().optional(),
  topics: z.array(z.string()),
})

export type EmbeddedProfile = z.infer<typeof embeddedProfileSchema>

/**
 * The payload stored for a catalog component (plan 43 Phase 5).
 *
 * `builder_embeddings` holds vectors for both people and catalog components — that is what migration
 * 0121's `entity_kind` column is for, so both share one embedding dimension, one HNSW index and one
 * re-embed script. But the two need different payloads: a component has no username and no profile URL,
 * and inventing them to satisfy a shared shape would put fake data in the column that renders result
 * cards.
 *
 * Only what a result card needs. Never the component's full metadata — that lives in
 * `solution_component_versions`, and copying it here would create a second store nothing keeps in step
 * with the first.
 */
export interface EmbeddedCatalogComponent {
  payloadKind: 'catalog_component'
  displayName: string
  componentKind: string
  capabilityKeys: string[]
}

/**
 * What `builder_embeddings.profile` can hold, discriminated by `payloadKind`.
 *
 * `entity_kind` already discriminates at the row level, but a type system cannot relate two columns — so
 * the payload carries its own tag. Optional on the profile branch, and absent means human profile: rows
 * written before this union existed have no tag, and a backfill to add one would rewrite the whole table
 * to record something already implied by `entity_kind = 'human_profile'`.
 */
export type EmbeddingPayload =
  | (EmbeddedProfile & { payloadKind?: 'human_profile' })
  | EmbeddedCatalogComponent

/** Narrows to a human profile, or null for a catalog component. Never casts — a cast here was previously
 * how a component row would have been handed to a person result card. */
export function asEmbeddedProfile(payload: EmbeddingPayload): EmbeddedProfile | null {
  return payload.payloadKind === 'catalog_component' ? null : payload
}

export function asEmbeddedCatalogComponent(payload: EmbeddingPayload): EmbeddedCatalogComponent | null {
  return payload.payloadKind === 'catalog_component' ? payload : null
}

/** Shape of anything `buildEmbeddingDoc`/`toEmbeddedProfile` can consume —
 * a structural subset of `RawBuilder` (src/lib/sources/types.ts) so this
 * module never needs to import it (kept dependency-free/pure). */
export interface EmbeddableSource {
  source: string
  sourceId: string
  username: string
  /** `RawBuilder.kind`. Carried so the write-through can file a repository as a repository instead of as a
   * person — 52 of the 175 identities in this repository's database were misfiled before it existed. */
  kind?: 'person' | 'repo' | 'organization'
  /** The connector's `RawBuilder.metadata`. Not part of the embedding document; carried so the observation
   * write can extract self-declared cross-links, which are the only deterministic way two accounts become
   * one person. */
  metadata?: Record<string, unknown> | null
  displayName?: string | null
  avatarUrl?: string | null
  bio?: string | null
  profileUrl: string
  followersCount?: number | null
  language?: string | null
  country?: string | null
  topics?: string[] | null
}

/**
 * Canonical template embedded for a profile. Fields are omitted when empty
 * so the document stays compact; truncated to `MAX_DOC_LENGTH` chars as a
 * hard ceiling for the embedding provider's input limits.
 */
export function buildEmbeddingDoc(profile: EmbeddableSource): string {
  const lines: string[] = []
  const name = profile.displayName?.trim() || profile.username
  lines.push(`Name: ${name} (@${profile.username})`)
  lines.push(`Source: ${profile.source}`)
  if (profile.bio?.trim()) lines.push(`Bio: ${profile.bio.trim()}`)
  if (profile.language?.trim()) lines.push(`Language: ${profile.language.trim()}`)
  if (profile.country?.trim()) lines.push(`Country: ${profile.country.trim()}`)
  if (profile.topics && profile.topics.length > 0) lines.push(`Topics: ${profile.topics.join(', ')}`)
  if (profile.followersCount != null) lines.push(`Followers: ${profile.followersCount}`)
  return lines.join('\n').slice(0, MAX_DOC_LENGTH)
}

/** sha256 hex digest of the embedding document — same content ⇒ same hash. */
export function contentHashOf(doc: string): string {
  return createHash('sha256').update(doc).digest('hex')
}

/** Projects any embeddable source down to the stored display payload. */
export function toEmbeddedProfile(profile: EmbeddableSource): EmbeddedProfile {
  return embeddedProfileSchema.parse({
    username: profile.username,
    displayName: profile.displayName ?? undefined,
    avatarUrl: profile.avatarUrl ?? undefined,
    bio: profile.bio ?? undefined,
    profileUrl: profile.profileUrl,
    followersCount: profile.followersCount ?? undefined,
    language: profile.language ?? undefined,
    country: profile.country ?? undefined,
    topics: profile.topics ?? [],
  })
}
