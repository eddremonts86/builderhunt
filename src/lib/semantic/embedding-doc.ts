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

/** Shape of anything `buildEmbeddingDoc`/`toEmbeddedProfile` can consume —
 * a structural subset of `RawBuilder` (src/lib/sources/types.ts) so this
 * module never needs to import it (kept dependency-free/pure). */
export interface EmbeddableSource {
  username: string
  displayName?: string | null
  avatarUrl?: string | null
  bio?: string | null
  profileUrl: string
  source: string
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
