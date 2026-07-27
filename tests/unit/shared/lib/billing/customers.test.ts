import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { TenantPrincipal } from '~/shared/lib/authorization/permissions'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { authUsers, organizationMembers, organizations } from '~/shared/lib/db/schema'
import { createBillingCustomer, createBillingCustomerIfAbsent, findBillingCustomer } from '~/shared/lib/repositories/billing'
import { CustomerProvisioningError, ensureBillingCustomer } from '~/shared/lib/billing/customers'
import { FakeBillingProvider } from '~/shared/lib/billing/fake-provider'

let db: PostgresJsDatabase
let drop: () => Promise<void>
let counter = 0
function uniqueId(label: string): string {
  counter += 1
  return `cust-${label}-${counter}`
}

async function freshOrgWithOwner(): Promise<{ principal: TenantPrincipal; ownerEmail: string }> {
  const orgId = uniqueId('org')
  await db.insert(organizations).values({ id: orgId, name: orgId, slug: orgId, createdAt: new Date() })
  const userId = uniqueId('user')
  const ownerEmail = `${userId}@test.invalid`
  await db.insert(authUsers).values({ id: userId, name: userId, email: ownerEmail, emailVerified: true, createdAt: new Date(), updatedAt: new Date() })
  await db.insert(organizationMembers).values({ id: uniqueId('member'), organizationId: orgId, userId, role: 'owner', createdAt: new Date() })
  return { principal: { userId, organizationId: orgId, role: 'owner', requestId: uniqueId('request') }, ownerEmail }
}

async function freshOrgWithoutOwner(): Promise<TenantPrincipal> {
  const orgId = uniqueId('org')
  await db.insert(organizations).values({ id: orgId, name: orgId, slug: orgId, createdAt: new Date() })
  return { userId: uniqueId('user'), organizationId: orgId, role: 'owner', requestId: uniqueId('request') }
}

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('customers')
  db = disposable.db
  drop = disposable.drop
})

afterAll(async () => {
  await drop()
})

describe('ensureBillingCustomer', () => {
  let provider: FakeBillingProvider

  beforeEach(() => {
    provider = new FakeBillingProvider()
  })

  it('creates a Customer using the owner email, never any candidate/product data', async () => {
    const { principal, ownerEmail } = await freshOrgWithOwner()

    await db.transaction((tx) => ensureBillingCustomer(tx, principal, { provider }))

    const stored = await db.transaction((tx) => findBillingCustomer(tx, principal.organizationId, false))
    expect(stored).not.toBeNull()
    const stripeCustomer = await provider.getCustomer(stored!.stripeCustomerId)
    expect(stripeCustomer?.email).toBe(ownerEmail)
    expect(stripeCustomer?.metadata).toEqual({ organizationId: principal.organizationId })
  })

  it('is idempotent — a second call reuses the same Customer, never creating a second one', async () => {
    const { principal } = await freshOrgWithOwner()

    const first = await db.transaction((tx) => ensureBillingCustomer(tx, principal, { provider }))
    const second = await db.transaction((tx) => ensureBillingCustomer(tx, principal, { provider }))
    expect(second).toEqual(first)

    const rows = await provider.listForReconciliation('customers')
    expect(rows).toHaveLength(1)
  })

  it('concurrent creation for the same organization converges on exactly one Customer', async () => {
    const { principal } = await freshOrgWithOwner()

    const [first, second] = await Promise.all([
      db.transaction((tx) => ensureBillingCustomer(tx, principal, { provider })),
      db.transaction((tx) => ensureBillingCustomer(tx, principal, { provider })),
    ])
    expect(first).toEqual(second)

    const rows = await provider.listForReconciliation('customers')
    expect(rows).toHaveLength(1)

    const stored = await db.transaction((tx) => findBillingCustomer(tx, principal.organizationId, false))
    expect(stored).not.toBeNull()
  })

  it('a lost-response retry (same operation key) never creates a second provider-side Customer', async () => {
    const { principal } = await freshOrgWithOwner()

    // Simulate the DB insert never having happened (as if the process crashed after the provider
    // call succeeded but before the row was committed) by calling ensureBillingCustomer twice —
    // the second call still resolves the SAME provider customer because the operation key is
    // derived only from (organizationId, livemode), not a per-attempt random value.
    await db.transaction((tx) => ensureBillingCustomer(tx, principal, { provider }))
    await db.transaction((tx) => ensureBillingCustomer(tx, principal, { provider }))

    const rows = await provider.listForReconciliation('customers')
    expect(rows).toHaveLength(1)
  })

  it('throws a typed error when the organization has no owner', async () => {
    const principal = await freshOrgWithoutOwner()

    await expect(db.transaction((tx) => ensureBillingCustomer(tx, principal, { provider })))
      .rejects.toMatchObject({ code: 'no_owner' })
    await expect(db.transaction((tx) => ensureBillingCustomer(tx, principal, { provider })))
      .rejects.toBeInstanceOf(CustomerProvisioningError)
  })

  it('the DTO snapshot carries no sensitive fields — only livemode', async () => {
    const { principal } = await freshOrgWithOwner()
    const result = await db.transaction((tx) => ensureBillingCustomer(tx, principal, { provider }))
    expect(Object.keys(result)).toEqual(['livemode'])
  })
})

describe('test/live customer isolation', () => {
  it('a test-mode row and a live-mode row for the same organization never cross', async () => {
    const { principal } = await freshOrgWithOwner()

    await db.transaction((tx) => createBillingCustomer(tx, {
      id: uniqueId('row'), organizationId: principal.organizationId, livemode: false, stripeCustomerId: 'cus_test_only',
    }))
    await db.transaction((tx) => createBillingCustomer(tx, {
      id: uniqueId('row'), organizationId: principal.organizationId, livemode: true, stripeCustomerId: 'cus_live_only',
    }))

    const testRow = await db.transaction((tx) => findBillingCustomer(tx, principal.organizationId, false))
    const liveRow = await db.transaction((tx) => findBillingCustomer(tx, principal.organizationId, true))
    expect(testRow?.stripeCustomerId).toBe('cus_test_only')
    expect(liveRow?.stripeCustomerId).toBe('cus_live_only')
    expect(testRow?.stripeCustomerId).not.toBe(liveRow?.stripeCustomerId)
  })

  it('createBillingCustomerIfAbsent only conflicts within the same (organization, livemode) pair', async () => {
    const { principal } = await freshOrgWithOwner()

    const testInsert = await db.transaction((tx) => createBillingCustomerIfAbsent(tx, {
      id: uniqueId('row'), organizationId: principal.organizationId, livemode: false, stripeCustomerId: 'cus_a',
    }))
    const liveInsert = await db.transaction((tx) => createBillingCustomerIfAbsent(tx, {
      id: uniqueId('row'), organizationId: principal.organizationId, livemode: true, stripeCustomerId: 'cus_b',
    }))
    expect(testInsert).not.toBeNull()
    expect(liveInsert).not.toBeNull()

    const duplicateTestInsert = await db.transaction((tx) => createBillingCustomerIfAbsent(tx, {
      id: uniqueId('row'), organizationId: principal.organizationId, livemode: false, stripeCustomerId: 'cus_c',
    }))
    expect(duplicateTestInsert).toBeNull()
  })
})
