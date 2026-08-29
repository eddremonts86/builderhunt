import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

import { contentHashOf } from './embedding-doc'
import { SELF_MANAGED_ENTITY_KIND } from '~/shared/lib/semantic/entity-kinds'
import { deleteBuilderEmbedding, upsertBuilderEmbeddingStub } from '~/shared/lib/repositories/public-builder-embeddings'
import { log } from '~/shared/lib/log'

/**
 * Keeping public self-managed profiles in the semantic index
 * (plan: phase-2/07-perfiles-autogestionados).
 *
 * ## The document is what the owner declared, and nothing else
 *
 * Headline, bio, topics, services and the titles and descriptions of **clean** attachments. Not the
 * filename, not the object key, not the checksum, and never an attachment the scanner has not
 * cleared: an embedding is a copy, so text that reaches this document has left the row policy
 * behind and cannot be un-indexed by tightening one later.
 *
 * ## Removal is immediate, refresh is eventual
 *
 * A profile that goes to `draft`, is deleted, or is suppressed leaves the index in the same call.
 * A profile that changed its bio waits for the next embed pass, which is what `contentHash` makes
 * cheap. The asymmetry is deliberate: being indexed a few minutes late costs a search result,
 * being *removed* a few minutes late means somebody who withdrew is still findable.
 */
export interface SelfManagedIndexableProfile {
  id: string
  handle: string
  displayName: string
  headline: string | null
  bio: string | null
  locationCity: string | null
  locationCountryCode: string | null
  languages: string[]
  services: string[]
  topics: string[]
  /** Titles and descriptions of `clean` attachments only — the caller filters, this asserts nothing. */
  attachments: Array<{ title: string; description: string | null }>
}

/** 8 KB, matching `buildEmbeddingDoc`'s own ceiling: one provider call, one predictable cost. */
const MAX_DOC_LENGTH = 8000

export function buildSelfManagedDoc(profile: SelfManagedIndexableProfile): string {
  const lines: string[] = []
  lines.push(`Name: ${profile.displayName} (@${profile.handle})`)
  // Stated, so the retrieved text itself says what kind of claim it is. A reader of a raw retrieval
  // hit sees the provenance without having to join back to a row.
  lines.push('Source: self-managed profile (declared by its owner, not verified)')
  if (profile.headline?.trim()) lines.push(`Headline: ${profile.headline.trim()}`)
  if (profile.bio?.trim()) lines.push(`Bio: ${profile.bio.trim()}`)
  if (profile.services.length > 0) lines.push(`Services: ${profile.services.join(', ')}`)
  if (profile.topics.length > 0) lines.push(`Topics: ${profile.topics.join(', ')}`)
  if (profile.languages.length > 0) lines.push(`Languages: ${profile.languages.join(', ')}`)
  const location = [profile.locationCity, profile.locationCountryCode].filter(Boolean).join(', ')
  if (location) lines.push(`Location: ${location}`)
  for (const attachment of profile.attachments) {
    const description = attachment.description?.trim()
    lines.push(`Work sample: ${attachment.title}${description ? ` — ${description}` : ''}`)
  }
  return lines.join('\n').slice(0, MAX_DOC_LENGTH)
}

/**
 * Insert or refresh one profile's stub row. Never throws — callers fire it and move on, matching
 * `upsertEmbeddingStubs`' contract, because a search that fails because indexing failed is worse
 * than an index that is briefly stale.
 */
export async function indexSelfManagedProfile(
  profile: SelfManagedIndexableProfile,
  // The reconciliation worker passes its own connection: `builder_embeddings` carries a worker
  // grant (0131), and a background pass writing through the runtime pool would spend the request
  // path's connections on work no request is waiting for.
  db?: PostgresJsDatabase,
): Promise<boolean> {
  try {
    const document = buildSelfManagedDoc(profile)
    return await upsertBuilderEmbeddingStub({
      entityKind: SELF_MANAGED_ENTITY_KIND,
      source: 'self-managed',
      sourceId: profile.id,
      document,
      contentHash: contentHashOf(document),
      profile: {
        username: profile.handle,
        displayName: profile.displayName,
        bio: profile.headline ?? profile.bio ?? undefined,
        profileUrl: `/u/${profile.handle}`,
        language: profile.languages[0],
        country: profile.locationCountryCode ?? undefined,
        topics: profile.topics,
      },
    }, db)
  } catch (error) {
    log.error('self_managed_index_error', {
      sourceId: profile.id,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

/** Take one profile out of the semantic index. Never throws, for the same reason as above. */
export async function removeSelfManagedFromIndex(
  profileId: string,
  db?: PostgresJsDatabase,
): Promise<number> {
  try {
    return await deleteBuilderEmbedding({
      entityKind: SELF_MANAGED_ENTITY_KIND,
      source: 'self-managed',
      sourceId: profileId,
    }, db)
  } catch (error) {
    log.error('self_managed_index_delete_error', {
      sourceId: profileId,
      error: error instanceof Error ? error.message : String(error),
    })
    return 0
  }
}

/**
 * Bring one profile's index row in line with what the profile now is.
 *
 * The single entry point every material event calls — publish, edit, visibility change, delete, and
 * an attachment turning `clean`. One function rather than an index call at each site because the
 * decision is always the same and always has four inputs (visibility, deletion, the document, the
 * clean attachments); spreading it would mean four places that can disagree about what "eligible"
 * means, and the one that drifts is the one that keeps a withdrawn profile searchable.
 *
 * Never throws, and returns what it did so a caller can log it.
 */
export async function syncSelfManagedProfileIndex(
  profileId: string,
): Promise<'indexed' | 'unchanged' | 'removed'> {
  try {
    const { publicDb } = await import('~/shared/lib/db/client')
    const { findIndexableProfile } = await import('~/shared/lib/repositories/self-managed-profiles')

    const profile = await publicDb.transaction((transaction) => findIndexableProfile(transaction, profileId))
    // Absent, draft, unlisted or deleted — all of them mean the same thing to the index.
    if (!profile) {
      await removeSelfManagedFromIndex(profileId)
      return 'removed'
    }
    return (await indexSelfManagedProfile(profile)) ? 'indexed' : 'unchanged'
  } catch (error) {
    log.error('self_managed_index_sync_error', {
      sourceId: profileId,
      error: error instanceof Error ? error.message : String(error),
    })
    return 'unchanged'
  }
}
