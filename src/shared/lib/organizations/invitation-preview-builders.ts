import { and, desc, eq, isNotNull, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { publicDb } from '../db/client'
import { builderIdentities } from '../db/schema'
import { INVITATION_SUGGESTED_QUERY, type InvitationIntent } from './invitation-personalization'

/**
 * Three real builders for the invitation review page.
 *
 * ## What this is not
 *
 * It is **not** `/api/recommendations` and it is **not** the federated search pipeline. That path
 * re-runs saved queries across thirteen connectors with an 8-second budget each, behind its own rate
 * limit. Putting it behind a page opened from an email would mean a stranger's click costing thirteen
 * upstream requests, and the page could not render until the slowest one gave up.
 *
 * The 57 draft asked for exactly that — "three real `RawBuilder` rows … the page calls the existing
 * `/api/search` endpoint" — and it is the one piece of that draft carried forward, by explicit
 * decision, on the condition that it is cheap. So this is a single indexed read of
 * `builder_identities`: rows already discovered and stored, no provider involved.
 *
 * ## What it may show
 *
 * `builder_identities` is the global discovery table. It holds no tenant data — no notes, no scores,
 * no organization — so nothing here can leak between organizations, which is why it is safe to read
 * for a recipient who is **not a member yet**.
 *
 * Two filters matter beyond that:
 *
 * - `kind = 'person'`. The GitHub connector searches users *and* repositories, and the schema's own
 *   comment records the consequence: 41 GitHub rows and 11 GitLab rows carry an `owner/repo`
 *   "username". A card headed "people you could find" showing three repositories is worse than showing
 *   nothing.
 * - `avatar_url IS NOT NULL`. A card of three grey placeholders reads as broken rather than as sparse.
 *
 * ## Ordering
 *
 * `last_seen_at DESC, id DESC` — recency first, with `id` as a tiebreaker so the three rows are stable
 * between two loads of the same page. A discovery run stamps a batch with the same `last_seen_at`, so
 * without the tiebreaker the set could shuffle under a refresh for no reason a viewer could explain.
 */
export const INVITATION_PREVIEW_BUILDER_COUNT = 3

export interface InvitationPreviewBuilder {
  username: string
  displayName: string | null
  avatarUrl: string | null
  source: string
  profileUrl: string
}

/**
 * The language hint each intent leans on, derived from the same suggested query the card shows.
 *
 * Deliberately a *hint*, not a filter: `WHERE language = …` on a small table returns nothing for most
 * intents, and an empty card is a worse answer than three recent builders. So the language only sorts.
 */
function languageHintFor(intent: InvitationIntent): string | null {
  const query = INVITATION_SUGGESTED_QUERY[intent].toLowerCase()
  if (query.includes('backend') || query.includes('infrastructure')) return 'Go'
  if (query.includes('developer tools')) return 'Rust'
  return null
}

export async function readInvitationPreviewBuilders(
  intent: InvitationIntent,
  db: PostgresJsDatabase = publicDb,
): Promise<InvitationPreviewBuilder[]> {
  const hint = languageHintFor(intent)
  return db
    .select({
      username: builderIdentities.username,
      displayName: builderIdentities.displayName,
      avatarUrl: builderIdentities.avatarUrl,
      source: builderIdentities.source,
      profileUrl: builderIdentities.profileUrl,
    })
    .from(builderIdentities)
    .where(and(
      eq(builderIdentities.kind, 'person'),
      isNotNull(builderIdentities.avatarUrl),
    ))
    .orderBy(
      // The hint sorts and never filters, so an intent whose language is absent still gets three rows.
      ...(hint ? [desc(sql`(${builderIdentities.language} = ${hint})`)] : []),
      desc(builderIdentities.lastSeenAt),
      desc(builderIdentities.id),
    )
    .limit(INVITATION_PREVIEW_BUILDER_COUNT)
}
