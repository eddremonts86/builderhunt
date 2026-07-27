import { afterEach, describe, expect, it, vi } from 'vitest'
import { getProfileProofAdapter, isProfileProofSupported } from '~/lib/sources/profile-proof'

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

describe('profile-proof registry', () => {
  it('supports github, gitlab, codeberg, devto and nothing else', () => {
    expect(isProfileProofSupported('github')).toBe(true)
    expect(isProfileProofSupported('gitlab')).toBe(true)
    expect(isProfileProofSupported('codeberg')).toBe(true)
    expect(isProfileProofSupported('devto')).toBe(true)
    for (const unsupported of ['hn', 'reddit', 'npm', 'huggingface', 'stackoverflow', 'lobsters', 'sourcehut', 'producthunt', 'bluesky']) {
      expect(isProfileProofSupported(unsupported)).toBe(false)
      expect(getProfileProofAdapter(unsupported)).toBeNull()
    }
  })
})

describe('profile-proof adapters', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('github: succeeds when the challenge is present in bio, returning the numeric id as sourceId', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ id: 583231, bio: 'hi, my code is bh-remove-abc123' })))
    const result = await getProfileProofAdapter('github')!.verifyChallenge('octocat', 'bh-remove-abc123')
    expect(result).toEqual({ ok: true, sourceId: '583231' })
  })

  it('github: reports challenge_missing when bio does not contain it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ id: 583231, bio: 'just a normal bio' })))
    const result = await getProfileProofAdapter('github')!.verifyChallenge('octocat', 'bh-remove-abc123')
    expect(result).toEqual({ ok: false, reason: 'challenge_missing' })
  })

  it('github: reports not_found on a 404', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 404)))
    const result = await getProfileProofAdapter('github')!.verifyChallenge('ghost', 'bh-remove-abc123')
    expect(result).toEqual({ ok: false, reason: 'not_found' })
  })

  it('github: reports rate_limited on a 403', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 403)))
    const result = await getProfileProofAdapter('github')!.verifyChallenge('octocat', 'bh-remove-abc123')
    expect(result).toEqual({ ok: false, reason: 'rate_limited' })
  })

  it('github: reports timeout when the request is aborted', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        const err = new Error('aborted')
        err.name = 'AbortError'
        reject(err)
      })
    })))
    const result = await getProfileProofAdapter('github')!.verifyChallenge('octocat', 'bh-remove-abc123')
    expect(result).toEqual({ ok: false, reason: 'timeout' })
  }, 10000)

  it('github: treats a redirect response as not_found rather than following it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { Location: 'https://evil.example/internal' } })))
    const result = await getProfileProofAdapter('github')!.verifyChallenge('octocat', 'bh-remove-abc123')
    expect(result).toEqual({ ok: false, reason: 'not_found' })
  })

  it('github: treats an oversized response as not_found rather than buffering it fully', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ bio: 'x' }, 200, { 'Content-Length': String(1_000_000) })))
    const result = await getProfileProofAdapter('github')!.verifyChallenge('octocat', 'bh-remove-abc123')
    expect(result).toEqual({ ok: false, reason: 'not_found' })
  })

  it('gitlab: succeeds when the matching username has the challenge in bio, returning the username as sourceId', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([
      { username: 'someoneelse', bio: 'bh-remove-abc123' },
      { username: 'target', bio: 'my bio bh-remove-abc123 nice' },
    ])))
    const result = await getProfileProofAdapter('gitlab')!.verifyChallenge('target', 'bh-remove-abc123')
    expect(result).toEqual({ ok: true, sourceId: 'target' })
  })

  it('gitlab: reports not_found when no exact username match exists', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([{ username: 'someoneelse', bio: 'bh-remove-abc123' }])))
    const result = await getProfileProofAdapter('gitlab')!.verifyChallenge('target', 'bh-remove-abc123')
    expect(result).toEqual({ ok: false, reason: 'not_found' })
  })

  it('codeberg: reads the description field, returning the numeric id as sourceId', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ id: 42, description: 'bh-remove-xyz' })))
    const result = await getProfileProofAdapter('codeberg')!.verifyChallenge('user', 'bh-remove-xyz')
    expect(result).toEqual({ ok: true, sourceId: '42' })
  })

  it('devto: reads the summary field, returning the username as sourceId', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ username: 'user', summary: 'bh-remove-xyz' })))
    const result = await getProfileProofAdapter('devto')!.verifyChallenge('user', 'bh-remove-xyz')
    expect(result).toEqual({ ok: true, sourceId: 'user' })
  })

  it('devto: reports not_found on a 404', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 404)))
    const result = await getProfileProofAdapter('devto')!.verifyChallenge('ghost', 'bh-remove-xyz')
    expect(result).toEqual({ ok: false, reason: 'not_found' })
  })
})

