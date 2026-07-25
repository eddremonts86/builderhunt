export type ClaimProofFailureReason = 'not_found' | 'challenge_missing' | 'rate_limited' | 'timeout' | 'unsupported'

export type ClaimProofResult =
  | { ok: true }
  | { ok: false; reason: ClaimProofFailureReason }

export interface ClaimSourceAdapter {
  /** Fetches the public profile for `username` and checks whether `challenge` appears in its bio/about text. */
  verifyChallenge(username: string, challenge: string): Promise<ClaimProofResult>
}

export const CLAIM_SOURCE_FETCH_TIMEOUT_MS = 5000
