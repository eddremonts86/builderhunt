/**
 * Public Profile Enrichment — central safe network client.
 * Spec reference: plans/implemented/42-stealth-scraping/spec.md §8, §14.
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
   * Extra content types this one call accepts, on top of `ALLOWED_CONTENT_TYPES`.
   *
   * Opt-in per call rather than added to the global list, because widening the global list widens what
   * *every* connector may receive to solve one caller's problem. The Jobindex feed adapter is the first
   * caller: it needs `application/rss+xml`, and no other connector should start accepting XML because
   * of that.
   */
  additionalContentTypes?: readonly string[]
  /**
   * Character set to decode the body with when the response does not declare one in its `Content-Type`
   * header.
   *
   * The default is UTF-8, which is right for the JSON APIs and modern HTML every existing connector
   * reads. It is wrong for a legacy feed that declares its encoding only in an XML prolog: decoding
   * ISO-8859-1 bytes as UTF-8 turns Danish "København" into replacement characters, and those
   * characters then become a permanent part of a slug or a display name. A declared header charset
   * always wins over this — the caller is stating a fallback, not overriding the server.
   */
  fallbackCharset?: string
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

    const contentTypeHeader = response.headers.get('content-type') ?? ''
    const contentType = contentTypeHeader.split(';')[0].trim().toLowerCase()
    if (!ALLOWED_CONTENT_TYPES.includes(contentType) && !(options.additionalContentTypes ?? []).includes(contentType)) {
      throw new SafeFetchError('unsupported_content_type', `Unsupported content type: ${contentType}`)
    }

    const body = await readBoundedBody(response, charsetFrom(contentTypeHeader) ?? options.fallbackCharset)
    return { status: response.status, contentType, body, finalUrl: validated.toString() }
  }
  throw new SafeFetchError('too_many_redirects', 'Exceeded redirect limit')
}

/** The `charset` parameter of a Content-Type header, if it declared one. */
function charsetFrom(header: string): string | undefined {
  const value = /;\s*charset\s*=\s*"?([\w-]{1,40})"?/i.exec(header)?.[1]
  return value ? value.toLowerCase() : undefined
}

async function readBoundedBody(response: Response, charset?: string): Promise<string> {
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new SafeFetchError('too_large', 'Response exceeds the size limit')
  }
  // `response.text()` always decodes UTF-8 regardless of charset, so it is only correct on the path
  // where no charset was requested.
  if (!response.body) return charset ? decodeBody(Buffer.from(await response.arrayBuffer()), charset) : response.text()

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
  return decodeBody(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))), charset)
}

/**
 * Decodes bytes with the requested charset, falling back to UTF-8.
 *
 * The label reaching `TextDecoder` can come from a remote header, so an unknown or hostile label must
 * not throw and take down a request that otherwise succeeded — hence the try/catch rather than a trust
 * in the input. `fatal` stays off: a few undecodable bytes should cost those characters, not the whole
 * body.
 */
function decodeBody(buffer: Buffer, charset?: string): string {
  if (!charset || charset === 'utf-8' || charset === 'utf8') return buffer.toString('utf8')
  try {
    return new TextDecoder(charset).decode(buffer)
  } catch {
    return buffer.toString('utf8')
  }
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