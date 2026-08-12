import { env } from '~/shared/lib/env'
import type { RawBuilder } from '~/lib/sources/types'

/**
 * Hugging Face source — the canonical AI/ML hub.
 *
 * The user-search API requires auth (out of scope for v1). Instead, we
 * focus on models: search via /api/models, which returns full metadata
 * including the author (encoded in the model id as `author/model-name`).
 * We emit two entity types:
 *   - kind: 'repo'   → each model (the primary entity)
 *   - kind: 'person' → aggregated author (sourced from the models they own
 *                       in the result set; total downloads / likes / models)
 *
 * Note: authors are scoped to this search's result set, not the full HF
 * user base. This is a known limitation; a real user-profile lookup would
 * need an HF API token (out of scope per spec).
 *
 * ## Top-author enrichment
 *
 * The aggregate above gives an author a `followersCount` of total *likes*, which is a proxy standing in for a
 * number HF will actually tell us. `/api/users/{name}/overview` returns `numFollowers` and `avatarUrl`
 * unauthenticated, so the top `HF_ENRICH_LIMIT` authors by downloads get their real figures. Everything the
 * aggregate computed stays in `metadata`, so nothing is lost and a card can still show "12 models, 4.2M
 * downloads" next to a real follower count.
 *
 * **Organizations are why this is two endpoints, not one.** Checked live on 2026-08-03: the highest-download
 * authors on HF are overwhelmingly organizations — `meta-llama`, `mistralai`, `Qwen` — and every one of them
 * **404s** on `/api/users/…`. Enriching only through the users endpoint would therefore have left exactly the
 * authors this feature exists for without an avatar, which is the opposite of the intent. Organizations answer
 * on `/api/organizations/{name}/overview` with an `avatarUrl` but **no follower count at all** (they report
 * `numUsers`/`numModels` instead), so an org gets its avatar and keeps the likes proxy. Claiming `numUsers` as
 * followers would be inventing a metric.
 *
 * Enrichment is strictly additive and never load-bearing: each lookup is independently caught and bounded by
 * its own timeout, and a total failure leaves the result identical to the unenriched output. A search must not
 * get slower or emptier because a decoration endpoint is unavailable.
 *
 * Spec reference: plans/implemented/13-huggingface-integration/spec.md
 */
interface HFModel {
  _id: string
  id: string                 // "author/model-name"
  likes: number
  trendingScore?: number
  private: boolean
  downloads: number
  tags: string[]
  pipeline_tag?: string
  library_name?: string
  createdAt: string
  modelId: string
  author?: string
}

const HF_BASE = 'https://huggingface.co/api'

function authHeaders(): HeadersInit {
  if (env.HUGGINGFACE_TOKEN) {
    return { Authorization: `Bearer ${env.HUGGINGFACE_TOKEN}` }
  }
  return {}
}

async function searchModels(keywords: string[]): Promise<HFModel[]> {
  const q = keywords.join(' ')
  if (!q) return []
  try {
    const res = await fetch(
      `${HF_BASE}/models?search=${encodeURIComponent(q)}&limit=20&full=true`,
      { headers: { 'User-Agent': 'BuilderHunt/1.0 (huggingface source)', ...authHeaders() } },
    )
    if (!res.ok) return []
    const data = (await res.json()) as HFModel[]
    return (data ?? []).filter((m) => !m.private)
  } catch {
    return []
  }
}

function authorOf(model: HFModel): string {
  // model.id is "author/model-name"; some legacy entries lack the slash
  if (model.author) return model.author
  const slash = model.id.indexOf('/')
  return slash > 0 ? model.id.slice(0, slash) : model.id
}

function modelToRepoBuilder(m: HFModel): RawBuilder {
  const created = Date.parse(m.createdAt)
  return {
    id: `hf-model-${m._id}`,
    kind: 'repo' as const,
    source: 'huggingface' as const,
    sourceId: m._id,
    username: m.id,
    displayName: m.id,
    avatarUrl: undefined,
    bio: m.pipeline_tag ? `${m.pipeline_tag} · ${m.library_name ?? ''}`.trim() : m.library_name,
    profileUrl: `https://huggingface.co/${m.id}`,
    // Downloads is the cleanest "popularity" proxy on HF
    followersCount: m.downloads,
    language: undefined,
    country: undefined,
    topics: m.tags?.slice(0, 8) ?? [],
    metadata: {
      downloads: m.downloads,
      likes: m.likes,
      pipelineTag: m.pipeline_tag,
      library: m.library_name,
      lastSeen: isNaN(created) ? Date.now() : created,
      author: authorOf(m),
    },
  }
}

interface AuthorAggregate {
  username: string
  models: HFModel[]
  totalDownloads: number
  totalLikes: number
  lastSeen: number
  allTags: Set<string>
  allPipelines: Set<string>
}

function aggregateAuthor(author: string, m: HFModel, byName: Map<string, AuthorAggregate>): void {
  const existing = byName.get(author)
  const created = Date.parse(m.createdAt)
  const entry: AuthorAggregate =
    existing ??
    {
      username: author,
      models: [],
      totalDownloads: 0,
      totalLikes: 0,
      lastSeen: 0,
      allTags: new Set(),
      allPipelines: new Set(),
    }
  entry.models.push(m)
  entry.totalDownloads += m.downloads
  entry.totalLikes += m.likes
  if (!isNaN(created) && created > entry.lastSeen) entry.lastSeen = created
  for (const t of m.tags ?? []) entry.allTags.add(t)
  if (m.pipeline_tag) entry.allPipelines.add(m.pipeline_tag)
  byName.set(author, entry)
}

/** How many top authors get a profile lookup. Five keeps the added latency to one parallel burst. */
export const HF_ENRICH_LIMIT = 5

/** Enrichment is decoration; it must never hold a search open. */
const HF_OVERVIEW_TIMEOUT_MS = 4000

/** What a profile lookup can contribute. `numFollowers` is absent for organizations — see the file header. */
interface HFAuthorOverview {
  avatarUrl?: string
  numFollowers?: number
}

async function fetchJson(url: string): Promise<unknown | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), HF_OVERVIEW_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'BuilderHunt/1.0 (huggingface source)', ...authHeaders() },
      signal: controller.signal,
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * A user first, then an organization. The order matters and is not arbitrary: a *user* is the only kind of
 * account that reports followers, so asking there first is what makes the real figure reachable at all. An
 * organization is the fallback, and it can only ever contribute an avatar.
 */
async function fetchAuthorOverview(username: string): Promise<HFAuthorOverview | null> {
  const user = await fetchJson(`${HF_BASE}/users/${encodeURIComponent(username)}/overview`) as
    { avatarUrl?: unknown; numFollowers?: unknown } | null
  if (user) {
    return {
      avatarUrl: typeof user.avatarUrl === 'string' ? user.avatarUrl : undefined,
      numFollowers: typeof user.numFollowers === 'number' ? user.numFollowers : undefined,
    }
  }

  const org = await fetchJson(`${HF_BASE}/organizations/${encodeURIComponent(username)}/overview`) as
    { avatarUrl?: unknown } | null
  if (org) {
    return { avatarUrl: typeof org.avatarUrl === 'string' ? org.avatarUrl : undefined }
  }
  return null
}

/**
 * Replaces the likes proxy with the real follower count where HF supplies one, and attaches the avatar.
 *
 * `totalLikes` stays in `metadata` regardless, so the proxy remains visible next to whatever replaced it —
 * a card that used to show likes-as-followers can still show likes, labelled correctly.
 */
function enrichPersonBuilder(builder: RawBuilder, overview: HFAuthorOverview | null): RawBuilder {
  if (!overview) return builder
  return {
    ...builder,
    avatarUrl: overview.avatarUrl ?? builder.avatarUrl,
    followersCount: overview.numFollowers ?? builder.followersCount,
    metadata: {
      ...builder.metadata,
      ...(overview.numFollowers === undefined ? {} : { followersSource: 'huggingface_profile' as const }),
    },
  }
}

function authorToPersonBuilder(a: AuthorAggregate): RawBuilder {
  const pipelineList = Array.from(a.allPipelines).slice(0, 3).join(', ')
  const bio =
    a.models.length === 1
      ? `Published ${a.models[0].id} on Hugging Face`
      : `Published ${a.models.length} models on Hugging Face (${a.totalDownloads.toLocaleString()} total downloads)${pipelineList ? ` · ${pipelineList}` : ''}`

  return {
    id: `hf-${a.username}`,
    kind: 'person' as const,
    source: 'huggingface' as const,
    sourceId: a.username,
    username: a.username,
    displayName: a.username,
    avatarUrl: undefined,
    bio,
    profileUrl: `https://huggingface.co/${a.username}`,
    // No followers from API; use total likes as quality signal
    followersCount: a.totalLikes,
    language: undefined,
    country: undefined,
    topics: Array.from(a.allTags).slice(0, 10),
    metadata: {
      modelCount: a.models.length,
      totalDownloads: a.totalDownloads,
      totalLikes: a.totalLikes,
      lastSeen: a.lastSeen,
      pipelines: Array.from(a.allPipelines),
    },
  }
}

export interface SearchHuggingFaceOptions {
  page?: number
  perPage?: number
}

export async function searchHuggingFace(
  keywords: string[],
  options: SearchHuggingFaceOptions = {},
): Promise<RawBuilder[]> {
  const { page = 1, perPage = 30 } = options
  if (keywords.length === 0 || keywords.join('').trim() === '') return []

  const models = await searchModels(keywords)
  if (models.length === 0) return []

  // Aggregate authors from the result set
  const authorMap = new Map<string, AuthorAggregate>()
  for (const m of models) aggregateAuthor(authorOf(m), m, authorMap)

  // Sort authors by total downloads (proxy for impact)
  const authorList = Array.from(authorMap.values()).sort(
    (a, b) => b.totalDownloads - a.totalDownloads,
  )

  // Sort models by downloads
  const sortedModels = [...models].sort((a, b) => b.downloads - a.downloads)

  const people = authorList.map(authorToPersonBuilder)

  /**
   * Enrich the top authors only, and never let it change the shape of the answer.
   *
   * `Promise.all` over already-caught lookups, so one slow or missing profile costs this burst its own timeout
   * and nothing else. The zip below is positional against `people.slice(0, HF_ENRICH_LIMIT)` — the same array,
   * in the same order, so an author can never be given another author's avatar.
   */
  const overviews = await Promise.all(
    people.slice(0, HF_ENRICH_LIMIT).map((person) => fetchAuthorOverview(person.username)),
  )
  for (const [index, overview] of overviews.entries()) {
    people[index] = enrichPersonBuilder(people[index]!, overview)
  }

  // People first, then repos
  const all: RawBuilder[] = [
    ...people,
    ...sortedModels.map(modelToRepoBuilder),
  ]

  const start = (page - 1) * perPage
  return all.slice(start, start + perPage)
}
