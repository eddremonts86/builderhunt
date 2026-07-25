import { env } from '~/shared/lib/env'
import type { ClaimProofResult, ClaimSourceAdapter } from './types'
import { CLAIM_SOURCE_FETCH_TIMEOUT_MS } from './types'

interface GitHubUser {
  bio: string | null
}

export const githubClaimAdapter: ClaimSourceAdapter = {
  async verifyChallenge(username, challenge): Promise<ClaimProofResult> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), CLAIM_SOURCE_FETCH_TIMEOUT_MS)
    try {
      const headers: Record<string, string> = { Accept: 'application/vnd.github+json' }
      if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`
      const res = await fetch(`https://api.github.com/users/${encodeURIComponent(username)}`, {
        headers,
        signal: controller.signal,
      })
      if (res.status === 404) return { ok: false, reason: 'not_found' }
      if (res.status === 403 || res.status === 429) return { ok: false, reason: 'rate_limited' }
      if (!res.ok) return { ok: false, reason: 'not_found' }
      const user = (await res.json()) as GitHubUser
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
