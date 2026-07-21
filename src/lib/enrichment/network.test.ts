// @vitest-environment node
//
// This module is server-only and its safety envelope (redirect handling,
// AbortController timeouts, private-network checks) depends on Node's real
// fetch/DNS behavior. happy-dom's fetch shim enforces browser-style CORS and
// doesn't reproduce Node's abort/redirect semantics, which breaks every
// redirect/timeout assertion below under the project's default environment.
import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { safeFetch, SafeFetchError } from './network'

let server: Server
let baseUrl: string

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/ok') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ hello: 'world' }))
      return
    }
    if (url.pathname === '/wrong-mime') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end('binary-ish')
      return
    }
    if (url.pathname === '/too-large') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ blob: 'x'.repeat(3 * 1024 * 1024) }))
      return
    }
    if (url.pathname === '/rate-limited') {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '42' })
      res.end('{}')
      return
    }
    if (url.pathname === '/forbidden') {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    if (url.pathname === '/redirect-once') {
      res.writeHead(302, { location: '/ok' })
      res.end()
      return
    }
    if (url.pathname === '/redirect-loop') {
      res.writeHead(302, { location: '/redirect-loop' })
      res.end()
      return
    }
    if (url.pathname === '/redirect-external') {
      res.writeHead(302, { location: 'https://not-allowed.example/ok' })
      res.end()
      return
    }
    if (url.pathname === '/slow') {
      // Never responds within the client's timeout window.
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  baseUrl = `http://127.0.0.1:${port}`
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

const hosts = ['127.0.0.1']

function fetchTestUrl(path: string, allowedHosts: string[] = hosts) {
  return safeFetch(`${baseUrl}${path}`, {
    allowedHosts,
    insecureAllowHttpAndPrivateNetworkForTests: true,
  })
}

describe('safeFetch', () => {
  it('returns the body for a normal 200 JSON response', async () => {
    const result = await fetchTestUrl('/ok')
    expect(JSON.parse(result.body)).toEqual({ hello: 'world' })
  })

  it('rejects a disallowed host even with a valid path', async () => {
    await expect(fetchTestUrl('/ok', ['totally-different-host.example']))
      .rejects.toThrow(SafeFetchError)
  })

  it('rejects an unsupported content type', async () => {
    await expect(fetchTestUrl('/wrong-mime')).rejects.toMatchObject({ code: 'unsupported_content_type' })
  })

  it('rejects a response over the byte cap', async () => {
    await expect(fetchTestUrl('/too-large')).rejects.toMatchObject({ code: 'too_large' })
  })

  it('maps 429 to rate_limited with the Retry-After value', async () => {
    await expect(fetchTestUrl('/rate-limited')).rejects.toMatchObject({
      code: 'rate_limited',
      retryAfterSeconds: 42,
    })
  })

  it('maps 403 to auth_required', async () => {
    await expect(fetchTestUrl('/forbidden')).rejects.toMatchObject({ code: 'auth_required' })
  })

  it('follows a single same-host redirect', async () => {
    const result = await fetchTestUrl('/redirect-once')
    expect(JSON.parse(result.body)).toEqual({ hello: 'world' })
  })

  it('stops a redirect loop after the max redirect count', async () => {
    await expect(fetchTestUrl('/redirect-loop')).rejects.toMatchObject({ code: 'too_many_redirects' })
  })

  it('denies a redirect to a host outside the allowlist', async () => {
    await expect(fetchTestUrl('/redirect-external')).rejects.toMatchObject({ code: 'host_not_allowed' })
  })

  it('times out a request that never responds', async () => {
    await expect(fetchTestUrl('/slow')).rejects.toMatchObject({ code: 'timeout' })
  }, 15_000)
})
