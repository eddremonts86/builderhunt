/**
 * Public Profile Enrichment — central safe network client.
 * Spec reference: plans/phase-1/42-stealth-scraping/spec.md §8, §14.
 *
 * No connector may call `fetch` directly (enforced by a static test in
 * registry.test.ts) — every outbound request goes through this module, which
 * layers connector-specific limits on top of the platform's existing SSRF
 * guard (`validateExternalHttpUrl`, src/shared/lib/security/url-policy.ts).
 */

import { validateExternalHttpUrl } from '~/shared/lib/security/url-policy'

export const ENRICHMENT_DEFAULT_USER_AGENT = 'BuilderHuntBot/1.0 (+https://builderhunt.dev/crawler)'
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_REDIRECTS = 3
const REQUEST_TIMEOUT_MS = 10_000
const ALLOWED_CONTENT_TYPES = ['application/json', 'text/html', 'text/plain']

export type SafeFetchErrorCode =
  | 'invalid_url'
  | 'host_not_allowed'
  | 'private_network'
  | 'timeout'
  | 'too_large'
  | 'unsupported_content_type'
  | 'too_many_redirects'
  | 'redirect_denied'
  | 'auth_required'
  | 'rate_limited'
  | 'upstream_error'

export class SafeFetchError extends Error {
  constructor(public code: SafeFetchErrorCode, message: string, public status?: number, public retryAfterSeconds?: number) {
    super(message)
    this.name = 'SafeFetchError'
  }
}

export interface SafeFetchOptions {
  allowedHosts: readonly string[]
  headers?: Record<string, string>
  signal?: AbortSignal
  userAgent?: string
  /**
   * Test-only escape hatch: skips the production SSRF guard (which
   * unconditionally blocks loopback/private addresses and non-HTTPS) so
   * network.test.ts can exercise redirect/timeout/size/content-type
   * handling against a real local fixture server. No connector ever sets
   * this — only network.test.ts does, verified by
   * registry.test.ts's "never calls fetch directly" / connector-source
   * scan not matching this option name.
   */
  insecureAllowHttpAndPrivateNetworkForTests?: boolean
}

export interface SafeFetchResult {
  status: number
  contentType: string
  body: string
  finalUrl: string
}

/**
 * Fetches one URL with the full enrichment safety envelope: HTTPS-only,
 * exact-host allowlist, no embedded credentials, public-IP-only DNS
 * resolution, redirect revalidation (max 3 hops), timeout, byte cap, and a
 * content-type allowlist. Never retries — the worker owns retry policy.
 */
export async function safeFetch(url: string, options: SafeFetchOptions): Promise<SafeFetchResult> {
  let currentUrl = url
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    let validated: URL
    if (options.insecureAllowHttpAndPrivateNetworkForTests) {
      validated = validateForTestsOnly(currentUrl, options.allowedHosts)
    } else {
      try {
        validated = await validateExternalHttpUrl(currentUrl, { allowedHosts: [...options.allowedHosts] })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid external URL'
        if (/private network/i.test(message)) throw new SafeFetchError('private_network', message)
        if (/not allowlisted/i.test(message)) throw new SafeFetchError('host_not_allowed', message)
        throw new SafeFetchError('invalid_url', message)
      }
      if (validated.protocol !== 'https:') throw new SafeFetchError('host_not_allowed', 'Only HTTPS is permitted')
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    const onAbort = () => controller.abort()
    options.signal?.addEventListener('abort', onAbort)

    let response: Response
    try {
      response = await fetch(validated.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': options.userAgent ?? ENRICHMENT_DEFAULT_USER_AGENT,
          Accept: 'application/json, text/html;q=0.8',
          ...options.headers,
        },
      })
    } catch (error) {
      if (controller.signal.aborted) throw new SafeFetchError('timeout', 'Request timed out')
      throw new SafeFetchError('upstream_error', error instanceof Error ? error.message : 'Fetch failed')
    } finally {
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', onAbort)
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) throw new SafeFetchError('redirect_denied', 'Redirect with no Location header')
      if (redirectCount === MAX_REDIRECTS) throw new SafeFetchError('too_many_redirects', 'Exceeded redirect limit')
      currentUrl = new URL(location, validated).toString()
      continue
    }

    if (response.status === 401 || response.status === 403) {
      throw new SafeFetchError('auth_required', 'Upstream requires authentication', response.status)
    }
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after'))
      throw new SafeFetchError('rate_limited', 'Rate limited by upstream', response.status, Number.isFinite(retryAfter) ? retryAfter : undefined)
    }
    if (!response.ok) {
      throw new SafeFetchError('upstream_error', `Upstream returned ${response.status}`, response.status)
    }

    const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
      throw new SafeFetchError('unsupported_content_type', `Unsupported content type: ${contentType}`)
    }

    const body = await readBoundedBody(response)
    return { status: response.status, contentType, body, finalUrl: validated.toString() }
  }
  throw new SafeFetchError('too_many_redirects', 'Exceeded redirect limit')
}

async function readBoundedBody(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new SafeFetchError('too_large', 'Response exceeds the size limit')
  }
  if (!response.body) return response.text()

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {})
      throw new SafeFetchError('too_large', 'Response exceeds the size limit')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')
}

/** Test-only: see `insecureAllowHttpAndPrivateNetworkForTests` on SafeFetchOptions. */
function validateForTestsOnly(input: string, allowedHosts: readonly string[]): URL {
  const url = new URL(input)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SafeFetchError('invalid_url', 'Invalid external URL')
  if (url.username || url.password) throw new SafeFetchError('invalid_url', 'External URL credentials are forbidden')
  const hostname = url.hostname.toLowerCase()
  if (!allowedHosts.some((allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`))) {
    throw new SafeFetchError('host_not_allowed', 'External URL host is not allowlisted')
  }
  return url
}