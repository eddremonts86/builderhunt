import { env } from '~/shared/lib/env'
import type { RawBuilder } from '~/lib/sources/github'

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
 * Spec reference: plans/huggingface-integration/spec.md
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

  // People first, then repos
  const all: RawBuilder[] = [
    ...authorList.map(authorToPersonBuilder),
    ...sortedModels.map(modelToRepoBuilder),
  ]

  const start = (page - 1) * perPage
  return all.slice(start, start + perPage)
}
