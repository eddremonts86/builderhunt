/**
 * Core service for the profile-removal/global-suppression subsystem (plan: audit-trust,
 * spec.md "Verified ownership and suppression design"). Orchestrates the two-step public flow:
 *
 *   1. `requestRemoval` — parse+allowlist the pasted profile URL, mint a single-use challenge,
 *      persist only its HMAC hash (never the plaintext), rate-limited by the caller (route-level,
 *      IP + profile key, matching `claim.ts`'s "creation is cheap, verification is the expensive
 *      step" split).
 *   2. `verifyRemoval` — the caller echoes back `{requestId, challenge}` (the plaintext challenge
 *      it received from step 1); matching its hash against the stored `challengeHash` IS the
 *      authorization check (nobody else can produce that plaintext), so this never needs its own
 *      session/auth. Only on a hash match do we call out to `profile-proof.ts` to confirm the
 *      challenge is actually live in the profile's bio right now, then insert the suppression and
 *      delete every matching `builders` row across every organization.
 *
 * `sourceId` on the request row is deliberately the URL-derived username for every source (even
 * github/codeberg, whose real `builders.sourceId` convention is a numeric account id) — resolving
 * the numeric id would require an upstream API call at request time, which is exactly the
 * unauthenticated-enumeration/abuse surface spec.md's "same response for existing/pending/unknown
 * identities" rule exists to avoid. The authoritative numeric id is only ever produced by
 * `profile-proof.ts`'s `verifyChallenge` at step 2, and is what gets written into the suppression.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { randomToken } from '~/lib/utils'
import { getProfileProofAdapter, isProfileProofSupported } from '~/lib/sources/profile-proof'
import { publicDb } from './db/client'
import { workerDb } from './db/worker-db'
import { invalidateSuppressionCache } from './profile-suppression'
import { emitSecurityAudit } from './security/audit'
import { consoleSecurityAuditSink } from './security/audit-sink'
import { env } from './env'
import {
  deleteBuildersAcrossOrganizations,
  findPendingRemovalRequest,
  findRemovalRequestById,
  insertRemovalRequest,
  insertSuppressionIfAbsent,
  markRemovalRequestRejected,
  markRemovalRequestVerified,
} from './repositories/profile-removal'

export const PROFILE_REMOVAL_CHALLENGE_TTL_MS = 30 * 60 * 1000

export type ProfileRemovalSource = 'github' | 'gitlab' | 'codeberg' | 'devto'

const HOST_TO_SOURCE: Record<string, ProfileRemovalSource> = {
  'github.com': 'github',
  'www.github.com': 'github',
  'gitlab.com': 'gitlab',
  'www.gitlab.com': 'gitlab',
  'codeberg.org': 'codeberg',
  'www.codeberg.org': 'codeberg',
  'dev.to': 'devto',
  'www.dev.to': 'devto',
}

const CANONICAL_HOST: Record<ProfileRemovalSource, string> = {
  github: 'github.com',
  gitlab: 'gitlab.com',
  codeberg: 'codeberg.org',
  devto: 'dev.to',
}

/** A single bare path segment, alphanumeric-with-hyphens, matching every supported source's
 * username rules closely enough to reject non-profile paths (repos, orgs, articles) up front. */
const USERNAME_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$/

export interface ParsedProfileUrl {
  source: ProfileRemovalSource
  username: string
  normalizedUrl: string
}

/** Accepts only `https://<allowlisted host>/<single username segment>` — no query, no fragment
 * (both silently dropped by `URL`, so absence is checked on `pathname` alone plus a length check
 * on `search`/`hash`), no nested path (repo/article pages are not profile pages). */
export function normalizeProfileUrl(rawUrl: string): ParsedProfileUrl | null {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:') return null
  const source = HOST_TO_SOURCE[parsed.hostname.toLowerCase()]
  if (!source) return null
  const segments = parsed.pathname.split('/').filter(Boolean)
  if (segments.length !== 1) return null
  const username = segments[0]
  if (!USERNAME_PATTERN.test(username)) return null
  return { source, username, normalizedUrl: `https://${CANONICAL_HOST[source]}/${username}` }
}

/** 256 bits of entropy — short enough to paste into a bio field, long enough that guessing one is
 * infeasible within its 30-minute lifetime. */
export function generateRemovalChallenge(): string {
  return `bh-privacy-${randomToken(32)}`
}

function hashRemovalValue(value: string, key: string): string {
  return createHmac('sha256', key).update(`builderhunt:profile-removal:v1:${value}`).digest('hex')
}

/** Tries every currently-valid key (current, then previous during a rotation window) — same
 * overlap-window convention as `billing/webhook-inbox.ts`'s signature verification. */
function verifyRemovalValue(value: string, hash: string, keys: string[]): boolean {
  const expected = Buffer.from(hash, 'hex')
  for (const key of keys) {
    const candidate = Buffer.from(hashRemovalValue(value, key), 'hex')
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) return true
  }
  return false
}

/** Reads the current/previous keys from `env` — kept separate from the pure hashing functions
 * above (same "never read `env` directly inside the crypto primitive" convention as
 * `abuse/device.ts`'s `computeDeviceHash`) so callers/tests can inject an explicit key list
 * instead. */
export function getRemovalHmacKeys(): string[] {
  return [env.PROFILE_REMOVAL_HMAC_KEY, env.PROFILE_REMOVAL_HMAC_KEY_PREVIOUS].filter((key): key is string => Boolean(key))
}

export function isRemovalRequestExpired(expiresAt: Date | string): boolean {
  return new Date(expiresAt).getTime() <= Date.now()
}

export type RequestRemovalResult =
  | { kind: 'invalid_url' }
  | { kind: 'unsupported'; source: string | null }
  | { kind: 'issued'; requestId: string; source: ProfileRemovalSource; username: string; challenge: string; instructions: string; expiresAt: string }

const SOURCE_LABELS: Record<ProfileRemovalSource, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  codeberg: 'Codeberg',
  devto: 'DEV.to',
}

export function buildRemovalInstructions(source: ProfileRemovalSource, challenge: string): string {
  return `Add "${challenge}" to your ${SOURCE_LABELS[source]} bio to confirm you control this profile, then verify. It expires in 30 minutes and can be removed afterward.`
}

/**
 * Starts (or reissues) a removal request. Always returns the SAME response shape regardless of
 * whether the profile exists, already has a pending request, or is already suppressed — spec.md:
 * "the same 202 response for existing/pending/unknown identities to limit enumeration."
 * `requesterEmail` is optional contact info only (hashed, never proof of ownership by itself).
 */
export async function requestProfileRemoval(input: {
  profileUrl: string
  requesterEmail?: string | null
  requestId?: string
  db?: PostgresJsDatabase
  hmacKeys?: string[]
}): Promise<RequestRemovalResult> {
  const db = input.db ?? publicDb
  const parsed = normalizeProfileUrl(input.profileUrl)
  if (!parsed) return { kind: 'invalid_url' }

  if (!isProfileProofSupported(parsed.source)) {
    return { kind: 'unsupported', source: parsed.source }
  }

  const keys = input.hmacKeys ?? getRemovalHmacKeys()
  const currentKey = keys[0]
  if (!currentKey) throw new Error('PROFILE_REMOVAL_HMAC_KEY is not configured')

  // A stale plaintext challenge is unrecoverable by design (never stored) — so re-requesting
  // always supersedes any prior pending request with a fresh one, rather than trying to reissue
  // a challenge whose plaintext is already gone.
  const existing = await findPendingRemovalRequest(parsed.source, parsed.username, db)
  if (existing) await markRemovalRequestRejected(existing.id, db)

  const challenge = generateRemovalChallenge()
  const expiresAt = new Date(Date.now() + PROFILE_REMOVAL_CHALLENGE_TTL_MS)
  const row = await insertRemovalRequest({
    id: input.requestId ?? randomUUID(),
    source: parsed.source,
    sourceId: parsed.username,
    normalizedProfileUrl: parsed.normalizedUrl,
    requesterEmailHash: input.requesterEmail ? hashRemovalValue(input.requesterEmail.toLowerCase().trim(), currentKey) : null,
    challengeHash: hashRemovalValue(challenge, currentKey),
    expiresAt,
  }, db)

  await emitSecurityAudit({
    organizationId: null,
    actorUserId: null,
    action: 'profile_removal.requested',
    targetType: 'profile_removal_request',
    targetId: row.id,
    result: 'allowed',
    requestId: randomUUID(),
    details: { source: parsed.source },
  }, consoleSecurityAuditSink)

  return {
    kind: 'issued',
    requestId: row.id,
    source: parsed.source,
    username: parsed.username,
    challenge,
    instructions: buildRemovalInstructions(parsed.source, challenge),
    expiresAt: expiresAt.toISOString(),
  }
}

export type VerifyRemovalResult =
  | { kind: 'not_found' }
  | { kind: 'expired' }
  | { kind: 'invalid_challenge' }
  | { kind: 'proof_failed'; reason: string }
  | { kind: 'verified'; source: string; sourceId: string; buildersDeleted: number }

/** Confirms the caller-supplied plaintext `challenge` matches the request's stored hash (the
 * authorization check — see module comment), then re-checks the source's bio for it right now,
 * and only on success creates the suppression and deletes every matching `builders` row. */
export async function verifyProfileRemoval(input: {
  requestId: string
  challenge: string
  db?: PostgresJsDatabase
  workerDb?: PostgresJsDatabase
  hmacKeys?: string[]
}): Promise<VerifyRemovalResult> {
  const db = input.db ?? publicDb
  const workerConn = input.workerDb ?? workerDb
  const request = await findRemovalRequestById(input.requestId, db)
  if (!request) return { kind: 'not_found' }
  if (request.status !== 'pending') return { kind: 'not_found' }
  if (isRemovalRequestExpired(request.expiresAt)) {
    await markRemovalRequestRejected(request.id, db)
    return { kind: 'expired' }
  }

  const keys = input.hmacKeys ?? getRemovalHmacKeys()
  if (!verifyRemovalValue(input.challenge, request.challengeHash, keys)) {
    return { kind: 'invalid_challenge' }
  }

  const adapter = getProfileProofAdapter(request.source)
  if (!adapter) return { kind: 'proof_failed', reason: 'unsupported' }

  const proof = await adapter.verifyChallenge(request.sourceId, input.challenge)
  if (!proof.ok) return { kind: 'proof_failed', reason: proof.reason }

  const verified = await markRemovalRequestVerified(request.id, db)
  if (!verified) return { kind: 'not_found' }

  await insertSuppressionIfAbsent({
    id: randomUUID(),
    source: request.source,
    sourceId: proof.sourceId,
    normalizedProfileUrlHash: hashRemovalValue(request.normalizedProfileUrl, keys[0]!),
    reason: 'verified-removal',
  }, db)
  invalidateSuppressionCache()

  const buildersDeleted = await deleteBuildersAcrossOrganizations(request.source, proof.sourceId, workerConn)

  await emitSecurityAudit({
    organizationId: null,
    actorUserId: null,
    action: 'profile_removal.verified',
    targetType: 'profile_suppression',
    targetId: null,
    result: 'allowed',
    requestId: randomUUID(),
    details: { source: request.source, buildersDeleted },
  }, consoleSecurityAuditSink)

  return { kind: 'verified', source: request.source, sourceId: proof.sourceId, buildersDeleted }
}
