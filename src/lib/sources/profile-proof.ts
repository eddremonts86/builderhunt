import { env } from '~/shared/lib/env'

/**
 * Verifies *identity* for profile-removal requests — "is the requester in control of this
 * external profile right now" — not *ownership* for claiming. Deliberately a separate module
 * from `~/shared/lib/claim-sources/*`: that one gates an authenticated in-app action (claiming a
 * builder into your own account) behind a bio challenge; this one gates an unauthenticated,
 * security-critical action (deleting a person's data from BuilderHunt) behind the same mechanic.
 * The two must be free to diverge (different timeouts, different source coverage, different
 * failure handling) without one plan's changes silently affecting the other's threat model.
 *
 * Per spec.md: "fixed API hosts, timeouts, response-size limits, and no redirect to arbitrary
 * hosts" — stricter than claim-sources' plain `fetch()`, since this path has no authenticated
 * session backing it.
 *
 * Only `verifyChallenge` calls out to the upstream API — deliberately not exposed until the
 * requester actually has a challenge to prove, matching the same "the expensive/abusable step is
 * verification, not creation" reasoning `claim.ts`/`claim/verify.ts` already apply: the removal
 * *request* endpoint never touches a third-party host at all (see `profile-removal.ts`), so it
 * cannot be used to probe whether a given username exists on GitHub/GitLab/etc, and cannot be
 * rate-limited into the ground by an upstream host's own 403/429s.
 */

export type ProfileProofFailureReason = 'not_found' | 'challenge_missing' | 'rate_limited' | 'timeout' | 'unsupported'

/**
 * `sourceId` on success is the SAME identifier convention `src/lib/sources/*.ts` writes into
 * `builders.sourceId` for that source (github/codeberg: the numeric account id; gitlab/devto: the
 * username) — this is what lets the removal flow match and delete every `builders` row for this
 * person by `(source, sourceId)`, not just the one row a cached search might already have.
 */
export type ProfileProofResult =
  | { ok: true; sourceId: string }
  | { ok: false; reason: ProfileProofFailureReason }

export interface ProfileProofAdapter {
  /** Fetches the public profile for `username` and checks whether `challenge` appears in its bio/about text. */
  verifyChallenge(username: string, challenge: string): Promise<ProfileProofResult>
}

export const PROFILE_PROOF_FETCH_TIMEOUT_MS = 5000

/** Refuses to read past this many bytes of a response body — a bio field is never this large; a
 * response this big is either a misbehaving host or something trying to exhaust memory. */
const MAX_RESPONSE_BYTES = 65_536

/**
 * A hardened fetch for unauthenticated, security-sensitive proof lookups: no redirect following
 * (an attacker-controlled redirect to an internal or arbitrary host is not something a bio-proof
 * check should ever traverse), a hard timeout, and a body-size cap enforced by reading the stream
 * incrementally rather than trusting `Content-Length`.
 */
async function fetchBounded(url: string, headers: Record<string, string> = {}): Promise<Response | 'timeout' | 'redirected' | 'too_large' | 'error'> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), PROFILE_PROOF_FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { headers, signal: controller.signal, redirect: 'manual' })
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) return 'redirected'
    const contentLength = res.headers.get('content-length')
    if (contentLength && Number(contentLength) > MAX_RESPONSE_BYTES) return 'too_large'
    return res
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return 'timeout'
    return 'error'
  } finally {
    clearTimeout(timeout)
  }
}

async function readBoundedText(res: Response): Promise<string | 'too_large'> {
  if (!res.body) return await res.text()
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        return 'too_large'
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8')
}

type FetchJsonResult =
  | { ok: true; body: unknown }
  | { ok: false; reason: Exclude<ProfileProofFailureReason, 'challenge_missing'> }

async function fetchJson(url: string, headers: Record<string, string>): Promise<FetchJsonResult> {
  const res = await fetchBounded(url, headers)
  if (res === 'timeout') return { ok: false, reason: 'timeout' }
  if (res === 'redirected' || res === 'too_large' || res === 'error') return { ok: false, reason: 'not_found' }
  if (res.status === 404) return { ok: false, reason: 'not_found' }
  if (res.status === 403 || res.status === 429) return { ok: false, reason: 'rate_limited' }
  if (!res.ok) return { ok: false, reason: 'not_found' }
  const text = await readBoundedText(res)
  if (text === 'too_large') return { ok: false, reason: 'not_found' }
  try {
    return { ok: true, body: JSON.parse(text) }
  } catch {
    return { ok: false, reason: 'not_found' }
  }
}

interface SingleUserAdapterConfig {
  buildUrl: (username: string) => string
  headers: () => Record<string, string>
  extractIdAndField: (body: unknown) => { sourceId: string | null; field: string | null }
}

function buildSingleUserAdapter(config: SingleUserAdapterConfig): ProfileProofAdapter {
  return {
    async verifyChallenge(username, challenge) {
      const result = await fetchJson(config.buildUrl(username), config.headers())
      if (!result.ok) return result
      const { sourceId, field } = config.extractIdAndField(result.body)
      if (!sourceId) return { ok: false, reason: 'not_found' }
      if (!field || !field.includes(challenge)) return { ok: false, reason: 'challenge_missing' }
      return { ok: true, sourceId }
    },
  }
}

const githubProfileProofAdapter = buildSingleUserAdapter({
  buildUrl: (username) => `https://api.github.com/users/${encodeURIComponent(username)}`,
  headers: () => {
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json' }
    if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`
    return headers
  },
  extractIdAndField: (body) => {
    const user = body as { id?: number; bio?: string | null }
    return { sourceId: user.id != null ? String(user.id) : null, field: user.bio ?? null }
  },
})

const codebergProfileProofAdapter = buildSingleUserAdapter({
  buildUrl: (username) => `${env.CODEBERG_API_URL ?? 'https://codeberg.org/api/v1'}/users/${encodeURIComponent(username)}`,
  headers: () => ({}),
  extractIdAndField: (body) => {
    const user = body as { id?: number; description?: string | null }
    return { sourceId: user.id != null ? String(user.id) : null, field: user.description ?? null }
  },
})

const devtoProfileProofAdapter = buildSingleUserAdapter({
  buildUrl: (username) => `https://dev.to/api/users/by_username?url=${encodeURIComponent(username)}`,
  headers: () => ({}),
  extractIdAndField: (body) => {
    const user = body as { username?: string; summary?: string | null }
    return { sourceId: user.username ?? null, field: user.summary ?? null }
  },
})

/** GitLab's public user lookup is a list endpoint (no direct "by username" GET), so it needs its
 * own exact-match-in-list logic rather than `buildSingleUserAdapter`'s single-object shape. */
const gitlabProfileProofAdapter: ProfileProofAdapter = {
  async verifyChallenge(username, challenge) {
    const headers: Record<string, string> = {}
    if (env.GITLAB_TOKEN) headers['PRIVATE-TOKEN'] = env.GITLAB_TOKEN
    const result = await fetchJson(`https://gitlab.com/api/v4/users?username=${encodeURIComponent(username)}`, headers)
    if (!result.ok) return result
    const users = result.body as Array<{ username: string; bio: string | null }>
    const user = Array.isArray(users) ? users.find((u) => u.username.toLowerCase() === username.toLowerCase()) : undefined
    if (!user) return { ok: false, reason: 'not_found' }
    if (!user.bio || !user.bio.includes(challenge)) return { ok: false, reason: 'challenge_missing' }
    return { ok: true, sourceId: user.username }
  },
}

/**
 * Only sources with a public, fetchable "bio"-shaped field can be automated. Aggregator sources
 * with no per-user profile page a requester could edit are deliberately absent — they route to
 * the manual privacy-review path instead of a false sense of automated proof (spec.md: "Initially
 * automate only sources with an authenticated official public profile endpoint and stable bio
 * field; all others show the privacy contact/manual review path").
 */
const PROFILE_PROOF_ADAPTERS: Partial<Record<string, ProfileProofAdapter>> = {
  github: githubProfileProofAdapter,
  gitlab: gitlabProfileProofAdapter,
  codeberg: codebergProfileProofAdapter,
  devto: devtoProfileProofAdapter,
}

export function getProfileProofAdapter(source: string): ProfileProofAdapter | null {
  return PROFILE_PROOF_ADAPTERS[source] ?? null
}

export function isProfileProofSupported(source: string): boolean {
  return source in PROFILE_PROOF_ADAPTERS
}
