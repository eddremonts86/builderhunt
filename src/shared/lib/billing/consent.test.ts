import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TenantPrincipal } from '../authorization/permissions'
import { createDisposableTestDatabase } from '../db/create-disposable-test-database'
import { authUsers, organizations } from '../db/schema'
import { CURRENT_CONSENT_VERSIONS } from '../legal'
import {
  ConsentError,
  recordAutoRechargeConsent,
  recordCheckoutConsent,
  requireCurrentCommercialConsent,
  type CheckoutDisclosures,
} from './consent'

let db: PostgresJsDatabase
let drop: () => Promise<void>
let counter = 0
function uniqueId(label: string): string {
  counter += 1
  return `consent-${label}-${counter}`
}

async function freshPrincipal(): Promise<TenantPrincipal> {
  const orgId = uniqueId('org')
  await db.insert(organizations).values({ id: orgId, name: orgId, slug: orgId, createdAt: new Date() })
  const userId = uniqueId('user')
  await db.insert(authUsers).values({ id: userId, name: userId, email: `${userId}@test.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() })
  return { userId, organizationId: orgId, role: 'owner', requestId: uniqueId('request') }
}

const ALL_ACKNOWLEDGED: CheckoutDisclosures = {
  renewal: true,
  amount: true,
  interval: true,
  cancellationRefundPolicy: true,
  creditExpiryNonTransferability: true,
  tax: true,
  total: true,
}

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('consent')
  db = disposable.db
  drop = disposable.drop
})

afterAll(async () => {
  await drop()
})

describe('recordCheckoutConsent', () => {
  it('stores current version evidence when every disclosure is acknowledged', async () => {
    const principal = await freshPrincipal()

    const record = await db.transaction((tx) => recordCheckoutConsent(tx, principal, {
      action: 'checkout_subscription', disclosures: ALL_ACKNOWLEDGED, referenceId: 'cs_test_1',
    }))

    expect(record.termsVersion).toBe(CURRENT_CONSENT_VERSIONS.tos)
    expect(record.privacyVersion).toBe(CURRENT_CONSENT_VERSIONS.privacy)
    expect(record.commercialAction).toBe('checkout_subscription')
  })

  it('never persists the raw disclosures object — only the typed evidence columns', async () => {
    const principal = await freshPrincipal()

    const record = await db.transaction((tx) => recordCheckoutConsent(tx, principal, {
      action: 'checkout_credits', disclosures: ALL_ACKNOWLEDGED, referenceId: 'cs_test_2',
    }))

    expect(Object.keys(record).sort()).toEqual(
      ['id', 'organizationId', 'actorUserId', 'termsVersion', 'privacyVersion', 'commercialAction', 'referenceId', 'acceptedAt'].sort(),
    )
  })

  it.each(
    (Object.keys(ALL_ACKNOWLEDGED) as Array<keyof CheckoutDisclosures>).map((key) => [key]),
  )('rejects when the %s disclosure is not acknowledged', async (key) => {
    const principal = await freshPrincipal()
    const disclosures = { ...ALL_ACKNOWLEDGED, [key]: false }

    await expect(db.transaction((tx) => recordCheckoutConsent(tx, principal, { action: 'checkout_subscription', disclosures })))
      .rejects.toMatchObject({ code: 'missing_disclosure' })
  })
})

describe('recordAutoRechargeConsent', () => {
  it('stores evidence under the auto_recharge action when acknowledged', async () => {
    const principal = await freshPrincipal()

    const record = await db.transaction((tx) => recordAutoRechargeConsent(tx, principal, { acknowledgedOffSessionCharge: true }))

    expect(record.commercialAction).toBe('auto_recharge')
  })

  it('rejects when the off-session charge is not acknowledged', async () => {
    const principal = await freshPrincipal()

    await expect(db.transaction((tx) => recordAutoRechargeConsent(tx, principal, { acknowledgedOffSessionCharge: false })))
      .rejects.toBeInstanceOf(ConsentError)
  })

  it('is modeled separately from checkout consent — accepting one does not satisfy the other', async () => {
    const principal = await freshPrincipal()

    await db.transaction((tx) => recordCheckoutConsent(tx, principal, { action: 'checkout_subscription', disclosures: ALL_ACKNOWLEDGED }))

    await expect(db.transaction((tx) => requireCurrentCommercialConsent(tx, principal, 'auto_recharge')))
      .rejects.toMatchObject({ code: 'missing_consent' })
  })
})

describe('requireCurrentCommercialConsent', () => {
  it('blocks when no consent has ever been recorded (missing)', async () => {
    const principal = await freshPrincipal()

    await expect(db.transaction((tx) => requireCurrentCommercialConsent(tx, principal, 'checkout_subscription')))
      .rejects.toMatchObject({ code: 'missing_consent' })
  })

  it('passes when a current-version consent is on file', async () => {
    const principal = await freshPrincipal()
    await db.transaction((tx) => recordCheckoutConsent(tx, principal, { action: 'checkout_subscription', disclosures: ALL_ACKNOWLEDGED }))

    await expect(db.transaction((tx) => requireCurrentCommercialConsent(tx, principal, 'checkout_subscription')))
      .resolves.toBeUndefined()
  })

  it('blocks a wrong-org consent — org B accepting never satisfies org A\'s check', async () => {
    const principalA = await freshPrincipal()
    const principalB = await freshPrincipal()
    await db.transaction((tx) => recordCheckoutConsent(tx, principalB, { action: 'checkout_subscription', disclosures: ALL_ACKNOWLEDGED }))

    await expect(db.transaction((tx) => requireCurrentCommercialConsent(tx, principalA, 'checkout_subscription')))
      .rejects.toMatchObject({ code: 'missing_consent' })
  })

  it('a stale (materially superseded) consent blocks Checkout — simulated via a directly-inserted old-version row', async () => {
    const principal = await freshPrincipal()
    const { createBillingTermsAcceptance } = await import('../repositories/billing')
    await db.transaction((tx) => createBillingTermsAcceptance(tx, {
      id: uniqueId('acceptance'),
      organizationId: principal.organizationId,
      actorUserId: principal.userId,
      termsVersion: 'v0.1',
      privacyVersion: CURRENT_CONSENT_VERSIONS.privacy,
      commercialAction: 'checkout_subscription',
    }))

    await expect(db.transaction((tx) => requireCurrentCommercialConsent(tx, principal, 'checkout_subscription')))
      .rejects.toMatchObject({ code: 'stale_consent' })
  })

  it('a non-material (minor) version bump does not invalidate an existing consent', async () => {
    const principal = await freshPrincipal()
    const { createBillingTermsAcceptance } = await import('../repositories/billing')
    // Current tos/privacy version is v1.0 (same major, minor 0). Simulate an acceptance recorded
    // against a different minor release of the same major version — must still satisfy the check.
    await db.transaction((tx) => createBillingTermsAcceptance(tx, {
      id: uniqueId('acceptance'),
      organizationId: principal.organizationId,
      actorUserId: principal.userId,
      termsVersion: 'v1.5',
      privacyVersion: 'v1.9',
      commercialAction: 'checkout_credits',
    }))

    await expect(db.transaction((tx) => requireCurrentCommercialConsent(tx, principal, 'checkout_credits')))
      .resolves.toBeUndefined()
  })
})
