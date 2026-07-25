import { env } from '~/shared/lib/env'
import type { ClaimProofResult, ClaimSourceAdapter } from './types'
import { CLAIM_SOURCE_FETCH_TIMEOUT_MS } from './types'

interface GLUser {
  username: string
  bio: string | null
}

export const gitlabClaimAdapter: ClaimSourceAdapter = {
  async verifyChallenge(username, challenge): Promise<ClaimProofResult> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), CLAIM_SOURCE_FETCH_TIMEOUT_MS)
    try {
      const headers: Record<string, string> = {}
      if (env.GITLAB_TOKEN) headers['PRIVATE-TOKEN'] = env.GITLAB_TOKEN
      // `?username=` is an exact-match lookup on gitlab.com's public API and, unlike the
      // search-scoped endpoint used by src/lib/sources/gitlab.ts, returns full user objects
      // (including `bio`) without requiring auth.
      const res = await fetch(`https://gitlab.com/api/v4/users?username=${encodeURIComponent(username)}`, {
        headers,
        signal: controller.signal,
      })
      if (res.status === 403 || res.status === 429) return { ok: false, reason: 'rate_limited' }
      if (!res.ok) return { ok: false, reason: 'not_found' }
      const users = (await res.json()) as GLUser[]
      const user = users.find((u) => u.username.toLowerCase() === username.toLowerCase())
      if (!user) return { ok: false, reason: 'not_found' }
      if (!user.bio || !user.bio.includes(challenge)) return { ok: false, reason: 'challenge_missing' }
      return { ok: true }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return { ok: false, reason: 'timeout' }
      return { ok: false, reason: 'not_found' }
    } finally {
      clearTimeout(timeout)
    }
  },
}
