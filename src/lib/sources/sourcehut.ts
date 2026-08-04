import { env } from '~/shared/lib/env'
import type { RawBuilder } from '~/lib/sources/types'

/**
 * SourceHut source — small-but-loyal OSS forge.
 *
 * The SourceHut GraphQL endpoint (meta.sr.ht/query) requires auth. Without a `SOURCEHUT_TOKEN`, every request
 * returns 401 Unauthorized.
 *
 * v1 strategy: graceful degradation.
 * - Source is fully wired (pill, icon, badge, scoring, env var)
 * - The handler returns [] if no token is configured OR if the API returns an auth error
 *
 * ## ⚠ Verified 2026-08-03: this connector cannot return results even with a valid token
 *
 * The query below asks meta.sr.ht for `users(search: $q, first: $first)`. **That field does not exist.**
 * meta.sr.ht's published schema (docs.sourcehut.org/meta.sr.ht) exposes an account-management API only — its
 * entire `Query` type is `me`, `loginSecurity`, `myOauthGrant`, `oauthClient*`, `oauthGrants`,
 * `personalAccessTokens`, `pgpKey*`, `sshKey*`, `userByEmail`, `userByID`, `version` and the webhook fields.
 * There is no user search of any kind, and no `search:` argument anywhere in the schema.
 *
 * So `gql()` receives a GraphQL error, returns `null` on the `data.errors` branch, and `searchSourceHut`
 * answers `[]` — indistinguishable from "no token configured". The degradation is what has been hiding this:
 * the source has never been able to produce a result, and the absence of a token meant nobody could tell.
 *
 * git.sr.ht is the same story for repositories: its `Query` type is `gitWebhooks`, `me`,
 * `redirectByDiskPath`, `repositoryByDiskPath`, `user`, `userWebhook(s)`, `version` and `webhook`. Repositories
 * are reachable only through `me { repositories }` or `user(username) { repositories }` — you must already know
 * whose repositories you want. There is no keyword search over repositories, which is what the plan's optional
 * "emit repo results from git.sr.ht" task assumed.
 *
 * **What is actually possible** is exact resolution, not search: `userByEmail`/`userByID` on meta.sr.ht and
 * `user(username) { repositories }` on git.sr.ht. That would make SourceHut an enrichment/verification source
 * (the shape `profile-proof.ts` implements for other forges) rather than a discovery source.
 *
 * ## ⚠ Verified 2026-08-04: sr.ht's own policy excludes this product's use, token or not
 *
 * The enrichment option above was going to be recommended. Then `https://git.sr.ht/robots.txt` was actually
 * read (identical at meta.sr.ht). It opens with a prose policy rather than only directives:
 *
 *   > Allowed: search engine indexers, archival services. **Disallowed: marketing or SEO crawlers; anything
 *   > used to feed a machine learning model**; bots which are too aggressive.
 *
 * BuilderHunt indexes profiles into `builder_embeddings` (pgvector) and feeds AI ranking and explanation. It is
 * the named case. That is a statement about the *use*, so authenticating with a `SOURCEHUT_TOKEN` does not
 * change it — the token would only mean a person had agreed to terms while the use stays excluded.
 *
 * The unauthenticated surface was probed rather than assumed: `https://git.sr.ht/~user` answers 200 with a bare
 * list of repository names and is not in the `Disallow` list, but every path carrying real signal is: the
 * per-repo log (including its `log/rss.xml` feed, which does return 200), blame, commit, tree, item and raw
 * views, and any URL with a query string. So the only crawlable surface is repository names with no dates, no
 * activity and no profile fields. (Written out in prose because the literal glob patterns would close this
 * comment block.)
 *
 * **Recommendation, changed by this finding: retire the connector.** Not because the API is inconvenient, but
 * because the operator has said in writing that this use is unwelcome, and a source pill that can never return
 * a result is a claim the UI cannot keep. Recorded in `docs/operations/public-enrichment-source-register.md`
 * under `sourcehut`, whose whole purpose is to hold facts like this one. Still a product decision, so the
 * connector is left in place and honest rather than removed unilaterally.
 *
 * Left pointed at the non-existent field rather than silently rewritten, because every rewrite still returns
 * `[]` and a wrong query that is honestly documented is easier to act on than a different wrong query that
 * looks deliberate. Same reasoning as the Hashnode connector's header.
 *
 * Spec reference: plans/phase-1/11-sourcehut-integration/spec.md
 */
interface SHUser {
  canonicalName: string
  name: string
  description?: string
  location?: string
  url?: string
}

const SH_GQL = 'https://meta.sr.ht/query'

async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T | null> {
  if (!env.SOURCEHUT_TOKEN) {
    // No token, no data — by design
    return null
  }
  try {
    const res = await fetch(SH_GQL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.SOURCEHUT_TOKEN}`,
        'User-Agent': 'BuilderHunt/1.0 (sourcehut source)',
      },
      body: JSON.stringify({ query, variables }),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { data?: T; errors?: Array<{ message: string }> }
    if (data.errors && data.errors.length > 0) return null
    return data.data ?? null
  } catch {
    return null
  }
}

function userToBuilder(u: SHUser): RawBuilder {
  return {
    id: `sh-${u.canonicalName}`,
    kind: 'person' as const,
    source: 'sourcehut' as const,
    sourceId: u.canonicalName,
    username: u.canonicalName.replace(/^~/, ''),
    displayName: u.name || u.canonicalName,
    avatarUrl: undefined,
    bio: u.description || u.location || undefined,
    profileUrl: u.url || `https://sr.ht/~${u.canonicalName.replace(/^~/, '')}`,
    followersCount: undefined,
    language: undefined,
    country: undefined,
    topics: [],
    metadata: {
      location: u.location ?? null,
    },
  }
}

export interface SearchSourceHutOptions {
  page?: number
  perPage?: number
}

export async function searchSourceHut(
  keywords: string[],
  options: SearchSourceHutOptions = {},
): Promise<RawBuilder[]> {
  const { page = 1, perPage = 30 } = options
  const query = keywords.join(' ')
  if (!query) return []

  const gqlQuery = `query SearchSH($q: String!, $first: Int!) {
    users(search: $q, first: $first) {
      results {
        canonicalName
        name
        description
        location
        url
      }
    }
  }`
  const data = await gql<{ users: { results: SHUser[] } }>(gqlQuery, { q: query, first: 20 })
  if (!data?.users?.results) return []

  const all = data.users.results.map(userToBuilder)
  const start = (page - 1) * perPage
  return all.slice(start, start + perPage)
}
