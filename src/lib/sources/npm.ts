import type { RawBuilder } from '~/lib/sources/types'

/**
 * npm registry source — package maintainers as a class of builders that
 * no other source captures.
 *
 * Strategy:
 *   1. Search packages via npms.io (`/v2/search?q=...&size=20`) — gives us
 *      a ranked list with quality/popularity scores baked in.
 *   2. For each result, fetch full metadata from the registry
 *      (`/registry.npmjs.org/{name}`) — gives us maintainers, keywords,
 *      last-modified time.
 *   3. Emit two entity types:
 *        - kind: 'repo' for the packages themselves
 *        - kind: 'person' for the maintainers (deduped across packages)
 *   4. The npms.io `score.final` is used as `followersCount` proxy for
 *      packages; maintainers get aggregated package quality + count.
 *
 * Quota: no documented limit. The registry is CORS-friendly. We cap at
 * 20 packages per search to be polite.
 *
 * Spec reference: plans/npm-registry-integration/spec.md
 */
interface NpmsSearchResult {
  package: {
    name: string
    version: string
    description?: string
    keywords?: string[]
    publisher?: { username: string; email: string }
    maintainers?: Array<{ username: string; email: string }>
    links?: { npm?: string; homepage?: string; repository?: string }
    date?: string
  }
  score?: {
    final: number
    detail?: {
      quality?: number
      popularity?: number
      maintenance?: number
    }
  }
  searchScore?: number
  highlight?: string
}

interface NpmRegistryPackage {
  name: string
  description?: string
  'dist-tags'?: { latest?: string }
  keywords?: string[]
  license?: string
  maintainers?: Array<{ name: string; email?: string }>
  time?: Record<string, string> & { modified?: string; created?: string }
  homepage?: string
}

const NPMS_SEARCH = 'https://api.npms.io/v2/search'
const NPM_REGISTRY = 'https://registry.npmjs.org'

async function searchPackages(keywords: string[]): Promise<NpmsSearchResult[]> {
  const q = keywords.join(' ')
  try {
    const res = await fetch(
      `${NPMS_SEARCH}?q=${encodeURIComponent(q)}&size=20`,
      { headers: { 'User-Agent': 'BuilderHunt/1.0 (npm source)' } },
    )
    if (!res.ok) return []
    const data = (await res.json()) as { results: NpmsSearchResult[] }
    return data.results ?? []
  } catch {
    return []
  }
}

async function fetchPackage(name: string): Promise<NpmRegistryPackage | null> {
  try {
    const res = await fetch(`${NPM_REGISTRY}/${encodeURIComponent(name)}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'BuilderHunt/1.0 (npm source)' },
    })
    if (!res.ok) return null
    return (await res.json()) as NpmRegistryPackage
  } catch {
    return null
  }
}

function packageToRepoBuilder(pkg: NpmRegistryPackage, score: number): RawBuilder {
  const lastModified = pkg.time?.modified ? Date.parse(pkg.time.modified) : Date.now()
  return {
    id: `npm-${pkg.name}`,
    kind: 'repo' as const,
    source: 'npm',
    sourceId: pkg.name,
    username: pkg.name,
    displayName: pkg.name,
    avatarUrl: undefined,
    bio: pkg.description,
    profileUrl: `https://www.npmjs.com/package/${pkg.name}`,
    // npms.io score is 0-1; multiply by 100k for a followers-like scale
    followersCount: Math.round(score * 100000),
    language: 'javascript',
    country: undefined,
    topics: (pkg.keywords ?? []).slice(0, 8),
    metadata: {
      version: pkg['dist-tags']?.latest,
      license: pkg.license,
      lastSeen: lastModified,
      maintainerCount: pkg.maintainers?.length ?? 0,
    },
  }
}

interface MaintainerAggregate {
  username: string
  email?: string
  packages: Array<{ name: string; score: number; description?: string; keywords: string[] }>
  totalScore: number
  maxScore: number
  lastSeen: number
  allKeywords: Set<string>
}

function aggregateMaintainer(
  username: string,
  email: string | undefined,
  pkg: NpmRegistryPackage,
  score: number,
  byName: Map<string, MaintainerAggregate>,
): void {
  const existing = byName.get(username)
  const lastSeen = pkg.time?.modified ? Date.parse(pkg.time.modified) : Date.now()
  const entry: MaintainerAggregate = existing ?? {
    username,
    email,
    packages: [],
    totalScore: 0,
    maxScore: 0,
    lastSeen: 0,
    allKeywords: new Set(),
  }
  // Prefer the latest non-empty email
  if (!entry.email && email) entry.email = email
  entry.packages.push({
    name: pkg.name,
    score,
    description: pkg.description,
    keywords: pkg.keywords ?? [],
  })
  entry.totalScore += score
  if (score > entry.maxScore) entry.maxScore = score
  if (lastSeen > entry.lastSeen) entry.lastSeen = lastSeen
  for (const k of pkg.keywords ?? []) entry.allKeywords.add(k)
  byName.set(username, entry)
}

function maintainerToPersonBuilder(m: MaintainerAggregate): RawBuilder {
  const packageCount = m.packages.length
  const sample = m.packages.slice(0, 5).map((p) => p.name)
  const moreCount = Math.max(0, packageCount - sample.length)
  const bio =
    packageCount === 1
      ? `Maintains ${m.packages[0].name} on npm`
      : `Maintains ${packageCount} npm package${packageCount === 1 ? '' : 's'}: ${sample.join(', ')}${moreCount > 0 ? ` +${moreCount}` : ''}`

  return {
    id: `npm-user-${m.username}`,
    kind: 'person' as const,
    source: 'npm',
    sourceId: m.username,
    username: m.username,
    displayName: m.username,
    avatarUrl: undefined,
    bio,
    profileUrl: `https://www.npmjs.com/~${m.username}`,
    // No followers. Use max package score × 100k as a "top package quality" proxy
    followersCount: Math.round(m.maxScore * 100000),
    language: undefined,
    country: undefined,
    topics: Array.from(m.allKeywords).slice(0, 10),
    metadata: {
      packageCount,
      totalScore: m.totalScore,
      maxScore: m.maxScore,
      lastSeen: m.lastSeen,
      // Email is intentionally NOT included in metadata — never exposed
      // to the client. The dedup module can re-derive it from the
      // registry if needed (out of scope for v1).
    },
  }
}

export interface SearchNpmOptions {
  page?: number
  perPage?: number
}

export async function searchNpm(
  keywords: string[],
  options: SearchNpmOptions = {},
): Promise<RawBuilder[]> {
  const { page = 1, perPage = 30 } = options
  if (keywords.length === 0 || keywords.join('').trim() === '') return []

  const results = await searchPackages(keywords)
  if (results.length === 0) return []

  // Fetch full metadata in parallel. Cap at 20 to be polite.
  const top = results.slice(0, 20)
  const metas = await Promise.all(top.map((r) => fetchPackage(r.package.name)))

  // Build packages + maintainer aggregates
  const packages: RawBuilder[] = []
  const maintainers = new Map<string, MaintainerAggregate>()

  for (let i = 0; i < top.length; i++) {
    const meta = metas[i]
    if (!meta) continue
    const score = top[i].score?.final ?? 0

    // Package entity
    packages.push(packageToRepoBuilder(meta, score))

    // Maintainer entities (deduped by username)
    for (const m of meta.maintainers ?? []) {
      if (!m.name) continue
      aggregateMaintainer(m.name, m.email, meta, score, maintainers)
    }
  }

  // Sort maintainers by total score, then package count
  const maintainerList = Array.from(maintainers.values()).sort((a, b) => {
    if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore
    return b.packages.length - a.packages.length
  })

  // Combine and paginate. People first, then repos.
  const all: RawBuilder[] = [
    ...maintainerList.map(maintainerToPersonBuilder),
    ...packages,
  ]

  const start = (page - 1) * perPage
  return all.slice(start, start + perPage)
}
