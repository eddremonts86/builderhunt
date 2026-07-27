/**
 * Scheduling invitation capabilities (plan: calendar-scheduling-interview-intelligence, Phase 5
 * "Implement capability exchange and session validation").
 *
 * A capability is the *only* thing that authenticates a candidate. There is no account, no
 * password and no email round-trip — whoever holds the link can act on that one invitation and
 * nothing else. That makes the shape of this module the security boundary for the whole
 * accountless flow, so the choices below are deliberate:
 *
 * 1. **A random secret, not a signed token.** `scheduling_invitations.capability_hash` carries a
 *    unique index and `findInvitationByCapabilityHash` looks rows up by it. A signed token (like
 *    `security/feed-capability.ts`) cannot be revoked without a denylist; a stored hash is revoked
 *    by deleting or replacing one row. Revocation is a spec requirement, so hashes win.
 * 2. **Only the hash is persisted.** A database dump, a log line or a backup on the Storage Box
 *    never contains anything that can open an invitation. Losing the DB does not leak the links.
 * 3. **SHA-256, not a password hash.** The secret is 256 bits of CSPRNG output, so it has no
 *    guessable structure to slow an attacker down over — bcrypt/argon2 would only add latency to
 *    every candidate page load. This is the API-key pattern, not the password pattern.
 * 4. **The lookup is the comparison.** Because we hash the presented secret and query by equality,
 *    our code never compares secret material byte-by-byte, so there is no timing side channel to
 *    protect. `capabilitiesEqual` exists for the one case that does compare directly (rotation),
 *    and is constant-time.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** 256 bits. Long enough that enumeration is not a threat model we need to rate-limit our way out of. */
const CAPABILITY_BYTES = 32

/**
 * Domain separation. If a secret from some other capability system in this codebase is ever
 * presented here, it must not hash to a value that could match a row in this table.
 */
const HASH_DOMAIN = 'builderhunt:scheduling:capability:v1'

export interface IssuedCapability {
  /** Give this to the candidate, in a URL fragment. Never store it, never log it. */
  secret: string
  /** Store this. Safe in a database, a backup, or an error report. */
  hash: string
}

export function issueCapability(): IssuedCapability {
  const secret = randomBytes(CAPABILITY_BYTES).toString('base64url')
  return { secret, hash: hashCapability(secret) }
}

/**
 * Maps a presented secret to the value stored in `scheduling_invitations.capability_hash`.
 *
 * Returns `null` for anything that cannot be a capability we issued — wrong length, wrong
 * alphabet, empty. Callers then skip the query entirely, so malformed input cannot be used to
 * probe the database, and the caller's "not found" path is the same one a wrong-but-well-formed
 * secret takes. Indistinguishable responses are a spec requirement (non-enumerating).
 */
export function hashCapability(secret: string): string
export function hashCapability(secret: string, options: { strict: true }): string | null
export function hashCapability(secret: string, options?: { strict: true }): string | null {
  if (options?.strict) {
    // base64url of 32 bytes is always 43 chars with no padding.
    if (secret.length !== 43 || !/^[A-Za-z0-9_-]+$/.test(secret)) return null
  }
  return createHash('sha256').update(`${HASH_DOMAIN}:${secret}`).digest('hex')
}

/**
 * Constant-time equality for two capability secrets. Only needed when comparing a presented
 * secret against another secret held in memory (rotation); the normal path compares hashes in
 * the database instead.
 */
export function capabilitiesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}
