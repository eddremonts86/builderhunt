import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '../db/create-disposable-test-database'
import { authUsers } from '../db/schema'
import {
  createSellerProfileVersion,
  getCurrentSellerProfile,
  listSellerProfileHistory,
  SellerProfileInputSchema,
} from './seller-profile'

const validInput = {
  legalName: 'Jane Doe (Sole Trader)',
  publicBusinessAddress: 'Some Street 1, 1000 Copenhagen, Denmark',
  establishmentCountry: 'DK',
  approvedTaxIds: ['DK12345678'],
  supportEmail: 'support@builderhunt.test',
  statementDescriptor: 'BUILDERHUNT',
  countryAllowlist: ['DK'],
  taxRegistrations: [{ country: 'DK', registrationId: 'DK12345678', effectiveAt: '2026-07-23T00:00:00.000Z' }],
  effectiveAt: '2026-07-23T00:00:00.000Z',
}

describe('SellerProfileInputSchema', () => {
  it('accepts a well-formed seller profile input', () => {
    expect(SellerProfileInputSchema.safeParse(validInput).success).toBe(true)
  })

  it('rejects a PII fixture — CPR, card, and bank fields have no place in this schema', () => {
    const piiFixture = {
      ...validInput,
      cpr: '010190-1234',
      cardNumber: '4242424242424242',
      bankAccountNumber: '00001234567890',
    }
    const result = SellerProfileInputSchema.safeParse(piiFixture)
    expect(result.success).toBe(false)
  })

  it('rejects a tax registration entry with an unexpected extra field', () => {
    const result = SellerProfileInputSchema.safeParse({
      ...validInput,
      taxRegistrations: [{ country: 'DK', registrationId: 'DK12345678', effectiveAt: '2026-07-23T00:00:00.000Z', bankAccountNumber: '000123' }],
    })
    expect(result.success).toBe(false)
  })

  it('rejects a missing required field', () => {
    const { legalName: _legalName, ...withoutLegalName } = validInput
    expect(SellerProfileInputSchema.safeParse(withoutLegalName).success).toBe(false)
  })

  it('rejects an invalid support email', () => {
    expect(SellerProfileInputSchema.safeParse({ ...validInput, supportEmail: 'not-an-email' }).success).toBe(false)
  })

  it('defaults array fields to empty when omitted', () => {
    const { approvedTaxIds: _a, countryAllowlist: _c, taxRegistrations: _t, ...minimal } = validInput
    const result = SellerProfileInputSchema.safeParse(minimal)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.approvedTaxIds).toEqual([])
      expect(result.data.countryAllowlist).toEqual([])
      expect(result.data.taxRegistrations).toEqual([])
    }
  })
})

/**
 * Real-Postgres integration test, following the precedent `repositories/billing.test.ts` set: a
 * self-created, migrated, and dropped disposable database — safe unconditionally since
 * `DATABASE_MIGRATION_URL` is already a hard app-wide requirement and this repo's CI already runs a
 * live Postgres service for the whole test/build sequence. `getCurrentSellerProfile`/
 * `listSellerProfileHistory`/`createSellerProfileVersion` accept an injectable `db` parameter
 * specifically so this test can point them at the disposable database instead of the real
 * `platformDb` module singleton (which is bound to `.env`'s connection at import time and can't be
 * redirected per-test without env-var gymnastics).
 */
let db: PostgresJsDatabase
let drop: () => Promise<void>

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('seller_profile')
  db = disposable.db
  drop = disposable.drop

  await db.insert(authUsers).values({
    id: 'seller-profile-platform-admin', name: 'Admin', email: 'seller-profile-admin@test.invalid',
    emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
  })
}, 60_000)

afterAll(async () => {
  await drop()
})

describe('seller profile versioning — real database', () => {
  it('has no current profile before any version is recorded', async () => {
    expect(await getCurrentSellerProfile(db)).toBeNull()
    expect(await listSellerProfileHistory(db)).toEqual([])
  })

  it('creates version 1 when none exists yet', async () => {
    const created = await createSellerProfileVersion(validInput, 'seller-profile-platform-admin', db)
    expect(created.version).toBe(1)
    expect(created.legalName).toBe('Jane Doe (Sole Trader)')
  })

  it('creates version 2 as the next version after 1, and getCurrentSellerProfile returns it', async () => {
    const updatedInput = { ...validInput, legalName: 'Jane Doe ApS', statementDescriptor: 'BUILDERHUNT2' }
    const created = await createSellerProfileVersion(updatedInput, 'seller-profile-platform-admin', db)
    expect(created.version).toBe(2)

    const current = await getCurrentSellerProfile(db)
    expect(current?.version).toBe(2)
    expect(current?.legalName).toBe('Jane Doe ApS')
  })

  it('keeps version 1 readable in history after version 2 is created — historical version remains readable', async () => {
    const history = await listSellerProfileHistory(db)
    expect(history.map((entry) => entry.version)).toEqual([2, 1])
    const v1 = history.find((entry) => entry.version === 1)
    expect(v1?.legalName).toBe('Jane Doe (Sole Trader)')
  })

  it('round-trips jsonb array fields exactly', async () => {
    const current = await getCurrentSellerProfile(db)
    expect(current?.countryAllowlist).toEqual(['DK'])
    expect(current?.taxRegistrations).toEqual([{ country: 'DK', registrationId: 'DK12345678', effectiveAt: '2026-07-23T00:00:00.000Z' }])
  })
})
