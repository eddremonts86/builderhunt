import type { RawBuilder } from '~/lib/sources/types'

/**
 * npm registry source — package maintainers as a class of builders that
 * no other source captures.
 *
 * Strategy:
 *   1. Search packages via the first-party registry search endpoint
 *      (`registry.npmjs.org/-/v1/search?text=...&size=20`) — gives us a
 *      ranked list of packages with maintainers, keywords, license, and
 *      version already inline (no separate per-package fetch needed to
 *      build the base entities).
 *   2. For the packages that actually end up in the returned page slice
 *      (not every result — pagination-aware), fetch full registry metadata
 *      (`/registry.npmjs.org/{name}`) to prefer `time.modified` /
 *      `dist-tags.latest` when available, falling back to the search
 *      result's own `updated`/`version` fields if that fetch fails.
 *   3. Emit two entity types:
 *        - kind: 'repo' for the packages themselves
 *        - kind: 'person' for the maintainers (deduped across packages)
 *   4. `score.detail.quality` (bounded 0-1, same semantic npms.io's old
 *      `score.final` had) is used as the `followersCount` proxy for
 *      packages; maintainers get aggregated package quality + count.
 *
 * Quota: no documented limit. The registry is CORS-friendly. We cap at
 * 20 packages per search to be polite.
 *
 * Spec reference: plans/phase-1/12-npm-registry-integration/spec.md. Migrated off
 * npms.io (shut down/unreliable) to this endpoint 2026-07-25 — one real
 * deviation from the migration task's own assumption worth flagging:
 * `score.final` on THIS endpoint is an unbounded relevance/ranking score
 * (e.g. ~2300 for an exact-name hit like "react"), not npms.io's bounded
 * 0-1 quality score the task assumed — using it directly would multiply
 * out to absurd `followersCount` values. `score.detail.quality` is the
 * actual bounded 0-1 field and is what's used here instead.
 */
interface NpmSearchObject {
  package: {
    name: string
    version?: string
    description?: string
    keywords?: string[]
    license?: string
    date?: string
    publisher?: { username: string; email: string }
    maintainers?: Array<{ username: string; email: string }>
    links?: { npm?: string; homepage?: string; repository?: string }
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
  /** ISO timestamp of the package's last publish — always present on every search result,
   * unlike `time.modified` which requires a separate per-package registry fetch. */
  updated?: string
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

const NPM_REGISTRY = 'https://registry.npmjs.org'
const NPM_SEARCH = `${NPM_REGISTRY}/-/v1/search`

async function searchPackages(keywords: string[]): Promise<NpmSearchObject[]> {
  const q = keywords.join(' ')
  try {
    const res = await fetch(
      `${NPM_SEARCH}?text=${encodeURIComponent(q)}&size=20`,
      { headers: { 'User-Agent': 'BuilderHunt/1.0 (npm source)' } },
    )
    if (!res.ok) return []
    const data = (await res.json()) as { objects: NpmSearchObject[] }
    return data.objects ?? []
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

function qualityScore(obj: NpmSearchObject): number {
  return obj.score?.detail?.quality ?? 0
}

function packageToRepoBuilder(obj: NpmSearchObject, registryMeta: NpmRegistryPackage | null): RawBuilder {
  const pkg = obj.package
  const lastModified = registryMeta?.time?.modified
    ? Date.parse(registryMeta.time.modified)
    : obj.updated ? Date.parse(obj.updated) : Date.now()
  const version = registryMeta?.['dist-tags']?.latest ?? pkg.version
  const license = registryMeta?.license ?? pkg.license
  const maintainerCount = (registryMeta?.maintainers ?? pkg.maintainers)?.length ?? 0

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
    // Bounded 0-1 quality score, multiplied for a followers-like scale.
    followersCount: Math.round(qualityScore(obj) * 100000),
    language: 'javascript',
    country: undefined,
    topics: (pkg.keywords ?? []).slice(0, 8),
    metadata: {
      version,
      license,
      lastSeen: isNaN(lastModified) ? Date.now() : lastModified,
      maintainerCount,
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
  obj: NpmSearchObject,
  score: number,
  byName: Map<string, MaintainerAggregate>,
): void {
  const pkg = obj.package
  const existing = byName.get(username)
  const lastSeen = obj.updated ? Date.parse(obj.updated) : Date.now()
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
  if (!isNaN(lastSeen) && lastSeen > entry.lastSeen) entry.lastSeen = lastSeen
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
    // No followers. Use max package quality score × 100k as a "top package quality" proxy
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

  const top = results.slice(0, 20)

  // Build maintainer aggregates from every result's inline `maintainers` — no per-package
  // fetch needed for this, unlike the npms.io-era version of this file.
  const maintainers = new Map<string, MaintainerAggregate>()
  for (const obj of top) {
    for (const m of obj.package.maintainers ?? []) {
      if (!m.username) continue
      aggregateMaintainer(m.username, m.email, obj, qualityScore(obj), maintainers)
    }
  }
  const maintainerList = Array.from(maintainers.values()).sort((a, b) => {
    if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore
    return b.packages.length - a.packages.length
  })

  // People first, then repos — build package entities from the inline search data by default.
  const peopleAndPackages: RawBuilder[] = [
    ...maintainerList.map(maintainerToPersonBuilder),
    ...top.map((obj) => packageToRepoBuilder(obj, null)),
  ]

  const start = (page - 1) * perPage
  const pageSlice = peopleAndPackages.slice(start, start + perPage)

  // Only for the packages actually landing in this page slice, fetch full registry metadata
  // to prefer `time.modified`/`dist-tags.latest` over the search result's own `updated`/
  // `version` fields — the one place this migration still makes a per-package call, and only
  // for what's actually displayed, not all 20 search results.
  const packageNamesInSlice = pageSlice
    .filter((b) => b.kind === 'repo' && b.source === 'npm')
    .map((b) => b.sourceId)
  if (packageNamesInSlice.length === 0) return pageSlice

  const registryMetas = await Promise.all(packageNamesInSlice.map((name) => fetchPackage(name)))
  const registryMetaByName = new Map(packageNamesInSlice.map((name, i) => [name, registryMetas[i]]))
  const objByName = new Map(top.map((obj) => [obj.package.name, obj]))

  return pageSlice.map((b) => {
    if (b.kind !== 'repo' || b.source !== 'npm') return b
    const obj = objByName.get(b.sourceId)
    const registryMeta = registryMetaByName.get(b.sourceId) ?? null
    return obj ? packageToRepoBuilder(obj, registryMeta) : b
  })
}
