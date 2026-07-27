import { afterEach, describe, expect, it, vi } from 'vitest'
import { getClaimSourceAdapter, isClaimSourceSupported } from '~/shared/lib/claim-sources/index'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('claim source registry', () => {
  it('supports github, gitlab, codeberg, devto and nothing else', () => {
    expect(isClaimSourceSupported('github')).toBe(true)
    expect(isClaimSourceSupported('gitlab')).toBe(true)
    expect(isClaimSourceSupported('codeberg')).toBe(true)
    expect(isClaimSourceSupported('devto')).toBe(true)
    for (const unsupported of ['hn', 'reddit', 'npm', 'huggingface', 'stackoverflow', 'lobsters', 'sourcehut', 'producthunt', 'bluesky']) {
      expect(isClaimSourceSupported(unsupported)).toBe(false)
      expect(getClaimSourceAdapter(unsupported)).toBeNull()
    }
  })
})

describe('claim-source adapters', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('github: succeeds when the challenge is present in bio', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ bio: 'hi, my code is bh-verify-abc123' })))
    const result = await getClaimSourceAdapter('github')!.verifyChallenge('octocat', 'bh-verify-abc123')
    expect(result).toEqual({ ok: true })
  })

  it('github: reports challenge_missing when bio does not contain it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ bio: 'just a normal bio' })))
    const result = await getClaimSourceAdapter('github')!.verifyChallenge('octocat', 'bh-verify-abc123')
    expect(result).toEqual({ ok: false, reason: 'challenge_missing' })
  })

  it('github: reports not_found on a 404', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 404)))
    const result = await getClaimSourceAdapter('github')!.verifyChallenge('ghost', 'bh-verify-abc123')
    expect(result).toEqual({ ok: false, reason: 'not_found' })
  })

  it('github: reports rate_limited on a 403', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 403)))
    const result = await getClaimSourceAdapter('github')!.verifyChallenge('octocat', 'bh-verify-abc123')
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
    const result = await getClaimSourceAdapter('github')!.verifyChallenge('octocat', 'bh-verify-abc123')
    expect(result).toEqual({ ok: false, reason: 'timeout' })
  }, 10000)

  it('gitlab: succeeds when the matching username has the challenge in bio', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([
      { username: 'someoneelse', bio: 'bh-verify-abc123' },
      { username: 'target', bio: 'my bio bh-verify-abc123 nice' },
    ])))
    const result = await getClaimSourceAdapter('gitlab')!.verifyChallenge('target', 'bh-verify-abc123')
    expect(result).toEqual({ ok: true })
  })

  it('gitlab: reports not_found when no exact username match exists', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([{ username: 'someoneelse', bio: 'bh-verify-abc123' }])))
    const result = await getClaimSourceAdapter('gitlab')!.verifyChallenge('target', 'bh-verify-abc123')
    expect(result).toEqual({ ok: false, reason: 'not_found' })
  })

  it('codeberg: reads the description field', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ description: 'bh-verify-xyz' })))
    const result = await getClaimSourceAdapter('codeberg')!.verifyChallenge('user', 'bh-verify-xyz')
    expect(result).toEqual({ ok: true })
  })

  it('devto: reads the summary field', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ summary: 'bh-verify-xyz' })))
    const result = await getClaimSourceAdapter('devto')!.verifyChallenge('user', 'bh-verify-xyz')
    expect(result).toEqual({ ok: true })
  })

  it('devto: reports not_found on a 404', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 404)))
    const result = await getClaimSourceAdapter('devto')!.verifyChallenge('ghost', 'bh-verify-xyz')
    expect(result).toEqual({ ok: false, reason: 'not_found' })
  })
})
