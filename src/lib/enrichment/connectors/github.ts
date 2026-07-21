/**
 * GitHub exact-profile canary adapter (spec §4, §8; tasks.md Phase 3).
 * Uses the tracked identity's own username through the official REST API —
 * no broad search, no HTML fallback.
 */

import { env } from '~/shared/lib/env'
import type { ConnectorResult, EnrichmentConnector, EnrichmentEvidencePayload, EnrichmentTarget } from '../types'
import { getSourcePolicy } from '../policies'
import { ENRICHMENT_DEFAULT_USER_AGENT, SafeFetchError, safeFetch } from '../network'

interface GithubUserResponse {
  id: number
  login: string
  name: string | null
  bio: string | null
  company: string | null
  location: string | null
  html_url: string
}

const policy = getSourcePolicy('github')
if (!policy) throw new Error('github connector loaded without a source policy')

export const githubConnector: EnrichmentConnector = {
  id: 'github',
  policy,
  supports(target: EnrichmentTarget): boolean {
    return target.source === 'github' && Boolean(target.username)
  },
  async collect(target: EnrichmentTarget, signal: AbortSignal): Promise<ConnectorResult> {
    try {
      const result = await safeFetch(`https://api.github.com/users/${encodeURIComponent(target.username)}`, {
        allowedHosts: policy.allowedHosts,
        signal,
        userAgent: env.ENRICHMENT_USER_AGENT ?? ENRICHMENT_DEFAULT_USER_AGENT,
        headers: {
          Accept: 'application/vnd.github.v3+json',
          ...(env.GITHUB_TOKEN ? { Authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}),
        },
      })
      const data = JSON.parse(result.body) as GithubUserResponse
      const payload: EnrichmentEvidencePayload = {
        profileUrl: data.html_url,
        username: data.login,
        displayName: data.name ?? undefined,
        headline: data.bio ?? undefined,
        organization: data.company ?? undefined,
        location: data.location ?? undefined,
        bio: data.bio ?? undefined,
        topics: [],
      }
      return {
        kind: 'evidence',
        candidates: [{
          connector: 'github',
          acquisitionMode: 'official_api',
          sourceUrl: data.html_url,
          sourceRecordId: String(data.id),
          payload,
          observedAt: new Date(),
        }],
      }
    } catch (error) {
      if (error instanceof SafeFetchError) {
        if (error.status === 404) return { kind: 'no_data' }
        if (error.code === 'rate_limited') {
          return { kind: 'retry', code: 'rate_limited', retryAt: new Date(Date.now() + (error.retryAfterSeconds ?? 60) * 1000) }
        }
        if (error.code === 'timeout' || error.code === 'upstream_error') {
          return { kind: 'retry', code: 'upstream_unavailable', retryAt: new Date(Date.now() + 60_000) }
        }
        if (error.code === 'auth_required') return { kind: 'stop', code: 'auth_required' }
        return { kind: 'stop', code: 'policy_denied' }
      }
      if (error instanceof SyntaxError) return { kind: 'no_data' }
      throw error
    }
  },
}
