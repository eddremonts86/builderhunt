import { env } from '~/shared/lib/env'
import { createHash } from 'node:crypto'

/**
 * Plan: work-sample. URL parsing + content fetching for the "analyze a
 * public GitHub URL" feature. Path-selection heuristics and the shared GitHub
 * error types come from `./content` (owned by `code-fingerprinting`, which
 * both plans' specs designate as the shared module).
 *
 * Only `api.github.com` requests built from the *parsed* (owner, repo,
 * number|path) parts are ever made — the user-supplied URL itself is never
 * fetched, which is the SSRF containment the spec requires.
 */

export {
  GitHubRateLimitedError,
  GitHubTokenMissingError,
} from './content'
import { EXCLUDED_PATH_RE, GitHubRateLimitedError, GitHubTokenMissingError, isCodeFile } from './content'

export class SampleNotFoundError extends Error {
  constructor() {
    super('Sample not found (private, deleted, or does not exist)')
    this.name = 'SampleNotFoundError'
  }
}

export type SampleType = 'repo' | 'pr' | 'file'

export interface ParsedRepoSample { type: 'repo'; owner: string; repo: string }
export interface ParsedPrSample { type: 'pr'; owner: string; repo: string; number: number }
export interface ParsedFileSample { type: 'file'; owner: string; repo: string; ref: string; path: string }
export type ParsedSample = ParsedRepoSample | ParsedPrSample | ParsedFileSample

const SEGMENT = '[^/]+'
const REPO_RE = new RegExp(`^/(${SEGMENT})/(${SEGMENT})/?$`)
const PR_RE = new RegExp(`^/(${SEGMENT})/(${SEGMENT})/pull/(\\d+)/?$`)
const FILE_RE = new RegExp(`^/(${SEGMENT})/(${SEGMENT})/blob/([^/]+)/(.+)$`)

/**
 * Pure. Accepts exactly the three github.com URL shapes the spec allows;
 * everything else (other hosts, gists, wikis, javascript: schemes,
 * malformed input) returns null rather than throwing, so callers can map
 * `null` straight to a 400 without a try/catch.
 */
export function parseSampleUrl(input: string): ParsedSample | null {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return null

  const path = url.pathname

  const prMatch = PR_RE.exec(path)
  if (prMatch) {
    return { type: 'pr', owner: prMatch[1], repo: prMatch[2], number: Number(prMatch[3]) }
  }

  const fileMatch = FILE_RE.exec(path)
  if (fileMatch) {
    return { type: 'file', owner: fileMatch[1], repo: fileMatch[2], ref: fileMatch[3], path: fileMatch[4] }
  }

  const repoMatch = REPO_RE.exec(path)
  if (repoMatch) {
    return { type: 'repo', owner: repoMatch[1], repo: repoMatch[2] }
  }

  return null
}

const GITHUB_API = 'https://api.github.com'
const MAX_REPO_FILES = 6
const README_CAP = 10_000
const REPO_FILE_CAP = 20_000
const REPO_FILE_LINE_CAP = 300
const PR_DIFF_CAP = 60_000
const FILE_FETCH_CAP = 100_000
const FILE_PROMPT_CAP = 20_000

interface GhContentEntry {
  name: string
  path: string
  type: 'file' | 'dir'
  size: number
}

interface GhPull {
  title: string
  body: string | null
}

function authHeaders(): Record<string, string> {
  if (!env.GITHUB_TOKEN) throw new GitHubTokenMissingError()
  return {
    Accept: 'application/vnd.github.v3+json',
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    'User-Agent': 'BuilderHunt/1.0 (work-sample)',
  }
}

async function ghFetch(path: string, accept?: string): Promise<Response> {
  const headers = authHeaders()
  if (accept) headers.Accept = accept
  const res = await fetch(`${GITHUB_API}${path}`, { headers })
  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers.get('x-ratelimit-remaining')
    if (remaining === '0') throw new GitHubRateLimitedError()
  }
  return res
}

function truncateLines(content: string, maxChars: number, maxLines: number): { content: string; truncated: boolean } {
  const lines = content.split('\n')
  let truncated = false
  let sliced = lines
  if (lines.length > maxLines) {
    sliced = lines.slice(0, maxLines)
    truncated = true
  }
  let joined = sliced.join('\n')
  if (joined.length > maxChars) {
    joined = joined.slice(0, maxChars)
    truncated = true
  }
  return { content: joined, truncated }
}

async function fetchReadme(owner: string, repo: string): Promise<string | null> {
  const res = await ghFetch(`/repos/${owner}/${repo}/readme`, 'application/vnd.github.raw')
  if (!res.ok) return null
  const text = await res.text()
  return truncateLines(text, README_CAP, 10_000).content
}

async function listRepoFiles(owner: string, repo: string): Promise<GhContentEntry[]> {
  const res = await ghFetch(`/repos/${owner}/${repo}/contents/`)
  if (!res.ok) return []
  const entries = (await res.json()) as GhContentEntry[]
  return entries.filter((e) => e.type === 'file')
}

/** Deliberately *not* `content.ts`'s `compareCandidates`: fingerprinting wants
 *  mid-size files (densest style signal), whereas a work-sample review wants
 *  the most substantial files it can show a recruiter. Only the exclusion set
 *  and the "is this source code" test are genuinely shared. */
function rankFiles(entries: GhContentEntry[]): GhContentEntry[] {
  return entries
    .filter((e) => !EXCLUDED_PATH_RE.test(e.path))
    .sort((a, b) => {
      const aCode = isCodeFile(a.path) ? 1 : 0
      const bCode = isCodeFile(b.path) ? 1 : 0
      if (aCode !== bCode) return bCode - aCode
      return b.size - a.size
    })
}

async function fetchFileContent(owner: string, repo: string, path: string, ref?: string): Promise<string | null> {
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : ''
  const res = await ghFetch(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}${query}`, 'application/vnd.github.raw')
  if (!res.ok) return null
  return res.text()
}

export interface FetchedFile { path: string; content: string }

export interface FetchedContent {
  readme: string | null
  files: FetchedFile[]
  diff: string | null
  prTitle: string | null
  prBody: string | null
  stats: { totalFiles: number | null; analyzedFiles: number; truncated: boolean }
}

async function fetchRepoContent(parsed: ParsedRepoSample): Promise<FetchedContent> {
  const readmeRes = await ghFetch(`/repos/${parsed.owner}/${parsed.repo}`)
  if (!readmeRes.ok) throw new SampleNotFoundError()

  const [readme, allEntries] = await Promise.all([
    fetchReadme(parsed.owner, parsed.repo),
    listRepoFiles(parsed.owner, parsed.repo),
  ])

  const ranked = rankFiles(allEntries)
  const selected = ranked.slice(0, MAX_REPO_FILES)
  const files: FetchedFile[] = []
  let anyTruncated = false
  for (const entry of selected) {
    const content = await fetchFileContent(parsed.owner, parsed.repo, entry.path)
    if (content === null) continue
    const { content: truncatedContent, truncated } = truncateLines(content, REPO_FILE_CAP, REPO_FILE_LINE_CAP)
    if (truncated) anyTruncated = true
    files.push({ path: entry.path, content: truncatedContent })
  }

  return {
    readme,
    files,
    diff: null,
    prTitle: null,
    prBody: null,
    stats: {
      totalFiles: ranked.length,
      analyzedFiles: files.length,
      truncated: anyTruncated || ranked.length > selected.length,
    },
  }
}

async function fetchPrContent(parsed: ParsedPrSample): Promise<FetchedContent> {
  const [metaRes, diffRes] = await Promise.all([
    ghFetch(`/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}`),
    ghFetch(`/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}`, 'application/vnd.github.diff'),
  ])
  if (!metaRes.ok) throw new SampleNotFoundError()
  const meta = (await metaRes.json()) as GhPull
  const rawDiff = diffRes.ok ? await diffRes.text() : ''

  let diff = rawDiff
  let truncated = false
  if (diff.length > PR_DIFF_CAP) {
    // Truncate at a file boundary — cut back to the last "diff --git" marker
    // before the cap rather than mid-hunk.
    const capped = diff.slice(0, PR_DIFF_CAP)
    const lastBoundary = capped.lastIndexOf('\ndiff --git ')
    diff = lastBoundary > 0 ? capped.slice(0, lastBoundary) : capped
    truncated = true
  }

  return {
    readme: null,
    files: [],
    diff,
    prTitle: meta.title?.slice(0, 300) ?? null,
    prBody: meta.body?.slice(0, 5_000) ?? null,
    stats: { totalFiles: null, analyzedFiles: 1, truncated },
  }
}

async function fetchFileSample(parsed: ParsedFileSample): Promise<FetchedContent> {
  const res = await ghFetch(`/repos/${parsed.owner}/${parsed.repo}/contents/${encodeURIComponent(parsed.path)}?ref=${encodeURIComponent(parsed.ref)}`, 'application/vnd.github.raw')
  if (!res.ok) throw new SampleNotFoundError()
  const raw = await res.text()
  const fetchCapped = raw.length > FILE_FETCH_CAP ? raw.slice(0, FILE_FETCH_CAP) : raw
  const { content, truncated } = truncateLines(fetchCapped, FILE_PROMPT_CAP, 10_000)

  return {
    readme: null,
    files: [{ path: parsed.path, content }],
    diff: null,
    prTitle: null,
    prBody: null,
    stats: { totalFiles: 1, analyzedFiles: 1, truncated: truncated || raw.length > FILE_FETCH_CAP },
  }
}

/**
 * Dispatches to the per-type fetcher. At most ~12 `api.github.com` requests
 * (1 repo-info + 1 readme + 1 listing + up to 6 file fetches for `repo`; 2
 * for `pr`; 1 for `file`).
 */
export async function fetchSampleContent(parsed: ParsedSample): Promise<FetchedContent> {
  if (parsed.type === 'repo') return fetchRepoContent(parsed)
  if (parsed.type === 'pr') return fetchPrContent(parsed)
  return fetchFileSample(parsed)
}

/** sha256 of the fetched content — used for re-analysis / force-push detection. */
export function computeContentHash(content: FetchedContent): string {
  const parts = [
    content.readme ?? '',
    ...content.files.map((f) => `${f.path}:${f.content}`),
    content.diff ?? '',
    content.prTitle ?? '',
    content.prBody ?? '',
  ]
  return createHash('sha256').update(parts.join(' ')).digest('hex')
}
