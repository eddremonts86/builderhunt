import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { TenantPrincipal } from '../authorization/permissions'
import { createDisposableTestDatabase } from '../db/create-disposable-test-database'
import { authUsers, organizations } from '../db/schema'
import { env } from '../env'
import { createBillingCustomer } from '../repositories/billing'
import { createBillingPortalSession, PortalError } from './portal'
import { FakeBillingProvider } from './fake-provider'

let db: PostgresJsDatabase
let drop: () => Promise<void>
let counter = 0
function uniqueId(label: string): string {
  counter += 1
  return `portal-${label}-${counter}`
}

async function freshPrincipal(): Promise<TenantPrincipal> {
  const orgId = uniqueId('org')
  await db.insert(organizations).values({ id: orgId, name: orgId, slug: orgId, createdAt: new Date() })
  const userId = uniqueId('user')
  await db.insert(authUsers).values({ id: userId, name: userId, email: `${userId}@test.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() })
  return { userId, organizationId: orgId, role: 'owner', requestId: uniqueId('request') }
}

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('portal')
  db = disposable.db
  drop = disposable.drop
})

afterAll(async () => {
  await drop()
})

describe('createBillingPortalSession', () => {
  let provider: FakeBillingProvider

  beforeEach(() => {
    provider = new FakeBillingProvider()
  })

  it('creates a Portal session URL for an organization with an existing Stripe customer', async () => {
    const principal = await freshPrincipal()
    const customerId = uniqueId('customer')
    await db.transaction((tx) => createBillingCustomer(tx, {
      id: customerId, organizationId: principal.organizationId, livemode: false, stripeCustomerId: `cus_${customerId}`,
    }))

    const result = await db.transaction((tx) => createBillingPortalSession(
      tx, principal, { returnUrl: `${env.APP_URL}/settings/billing` }, { provider },
    ))

    expect(result.url).toMatch(/^https:\/\/billing\.stripe\.test\/portal\//)
  })

  it('the result carries only a url — never plan/price/product fields (Portal never changes what the org is subscribed to)', async () => {
    const principal = await freshPrincipal()
    const customerId = uniqueId('customer')
    await db.transaction((tx) => createBillingCustomer(tx, {
      id: customerId, organizationId: principal.organizationId, livemode: false, stripeCustomerId: `cus_${customerId}`,
    }))

    const result = await db.transaction((tx) => createBillingPortalSession(
      tx, principal, { returnUrl: `${env.APP_URL}/settings/billing` }, { provider },
    ))

    expect(Object.keys(result)).toEqual(['url'])
  })

  it('rejects when the organization has no Stripe customer yet (never subscribed)', async () => {
    const principal = await freshPrincipal()

    await expect(db.transaction((tx) => createBillingPortalSession(
      tx, principal, { returnUrl: `${env.APP_URL}/settings/billing` }, { provider },
    ))).rejects.toMatchObject({ code: 'no_customer' })
  })

  it('rejects a returnUrl outside this app\'s own origin (open-redirect prevention)', async () => {
    const principal = await freshPrincipal()
    const customerId = uniqueId('customer')
    await db.transaction((tx) => createBillingCustomer(tx, {
      id: customerId, organizationId: principal.organizationId, livemode: false, stripeCustomerId: `cus_${customerId}`,
    }))

    await expect(db.transaction((tx) => createBillingPortalSession(
      tx, principal, { returnUrl: 'https://evil.example.com/steal' }, { provider },
    ))).rejects.toBeInstanceOf(PortalError)
  })

  it('rejects a lookalike origin whose host merely starts with our own (e.g. https://app.test.evil.com) — this must be an exact origin match, not a string prefix match', async () => {
    const principal = await freshPrincipal()
    const customerId = uniqueId('customer')
    await db.transaction((tx) => createBillingCustomer(tx, {
      id: customerId, organizationId: principal.organizationId, livemode: false, stripeCustomerId: `cus_${customerId}`,
    }))

    const appOrigin = new URL(env.APP_URL)
    const lookalike = `${appOrigin.protocol}//${appOrigin.host}.evil.com/settings/billing`
    await expect(db.transaction((tx) => createBillingPortalSession(
      tx, principal, { returnUrl: lookalike }, { provider },
    ))).rejects.toMatchObject({ code: 'invalid_url' })
  })
})
