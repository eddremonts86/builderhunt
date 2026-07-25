import type { ClaimProofResult, ClaimSourceAdapter } from './types'
import { CLAIM_SOURCE_FETCH_TIMEOUT_MS } from './types'

interface DevToUser {
  summary: string | null
}

export const devtoClaimAdapter: ClaimSourceAdapter = {
  async verifyChallenge(username, challenge): Promise<ClaimProofResult> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), CLAIM_SOURCE_FETCH_TIMEOUT_MS)
    try {
      const res = await fetch(`https://dev.to/api/users/by_username?url=${encodeURIComponent(username)}`, {
        signal: controller.signal,
      })
      if (res.status === 404) return { ok: false, reason: 'not_found' }
      if (res.status === 429) return { ok: false, reason: 'rate_limited' }
      if (!res.ok) return { ok: false, reason: 'not_found' }
      const user = (await res.json()) as DevToUser
      if (!user.summary || !user.summary.includes(challenge)) return { ok: false, reason: 'challenge_missing' }
      return { ok: true }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return { ok: false, reason: 'timeout' }
      return { ok: false, reason: 'not_found' }
    } finally {
      clearTimeout(timeout)
    }
  },
}
