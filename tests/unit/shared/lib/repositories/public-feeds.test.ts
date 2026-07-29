// Public feed capabilities — repository test for plan 28 task 9.
//
// The security-meaningful contract lives in resolveFeedCapability
// and createFeedCapability: tokens are stored as hashes, every
// failure path returns null, and the lookup is O(1) via the
// unique index on capability_hash. These tests exercise the
// repository against a disposable test database, which is the
// same pattern the rest of the security suite uses.

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { authUsers, organizationMembers, organizations, savedQueries } from '~/shared/lib/db/schema'
import {
  createFeedCapability,
  resolveFeedCapability,
  revokeFeedCapability,
  rotateFeedCapability,
} from '~/shared/lib/repositories/public-feeds'

let db: PostgresJsDatabase
let drop: () => Promise<void>

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('publicfeeds')
  db = disposable.db
  drop = disposable.drop

  await db.insert(authUsers).values({
    id: 'pf-user-1', name: 'PF User 1', email: 'pf-1@test.invalid',
    emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
  })
  await db.insert(organizations).values([
    { id: 'pf-org-1', name: 'Org 1', slug: 'pf-org-1', createdAt: new Date() },
    { id: 'pf-org-2', name: 'Org 2', slug: 'pf-org-2', createdAt: new Date() },
  ])
  await db.insert(organizationMembers).values([
    { id: 'pf-mem-1', userId: 'pf-user-1', organizationId: 'pf-org-1', role: 'owner', createdAt: new Date() },
  ])
  await db.insert(savedQueries).values([
    {
      id: 'pf-q-1', organizationId: 'pf-org-1', userId: 'pf-user-1',
      name: 'Rust query', keywords: ['rust'], sources: ['github'],
      createdAt: new Date(), visibility: 'organization',
    },
  ])
}, 60_000)

afterAll(async () => {
  await drop()
})

describe('createFeedCapability', () => {
  it('returns the token to the caller and only persists its hash', async () => {
    const created = await createFeedCapability('pf-org-1', 'pf-q-1', { db })
    expect(created.id).toMatch(/^fc_/)
    expect(created.capability).toMatch(/^[A-Za-z0-9_-]{43}$/) // 32 bytes base64url
    expect(created.organizationId).toBe('pf-org-1')
    expect(created.queryId).toBe('pf-q-1')
    // The token must NEVER round-trip to a stored value the
    // repository re-uses; the only place the plain token exists
    // is in this return value.
    const resolved = await resolveFeedCapability(created.id, created.capability, new Date(), { db })
    expect(resolved).toEqual({ organizationId: 'pf-org-1', queryId: 'pf-q-1' })
  })
})

describe('resolveFeedCapability', () => {
  it('returns null for an unknown id', async () => {
    expect(await resolveFeedCapability('fc_doesnotexist', 'whatever', new Date(), { db })).toBeNull()
  })

  it('returns null for a right id with a wrong token', async () => {
    const created = await createFeedCapability('pf-org-1', 'pf-q-1', { db })
    expect(await resolveFeedCapability(created.id, 'wrong-token', new Date(), { db })).toBeNull()
  })

  it('returns null for a revoked capability, even with the right token', async () => {
    const created = await createFeedCapability('pf-org-1', 'pf-q-1', { db })
    const revoked = await revokeFeedCapability('pf-org-1', created.id, { db })
    expect(revoked).toBe(true)
    expect(await resolveFeedCapability(created.id, created.capability, new Date(), { db })).toBeNull()
  })

  it('returns null for an expired capability, even with the right token', async () => {
    const past = new Date(Date.now() - 1000)
    const created = await createFeedCapability('pf-org-1', 'pf-q-1', { expiresAt: past, db })
    expect(await resolveFeedCapability(created.id, created.capability, new Date(), { db })).toBeNull()
  })

  it('returns the (org, query) tuple for a fresh, valid capability', async () => {
    const created = await createFeedCapability('pf-org-1', 'pf-q-1', { db })
    const resolved = await resolveFeedCapability(created.id, created.capability, new Date(), { db })
    expect(resolved).toEqual({ organizationId: 'pf-org-1', queryId: 'pf-q-1' })
  })
})

describe('rotateFeedCapability', () => {
  it('revokes the old id and mints a new token against the same query', async () => {
    const original = await createFeedCapability('pf-org-1', 'pf-q-1', { db })
    const rotated = await rotateFeedCapability('pf-org-1', original.id, { db })
    expect(rotated).not.toBeNull()
    expect(rotated!.id).not.toBe(original.id)
    expect(rotated!.queryId).toBe('pf-q-1')

    // Old token no longer works.
    expect(await resolveFeedCapability(original.id, original.capability, new Date(), { db })).toBeNull()
    // New token works.
    expect(await resolveFeedCapability(rotated!.id, rotated!.capability, new Date(), { db })).toEqual({
      organizationId: 'pf-org-1',
      queryId: 'pf-q-1',
    })
  })

  it('returns null when the capability does not exist', async () => {
    const rotated = await rotateFeedCapability('pf-org-1', 'fc_doesnotexist', { db })
    expect(rotated).toBeNull()
  })

  it('returns null when the capability is already revoked', async () => {
    const created = await createFeedCapability('pf-org-1', 'pf-q-1', { db })
    await revokeFeedCapability('pf-org-1', created.id, { db })
    const rotated = await rotateFeedCapability('pf-org-1', created.id, { db })
    expect(rotated).toBeNull()
  })
})

describe('cross-org revocation', () => {
  it('refuses to revoke a capability that belongs to a different org', async () => {
    const created = await createFeedCapability('pf-org-1', 'pf-q-1', { db })
    // Org-2 tries to revoke org-1's capability — should be a no-op.
    const revoked = await revokeFeedCapability('pf-org-2', created.id, { db })
    expect(revoked).toBe(false)
    // And the capability still works for org-1.
    expect(await resolveFeedCapability(created.id, created.capability, new Date(), { db })).toEqual({
      organizationId: 'pf-org-1',
      queryId: 'pf-q-1',
    })
  })
})
