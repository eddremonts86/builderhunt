import { randomUUID } from 'node:crypto'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { authUsers, builders, organizations, profileRemovalRequests, profileSuppressions } from '~/shared/lib/db/schema'
import { normalizeProfileUrl, requestProfileRemoval, verifyProfileRemoval } from '~/shared/lib/profile-removal'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('normalizeProfileUrl', () => {
  it('accepts a bare github profile URL', () => {
    expect(normalizeProfileUrl('https://github.com/octocat')).toEqual({
      source: 'github',
      username: 'octocat',
      normalizedUrl: 'https://github.com/octocat',
    })
  })

  it('accepts gitlab, codeberg, and devto profile URLs', () => {
    expect(normalizeProfileUrl('https://gitlab.com/someone')?.source).toBe('gitlab')
    expect(normalizeProfileUrl('https://codeberg.org/someone')?.source).toBe('codeberg')
    expect(normalizeProfileUrl('https://dev.to/someone')?.source).toBe('devto')
  })

  it('normalizes a www.-prefixed host to the canonical bare host', () => {
    expect(normalizeProfileUrl('https://www.github.com/octocat')?.normalizedUrl).toBe('https://github.com/octocat')
  })

  it('rejects an unsupported host', () => {
    expect(normalizeProfileUrl('https://example.com/someone')).toBeNull()
  })

  it('rejects a repo path (more than one path segment)', () => {
    expect(normalizeProfileUrl('https://github.com/octocat/hello-world')).toBeNull()
  })

  it('rejects http (non-https)', () => {
    expect(normalizeProfileUrl('http://github.com/octocat')).toBeNull()
  })

  it('rejects a malformed URL', () => {
    expect(normalizeProfileUrl('not a url')).toBeNull()
  })

  it('rejects a username with disallowed characters', () => {
    expect(normalizeProfileUrl('https://github.com/oct%20cat')).toBeNull()
  })
})

const TEST_HMAC_KEYS = ['test-hmac-key-for-profile-removal-0123456789abcdef']

describe('profile-removal request/verify flow (disposable DB)', () => {
  let db: PostgresJsDatabase
  let drop: () => Promise<void>
  let organizationId: string

  beforeAll(async () => {
    const disposable = await createDisposableTestDatabase('profile_removal')
    db = disposable.db
    drop = disposable.drop

    organizationId = randomUUID()
    await db.insert(organizations).values({ id: organizationId, name: 'Test Org', slug: `test-org-${organizationId.slice(0, 8)}` })
  }, 30000)

  afterAll(async () => {
    await drop()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('issues a challenge for a valid, supported profile URL', async () => {
    const result = await requestProfileRemoval({ profileUrl: 'https://github.com/some-remove-user-1', db, hmacKeys: TEST_HMAC_KEYS })
    expect(result.kind).toBe('issued')
    if (result.kind !== 'issued') throw new Error('expected issued')
    expect(result.source).toBe('github')
    expect(result.challenge).toMatch(/^bh-privacy-/)
    expect(result.instructions).toContain(result.challenge)
  })

  it('returns invalid_url for an unsupported host', async () => {
    const result = await requestProfileRemoval({ profileUrl: 'https://example.com/someone', db, hmacKeys: TEST_HMAC_KEYS })
    expect(result).toEqual({ kind: 'invalid_url' })
  })

  it('supersedes an existing pending request rather than erroring on retry', async () => {
    const first = await requestProfileRemoval({ profileUrl: 'https://github.com/some-remove-user-2', db, hmacKeys: TEST_HMAC_KEYS })
    if (first.kind !== 'issued') throw new Error('expected issued')
    const second = await requestProfileRemoval({ profileUrl: 'https://github.com/some-remove-user-2', db, hmacKeys: TEST_HMAC_KEYS })
    if (second.kind !== 'issued') throw new Error('expected issued')
    expect(second.requestId).not.toBe(first.requestId)

    const rows = await db.select().from(profileRemovalRequests)
    const firstRecord = rows.find((r) => r.id === first.requestId)
    expect(firstRecord?.status).toBe('rejected')
  })

  it('verifies a request end-to-end: challenge in bio -> suppression inserted -> matching builders row deleted', async () => {
    const username = `some-remove-user-verify-${randomUUID().slice(0, 8)}`
    const issued = await requestProfileRemoval({ profileUrl: `https://github.com/${username}`, db, hmacKeys: TEST_HMAC_KEYS })
    if (issued.kind !== 'issued') throw new Error('expected issued')

    const userId = randomUUID()
    await db.insert(authUsers).values({ id: userId, name: 'Test User', email: `${userId}@example.com` })
    await db.insert(builders).values({
      id: randomUUID(),
      organizationId,
      userId,
      source: 'github',
      sourceId: '999999',
      username,
      profileUrl: `https://github.com/${username}`,
    })

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ id: 999999, bio: `hi ${issued.challenge} bye` })))

    const verified = await verifyProfileRemoval({ requestId: issued.requestId, challenge: issued.challenge, db, workerDb: db, hmacKeys: TEST_HMAC_KEYS })
    expect(verified).toEqual({ kind: 'verified', source: 'github', sourceId: '999999', buildersDeleted: 1 })

    const suppressions = await db.select().from(profileSuppressions)
    expect(suppressions.some((s) => s.source === 'github' && s.sourceId === '999999' && s.revokedAt === null)).toBe(true)

    const remainingBuilders = await db.select().from(builders)
    expect(remainingBuilders.some((b) => b.source === 'github' && b.sourceId === '999999')).toBe(false)
  })

  it('rejects verification with the wrong challenge', async () => {
    const issued = await requestProfileRemoval({ profileUrl: 'https://github.com/some-remove-user-3', db, hmacKeys: TEST_HMAC_KEYS })
    if (issued.kind !== 'issued') throw new Error('expected issued')
    const result = await verifyProfileRemoval({ requestId: issued.requestId, challenge: 'bh-privacy-wrong', db, workerDb: db, hmacKeys: TEST_HMAC_KEYS })
    expect(result).toEqual({ kind: 'invalid_challenge' })
  })

  it('reports proof_failed when the challenge is not present in the bio', async () => {
    const issued = await requestProfileRemoval({ profileUrl: 'https://github.com/some-remove-user-4', db, hmacKeys: TEST_HMAC_KEYS })
    if (issued.kind !== 'issued') throw new Error('expected issued')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ id: 1, bio: 'no challenge here' })))
    const result = await verifyProfileRemoval({ requestId: issued.requestId, challenge: issued.challenge, db, workerDb: db, hmacKeys: TEST_HMAC_KEYS })
    expect(result).toEqual({ kind: 'proof_failed', reason: 'challenge_missing' })
  })

  it('returns not_found for an unknown requestId', async () => {
    const result = await verifyProfileRemoval({ requestId: randomUUID(), challenge: 'bh-privacy-anything', db, workerDb: db, hmacKeys: TEST_HMAC_KEYS })
    expect(result).toEqual({ kind: 'not_found' })
  })
})
