/**
 * Shared GitHub source-content helpers (plans: code-fingerprinting owns this
 * module; work-sample reuses the selection heuristics).
 *
 * Split deliberately: everything above `fetchRepoSamples` is pure and unit
 * tested against fixture trees, because sample *selection* is the part that
 * decides whether a fingerprint sees representative code or vendored junk —
 * and it is the part that can be verified without a network or a token.
 *
 * Every request is built from `api.github.com` plus parts we control; nothing
 * here ever fetches a user-supplied URL.
 */
import { env } from '~/shared/lib/env'

export class GitHubTokenMissingError extends Error {
  constructor() {
    super('GITHUB_TOKEN is not configured')
    this.name = 'GitHubTokenMissingError'
  }
}

export class GitHubRateLimitedError extends Error {
  constructor() {
    super('GitHub API rate limit exceeded')
    this.name = 'GitHubRateLimitedError'
  }
}

// ---------------------------------------------------------------------------
// Pure selection helpers
// ---------------------------------------------------------------------------

/** Paths that are never representative of how someone writes code: dependency
 *  trees, build output, vendored/generated code, lockfiles, snapshots. */
export const EXCLUDED_PATH_RE =
  /(^|\/)(node_modules|vendor|dist|build|out|generated|__snapshots__|third_party)(\/|$)|\.min\.|\.lock$|-lock\.(json|yaml)$/i

/** GitHub's `language` string → source extensions that count as that language.
 *  Intentionally small: these are the languages the fingerprint can actually
 *  reason about, and an unknown language falls back to "any known code file". */
export const LANGUAGE_EXTENSIONS: Record<string, string[]> = {
  typescript: ['ts', 'tsx'],
  javascript: ['js', 'jsx', 'mjs', 'cjs'],
  python: ['py'],
  rust: ['rs'],
  go: ['go'],
  ruby: ['rb'],
  java: ['java'],
  kotlin: ['kt', 'kts'],
  swift: ['swift'],
  c: ['c', 'h'],
  'c++': ['cpp', 'cc', 'hpp', 'hh'],
  'c#': ['cs'],
  elixir: ['ex', 'exs'],
  haskell: ['hs'],
}

const ALL_CODE_EXTENSIONS = [...new Set(Object.values(LANGUAGE_EXTENSIONS).flat())]

const MIN_FILE_BYTES = 1_024
const MAX_FILE_BYTES = 40_960
/** Mid-size files carry the most style signal per byte: big enough to show
 *  structure, small enough not to be a generated blob or a kitchen-sink file. */
const IDEAL_FILE_BYTES = 8_192

export interface TreeEntry {
  path: string
  type: string // 'blob' | 'tree'
  size?: number
}

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot === -1 ? '' : base.slice(dot + 1).toLowerCase()
}

export function extensionsForLanguage(language: string | null | undefined): string[] {
  if (!language) return ALL_CODE_EXTENSIONS
  return LANGUAGE_EXTENSIONS[language.toLowerCase()] ?? ALL_CODE_EXTENSIONS
}

/** Language-agnostic "is this a source file at all". Used by `work-sample`,
 *  which ranks by substance rather than by a single repo language. */
export function isCodeFile(path: string): boolean {
  return ALL_CODE_EXTENSIONS.includes(extensionOf(path))
}

/** A tree entry worth sampling: a blob, in-language, not excluded, and within
 *  the size band. Entries with no `size` (GitHub omits it on some responses)
 *  are rejected rather than guessed at. */
export function isCandidateFile(entry: TreeEntry, language?: string | null): boolean {
  if (entry.type !== 'blob') return false
  if (EXCLUDED_PATH_RE.test(entry.path)) return false
  if (typeof entry.size !== 'number') return false
  if (entry.size < MIN_FILE_BYTES || entry.size > MAX_FILE_BYTES) return false
  return extensionsForLanguage(language).includes(extensionOf(entry.path))
}

/** Lower sorts first. Files under `src/`/`lib/` or at the repo root beat deeply
 *  nested ones; within a tier, closest to `IDEAL_FILE_BYTES` wins. */
function rankOf(entry: TreeEntry): [number, number] {
  const depth = entry.path.split('/').length - 1
  const top = entry.path.split('/')[0]
  const preferred = depth === 0 || top === 'src' || top === 'lib' ? 0 : 1
  return [preferred, Math.abs((entry.size ?? 0) - IDEAL_FILE_BYTES)]
}

export function compareCandidates(a: TreeEntry, b: TreeEntry): number {
  const [aTier, aDist] = rankOf(a)
  const [bTier, bDist] = rankOf(b)
  if (aTier !== bTier) return aTier - bTier
  if (aDist !== bDist) return aDist - bDist
  return a.path.localeCompare(b.path) // stable, so tests and cache keys are deterministic
}

export function pickSampleFiles(tree: TreeEntry[], language: string | null | undefined, max: number): TreeEntry[] {
  return tree
    .filter((entry) => isCandidateFile(entry, language))
    .sort(compareCandidates)
    .slice(0, Math.max(0, max))
}

const TEST_PATH_RE = /(^|\/)(tests?|specs?|__tests__)(\/|$)|[.\-_](test|spec)\.[a-z0-9]+$/i

/** Share of the tree's code files that live in test paths. 0 when there are no
 *  code files at all (rather than NaN) — callers feed this straight to the model. */
export function testFileRatio(paths: string[]): number {
  const codeFiles = paths.filter(
    (p) => !EXCLUDED_PATH_RE.test(p) && ALL_CODE_EXTENSIONS.includes(extensionOf(p)),
  )
  if (codeFiles.length === 0) return 0
  const tests = codeFiles.filter((p) => TEST_PATH_RE.test(p)).length
  return tests / codeFiles.length
}

// Line-leading comment markers across the supported languages. This counts
// comment *lines*, not inline trailing comments — a cheap, deterministic proxy
// the model gets alongside the samples so it isn't guessing at documentation.
const COMMENT_PREFIXES = ['//', '#', '/*', '*/', '*', '--', '<!--', '"""', "'''", ';;']

export function commentDensity(content: string): number {
  const lines = content.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
  if (lines.length === 0) return 0
  const comments = lines.filter((l) => COMMENT_PREFIXES.some((p) => l.startsWith(p))).length
  return comments / lines.length
}

export function avgCommentDensity(samples: Array<{ content: string }>): number {
  if (samples.length === 0) return 0
  const total = samples.reduce((sum, s) => sum + commentDensity(s.content), 0)
  return total / samples.length
}

// ---------------------------------------------------------------------------
// Fetching pipeline
// ---------------------------------------------------------------------------

const GITHUB_API = 'https://api.github.com'
const MAX_TREE_ENTRIES = 5_000
const PROMPT_LINE_CAP = 300
const PROMPT_CHAR_CAP = 20_000
const TWENTY_FOUR_MONTHS_MS = 24 * 30 * 24 * 60 * 60 * 1000

function authHeaders(): Record<string, string> {
  if (!env.GITHUB_TOKEN) throw new GitHubTokenMissingError()
  return {
    Accept: 'application/vnd.github.v3+json',
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    'User-Agent': 'BuilderHunt/1.0 (code-fingerprinting)',
  }
}

async function ghFetch(path: string, accept?: string): Promise<Response> {
  const headers = authHeaders()
  if (accept) headers.Accept = accept
  const res = await fetch(`${GITHUB_API}${path}`, { headers })
  if (res.status === 403 || res.status === 429) {
    if (res.headers.get('x-ratelimit-remaining') === '0') throw new GitHubRateLimitedError()
  }
  return res
}

interface GhRepo {
  name: string
  fork: boolean
  size: number
  stargazers_count: number
  pushed_at: string
  default_branch: string
  language: string | null
}

/** Non-fork, non-empty, pushed within 24 months, top N by stars. Pure so the
 *  ranking rule is testable without hitting the API. */
export function selectRepos(repos: GhRepo[], max: number, now = Date.now()): GhRepo[] {
  return repos
    .filter((r) => !r.fork && r.size > 0)
    .filter((r) => now - new Date(r.pushed_at).getTime() <= TWENTY_FOUR_MONTHS_MS)
    .sort((a, b) => b.stargazers_count - a.stargazers_count)
    .slice(0, max)
}

interface GhRepoWithMeta extends GhRepo {
  id: number
  description: string | null
  html_url: string
}

export interface PortfolioProjectCandidate {
  id: string
  name: string
  description: string | null
  url: string
  stars: number
  language: string | null
}

/**
 * Real public repos for the portfolio-builder plan's project picker —
 * deliberately not fingerprinting's file-sample fetch (different shape: this
 * needs repo metadata for a project card, not source-file content). Reuses
 * the same `selectRepos` ranking (non-fork, non-empty, active within 24mo,
 * top-N by stars) so "which repos are worth featuring" stays one rule.
 */
export async function fetchPortfolioProjectCandidates(
  username: string,
  max = 12,
): Promise<PortfolioProjectCandidate[]> {
  const res = await ghFetch(`/users/${encodeURIComponent(username)}/repos?sort=pushed&per_page=30`)
  if (!res.ok) return []
  const repos = (await res.json()) as GhRepoWithMeta[]
  return selectRepos(repos, max).map((r) => {
    const meta = r as GhRepoWithMeta
    return {
      id: String(meta.id),
      name: meta.name,
      description: meta.description,
      url: meta.html_url,
      stars: meta.stargazers_count,
      language: meta.language,
    }
  })
}

export function truncateForPrompt(content: string): string {
  const lines = content.split('\n')
  const capped = lines.length > PROMPT_LINE_CAP ? lines.slice(0, PROMPT_LINE_CAP).join('\n') : content
  return capped.length > PROMPT_CHAR_CAP ? capped.slice(0, PROMPT_CHAR_CAP) : capped
}

export interface RepoSample {
  repo: string
  path: string
  content: string
}

export interface RepoSamplesResult {
  samples: RepoSample[]
  repos: string[]
  language: string | null
  testFileRatio: number
  avgCommentDensity: number
}

/**
 * Fetches up to `maxFiles` representative source files across the user's top
 * repos. Budget: 1 repos-list + one tree per repo + one blob per sample —
 * ≤ 13 requests at the default caps, which is what the plan's GitHub budget
 * allows.
 */
export async function fetchRepoSamples(
  username: string,
  options: { maxRepos?: number; maxFiles?: number } = {},
): Promise<RepoSamplesResult> {
  const maxRepos = options.maxRepos ?? 3
  const maxFiles = options.maxFiles ?? 8
  const perRepo = Math.max(1, Math.ceil(maxFiles / maxRepos))

  const reposRes = await ghFetch(`/users/${encodeURIComponent(username)}/repos?sort=pushed&per_page=30`)
  if (!reposRes.ok) return emptyResult()
  const selected = selectRepos((await reposRes.json()) as GhRepo[], maxRepos)
  if (selected.length === 0) return emptyResult()

  const language = selected.find((r) => r.language)?.language ?? null
  const samples: RepoSample[] = []
  const allPaths: string[] = []

  for (const repo of selected) {
    if (samples.length >= maxFiles) break
    const tree = await fetchTree(username, repo)
    allPaths.push(...tree.map((e) => e.path))
    const picks = pickSampleFiles(tree, repo.language ?? language, Math.min(perRepo, maxFiles - samples.length))
    for (const pick of picks) {
      const content = await fetchBlob(username, repo.name, pick.path)
      if (content === null) continue
      samples.push({ repo: repo.name, path: pick.path, content: truncateForPrompt(content) })
    }
  }

  return {
    samples,
    repos: selected.map((r) => r.name),
    language,
    testFileRatio: testFileRatio(allPaths),
    avgCommentDensity: avgCommentDensity(samples),
  }
}

function emptyResult(): RepoSamplesResult {
  return { samples: [], repos: [], language: null, testFileRatio: 0, avgCommentDensity: 0 }
}

/** Recursive tree, with the plan's documented fallback: a truncated or huge
 *  tree degrades to the root + `src/` listings rather than sampling from a
 *  partial, arbitrarily-cut tree. */
async function fetchTree(owner: string, repo: GhRepo): Promise<TreeEntry[]> {
  const res = await ghFetch(
    `/repos/${owner}/${repo.name}/git/trees/${encodeURIComponent(repo.default_branch)}?recursive=1`,
  )
  if (!res.ok) return []
  const body = (await res.json()) as { tree?: TreeEntry[]; truncated?: boolean }
  const tree = body.tree ?? []
  if (!body.truncated && tree.length <= MAX_TREE_ENTRIES) return tree
  return tree.filter((e) => {
    const depth = e.path.split('/').length - 1
    return depth === 0 || e.path.startsWith('src/')
  })
}

async function fetchBlob(owner: string, repo: string, path: string): Promise<string | null> {
  const res = await ghFetch(
    `/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`,
    'application/vnd.github.raw',
  )
  if (!res.ok) return null
  return res.text()
}
