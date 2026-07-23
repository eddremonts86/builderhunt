import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '../db/create-disposable-test-database'
import { authUsers, billingContacts, organizations } from '../db/schema'
import type { TenantPrincipal } from '../authorization/permissions'
import { BillingAuthorizationError } from './permissions'
import { getVerifiedBillingContact, hashBillingContactSecret, setBillingContact, verifyBillingContact } from './billing-contact'

let db: PostgresJsDatabase
let drop: () => Promise<void>
let counter = 0
function uniqueId(label: string): string {
  counter += 1
  return `contact-${label}-${counter}`
}

async function freshOrg(): Promise<string> {
  const orgId = uniqueId('org')
  await db.insert(organizations).values({ id: orgId, name: orgId, slug: orgId, createdAt: new Date() })
  return orgId
}

const OWNER_USER_ID = 'owner-1'
const RECENT_SESSION = { authenticatedAt: new Date() }
const STALE_SESSION = { authenticatedAt: new Date(Date.now() - 20 * 60 * 1000) }

function principal(organizationId: string, role: TenantPrincipal['role'] = 'owner', userId = OWNER_USER_ID): TenantPrincipal {
  return { userId, organizationId, role, requestId: uniqueId('req') }
}

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('billing_contact')
  db = disposable.db
  drop = disposable.drop
  await db.insert(authUsers).values({
    id: OWNER_USER_ID, name: 'Owner', email: 'owner@test.invalid',
    emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
  })
}, 60_000)

afterAll(async () => {
  await drop()
})

describe('setBillingContact', () => {
  it('creates a pending contact for an owner with a recent session', async () => {
    const organizationId = await freshOrg()
    await db.transaction((tx) => setBillingContact(tx, principal(organizationId), RECENT_SESSION, {
      email: 'billing@example.com', verificationToken: 'token-1',
    }))

    const rows = await db.select().from(billingContacts)
    const contact = rows.find((r) => r.organizationId === organizationId)
    expect(contact?.status).toBe('pending')
    expect(contact?.email).toBe('billing@example.com')
    expect(contact?.verificationSecretHash).toBe(hashBillingContactSecret('token-1'))
  })

  it('rejects an admin', async () => {
    const organizationId = await freshOrg()
    await expect(db.transaction((tx) => setBillingContact(tx, principal(organizationId, 'admin'), RECENT_SESSION, {
      email: 'billing@example.com', verificationToken: 'token-2',
    }))).rejects.toBeInstanceOf(BillingAuthorizationError)
  })

  it('rejects a member', async () => {
    const organizationId = await freshOrg()
    await expect(db.transaction((tx) => setBillingContact(tx, principal(organizationId, 'member'), RECENT_SESSION, {
      email: 'billing@example.com', verificationToken: 'token-3',
    }))).rejects.toBeInstanceOf(BillingAuthorizationError)
  })

  it('rejects an owner with a stale session', async () => {
    const organizationId = await freshOrg()
    await expect(db.transaction((tx) => setBillingContact(tx, principal(organizationId), STALE_SESSION, {
      email: 'billing@example.com', verificationToken: 'token-4',
    }))).rejects.toMatchObject({ status: 401 })
  })

  it('rejects an owner with no session at all', async () => {
    const organizationId = await freshOrg()
    await expect(db.transaction((tx) => setBillingContact(tx, principal(organizationId), undefined, {
      email: 'billing@example.com', verificationToken: 'token-5',
    }))).rejects.toMatchObject({ status: 401 })
  })

  it('overwrites a previously verified contact with a new pending one', async () => {
    const organizationId = await freshOrg()
    await db.transaction((tx) => setBillingContact(tx, principal(organizationId), RECENT_SESSION, {
      email: 'first@example.com', verificationToken: 'token-6',
    }))
    await db.transaction((tx) => verifyBillingContact(tx, principal(organizationId), 'token-6'))

    await db.transaction((tx) => setBillingContact(tx, principal(organizationId), RECENT_SESSION, {
      email: 'second@example.com', verificationToken: 'token-7',
    }))

    const contact = await db.transaction((tx) => getVerifiedBillingContact(tx, organizationId))
    // The new contact is pending, not verified yet — the OLD verified email must no longer be surfaced.
    expect(contact).toBeNull()
  })
})

describe('verifyBillingContact', () => {
  it('verifies with the correct token', async () => {
    const organizationId = await freshOrg()
    await db.transaction((tx) => setBillingContact(tx, principal(organizationId), RECENT_SESSION, {
      email: 'billing@example.com', verificationToken: 'token-a',
    }))

    const result = await db.transaction((tx) => verifyBillingContact(tx, principal(organizationId), 'token-a'))

    expect(result).toEqual({ email: 'billing@example.com', verifiedAt: expect.any(String) })
  })

  it('returns null for the wrong token', async () => {
    const organizationId = await freshOrg()
    await db.transaction((tx) => setBillingContact(tx, principal(organizationId), RECENT_SESSION, {
      email: 'billing@example.com', verificationToken: 'token-b',
    }))

    const result = await db.transaction((tx) => verifyBillingContact(tx, principal(organizationId), 'wrong-token'))

    expect(result).toBeNull()
  })

  it('returns null for a token belonging to a different organization (no cross-org replay)', async () => {
    const organizationA = await freshOrg()
    const organizationB = await freshOrg()
    await db.transaction((tx) => setBillingContact(tx, principal(organizationA), RECENT_SESSION, {
      email: 'billing@example.com', verificationToken: 'token-c',
    }))

    const result = await db.transaction((tx) => verifyBillingContact(tx, principal(organizationB), 'token-c'))

    expect(result).toBeNull()
    const contactA = await db.transaction((tx) => getVerifiedBillingContact(tx, organizationA))
    expect(contactA).toBeNull()
  })

  it('returns null for an expired token', async () => {
    const organizationId = await freshOrg()
    await db.transaction((tx) => setBillingContact(tx, principal(organizationId), RECENT_SESSION, {
      email: 'billing@example.com', verificationToken: 'token-d',
    }))
    const farFuture = new Date(Date.now() + 25 * 60 * 60 * 1000)

    const result = await db.transaction((tx) => verifyBillingContact(tx, principal(organizationId), 'token-d', farFuture))

    expect(result).toBeNull()
  })

  it('does not allow replaying an already-verified token', async () => {
    const organizationId = await freshOrg()
    await db.transaction((tx) => setBillingContact(tx, principal(organizationId), RECENT_SESSION, {
      email: 'billing@example.com', verificationToken: 'token-e',
    }))
    await db.transaction((tx) => verifyBillingContact(tx, principal(organizationId), 'token-e'))

    const second = await db.transaction((tx) => verifyBillingContact(tx, principal(organizationId), 'token-e'))

    expect(second).toBeNull()
  })

  it('returns null when nothing was ever set for this organization', async () => {
    const organizationId = await freshOrg()
    const result = await db.transaction((tx) => verifyBillingContact(tx, principal(organizationId), 'no-such-token'))
    expect(result).toBeNull()
  })
})

describe('getVerifiedBillingContact', () => {
  it('returns null while a contact is still pending', async () => {
    const organizationId = await freshOrg()
    await db.transaction((tx) => setBillingContact(tx, principal(organizationId), RECENT_SESSION, {
      email: 'billing@example.com', verificationToken: 'token-f',
    }))

    expect(await db.transaction((tx) => getVerifiedBillingContact(tx, organizationId))).toBeNull()
  })

  it('never leaks another organization\'s verified contact', async () => {
    const organizationA = await freshOrg()
    const organizationB = await freshOrg()
    await db.transaction((tx) => setBillingContact(tx, principal(organizationA), RECENT_SESSION, {
      email: 'billing@example.com', verificationToken: 'token-g',
    }))
    await db.transaction((tx) => verifyBillingContact(tx, principal(organizationA), 'token-g'))

    expect(await db.transaction((tx) => getVerifiedBillingContact(tx, organizationB))).toBeNull()
  })
})
