import { randomToken } from '~/lib/utils'

export const CLAIM_CHALLENGE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * A public, non-secret proof string: the claimant pastes it into their
 * external profile's bio, so it must be short enough to type/read there.
 * Unlike the legacy email-verification token, this is never hashed — the
 * whole point is that it's visible on a public profile.
 */
export function generateClaimChallenge(): string {
  return `bh-verify-${randomToken(6)}`
}

export function isClaimExpired(expiresAt: Date | string | null): boolean {
  if (!expiresAt) return true
  return new Date(expiresAt).getTime() <= Date.now()
}

export function buildClaimInstructions(source: string, challenge: string): string {
  const label = CLAIM_SOURCE_LABELS[source] ?? source
  return `Add "${challenge}" to your ${label} bio, then come back and verify.`
}

const CLAIM_SOURCE_LABELS: Record<string, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  codeberg: 'Codeberg',
  devto: 'DEV.to',
}
