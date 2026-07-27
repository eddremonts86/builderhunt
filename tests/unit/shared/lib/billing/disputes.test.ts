import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { organizations } from '~/shared/lib/db/schema'
import { findCreditGrant } from '~/shared/lib/repositories/billing-ledger'
import { grantCredits } from '~/shared/lib/billing/credits'
import {
  recordDisputeFundsReinstated,
  recordDisputeOpened,
  resolveDispute,
  updateDisputeStripeStatus,
  listOrganizationDisputes,
} from '~/shared/lib/billing/disputes'

let db: PostgresJsDatabase
let drop: () => Promise<void>
let counter = 0
function uniqueId(label: string): string {
  counter += 1
  return `dispute-${label}-${counter}`
}

async function freshOrg(): Promise<string> {
  const orgId = uniqueId('org')
  await db.insert(organizations).values({ id: orgId, name: orgId, slug: orgId, createdAt: new Date() })
  return orgId
}

async function freshGrant(organizationId: string, units = 500): Promise<string> {
  const grantId = uniqueId('grant')
  await db.transaction((tx) => grantCredits(tx, {
    grantId,
    ledgerEntryId: uniqueId('entry'),
    organizationId,
    source: 'pack',
    stripePaymentIntentId: uniqueId('pi'),
    units,
    expiresAt: new Date(Date.now() + 86_400_000),
    idempotencyKey: uniqueId('idem'),
  }))
  return grantId
}

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('billing_disputes')
  db = disposable.db
  drop = disposable.drop
}, 60_000)

afterAll(async () => {
  await drop()
})

describe('recordDisputeOpened', () => {
  it('creates a dispute row and freezes the linked active grant', async () => {
    const organizationId = await freshOrg()
    const grantId = await freshGrant(organizationId)
    const stripeDisputeId = uniqueId('dp')

    const dispute = await db.transaction((tx) => recordDisputeOpened(tx, {
      organizationId,
      grantId,
      stripeDisputeId,
      stripePaymentIntentId: uniqueId('pi'),
      amountCents: 2500,
      reason: 'fraudulent',
      stripeStatus: 'needs_response',
      evidenceDueBy: new Date(Date.now() + 7 * 86_400_000),
    }))

    expect(dispute.outcome).toBe('open')
    expect(dispute.stripeStatus).toBe('needs_response')

    const grant = await db.transaction((tx) => findCreditGrant(tx, organizationId, grantId))
    expect(grant?.state).toBe('frozen')
  })

  it('is idempotent on a duplicate charge.dispute.created delivery — never re-freezes or errors', async () => {
    const organizationId = await freshOrg()
    const grantId = await freshGrant(organizationId)
    const stripeDisputeId = uniqueId('dp')
    const input = {
      organizationId,
      grantId,
      stripeDisputeId,
      stripePaymentIntentId: uniqueId('pi'),
      amountCents: 2500,
      reason: 'fraudulent',
      stripeStatus: 'needs_response',
      evidenceDueBy: null,
    }

    const first = await db.transaction((tx) => recordDisputeOpened(tx, input))
    const second = await db.transaction((tx) => recordDisputeOpened(tx, input))

    expect(second.id).toBe(first.id)
    const grant = await db.transaction((tx) => findCreditGrant(tx, organizationId, grantId))
    expect(grant?.state).toBe('frozen')
  })

  it('records a dispute with no linked grant (subscription-adjacent PaymentIntent with nothing in our ledger) without freezing anything', async () => {
    const organizationId = await freshOrg()
    const stripeDisputeId = uniqueId('dp')

    const dispute = await db.transaction((tx) => recordDisputeOpened(tx, {
      organizationId,
      grantId: null,
      stripeDisputeId,
      stripePaymentIntentId: uniqueId('pi'),
      amountCents: 1000,
      reason: null,
      stripeStatus: 'warning_needs_response',
      evidenceDueBy: null,
    }))

    expect(dispute.grantId).toBeNull()
  })

  it('does not re-freeze a grant that is not in its normal active state (e.g. already revoked by an unrelated refund)', async () => {
    const organizationId = await freshOrg()
    const grantId = await freshGrant(organizationId)
    // Simulate an unrelated prior revocation.
    const { revokeCreditGrant } = await import('~/shared/lib/billing/credits')
    await db.transaction((tx) => revokeCreditGrant(tx, {
      organizationId, grantId, ledgerEntryId: uniqueId('entry'), idempotencyKey: uniqueId('idem'), reason: 'unrelated',
    }))

    const dispute = await db.transaction((tx) => recordDisputeOpened(tx, {
      organizationId,
      grantId,
      stripeDisputeId: uniqueId('dp'),
      stripePaymentIntentId: uniqueId('pi'),
      amountCents: 2500,
      reason: null,
      stripeStatus: 'needs_response',
      evidenceDueBy: null,
    }))

    expect(dispute.grantId).toBe(grantId)
    const grant = await db.transaction((tx) => findCreditGrant(tx, organizationId, grantId))
    expect(grant?.state).toBe('revoked')
  })
})

describe('updateDisputeStripeStatus', () => {
  it('syncs status and evidence deadline without touching outcome', async () => {
    const organizationId = await freshOrg()
    const grantId = await freshGrant(organizationId)
    const stripeDisputeId = uniqueId('dp')
    await db.transaction((tx) => recordDisputeOpened(tx, {
      organizationId, grantId, stripeDisputeId, stripePaymentIntentId: uniqueId('pi'),
      amountCents: 2500, reason: null, stripeStatus: 'needs_response', evidenceDueBy: null,
    }))

    const dueBy = new Date(Date.now() + 3 * 86_400_000)
    const updated = await db.transaction((tx) => updateDisputeStripeStatus(tx, organizationId, stripeDisputeId, 'warning_under_review', dueBy))

    expect(updated?.stripeStatus).toBe('warning_under_review')
    expect(updated?.outcome).toBe('open')
    expect(updated?.evidenceDueBy?.getTime()).toBe(dueBy.getTime())
  })

  it('returns null when the dispute is not found inside this organization scope', async () => {
    const organizationId = await freshOrg()
    const updated = await db.transaction((tx) => updateDisputeStripeStatus(tx, organizationId, 'does-not-exist', 'under_review', null))
    expect(updated).toBeNull()
  })
})

describe('resolveDispute', () => {
  it('winning unfreezes the linked grant and restores its still-valid state', async () => {
    const organizationId = await freshOrg()
    const grantId = await freshGrant(organizationId)
    const stripeDisputeId = uniqueId('dp')
    await db.transaction((tx) => recordDisputeOpened(tx, {
      organizationId, grantId, stripeDisputeId, stripePaymentIntentId: uniqueId('pi'),
      amountCents: 2500, reason: null, stripeStatus: 'needs_response', evidenceDueBy: null,
    }))

    const resolved = await db.transaction((tx) => resolveDispute(tx, organizationId, { stripeDisputeId, outcome: 'won', stripeStatus: 'won' }))

    expect(resolved?.outcome).toBe('won')
    const grant = await db.transaction((tx) => findCreditGrant(tx, organizationId, grantId))
    expect(grant?.state).toBe('active')
  })

  it('losing revokes the linked grant permanently', async () => {
    const organizationId = await freshOrg()
    const grantId = await freshGrant(organizationId)
    const stripeDisputeId = uniqueId('dp')
    await db.transaction((tx) => recordDisputeOpened(tx, {
      organizationId, grantId, stripeDisputeId, stripePaymentIntentId: uniqueId('pi'),
      amountCents: 2500, reason: null, stripeStatus: 'needs_response', evidenceDueBy: null,
    }))

    const resolved = await db.transaction((tx) => resolveDispute(tx, organizationId, { stripeDisputeId, outcome: 'lost', stripeStatus: 'lost' }))

    expect(resolved?.outcome).toBe('lost')
    const grant = await db.transaction((tx) => findCreditGrant(tx, organizationId, grantId))
    expect(grant?.state).toBe('revoked')
  })

  it('is idempotent on a duplicate charge.dispute.closed delivery — a second call is a no-op returning the already-resolved row', async () => {
    const organizationId = await freshOrg()
    const grantId = await freshGrant(organizationId)
    const stripeDisputeId = uniqueId('dp')
    await db.transaction((tx) => recordDisputeOpened(tx, {
      organizationId, grantId, stripeDisputeId, stripePaymentIntentId: uniqueId('pi'),
      amountCents: 2500, reason: null, stripeStatus: 'needs_response', evidenceDueBy: null,
    }))
    await db.transaction((tx) => resolveDispute(tx, organizationId, { stripeDisputeId, outcome: 'lost', stripeStatus: 'lost' }))

    // A duplicate delivery reporting the SAME dispute as 'won' must not flip an already-lost outcome.
    const second = await db.transaction((tx) => resolveDispute(tx, organizationId, { stripeDisputeId, outcome: 'won', stripeStatus: 'won' }))

    expect(second?.outcome).toBe('lost')
    const grant = await db.transaction((tx) => findCreditGrant(tx, organizationId, grantId))
    expect(grant?.state).toBe('revoked')
  })

  it('returns null when the dispute is not found inside this organization scope', async () => {
    const organizationId = await freshOrg()
    const resolved = await db.transaction((tx) => resolveDispute(tx, organizationId, { stripeDisputeId: 'does-not-exist', outcome: 'won', stripeStatus: 'won' }))
    expect(resolved).toBeNull()
  })

  it('resolving a dispute with no linked grant never touches the credit ledger', async () => {
    const organizationId = await freshOrg()
    const stripeDisputeId = uniqueId('dp')
    await db.transaction((tx) => recordDisputeOpened(tx, {
      organizationId, grantId: null, stripeDisputeId, stripePaymentIntentId: uniqueId('pi'),
      amountCents: 1000, reason: null, stripeStatus: 'needs_response', evidenceDueBy: null,
    }))

    const resolved = await db.transaction((tx) => resolveDispute(tx, organizationId, { stripeDisputeId, outcome: 'lost', stripeStatus: 'lost' }))
    expect(resolved?.outcome).toBe('lost')
  })
})

describe('recordDisputeFundsReinstated', () => {
  it('records the accounting fact without reversing a lost dispute\'s credit revocation', async () => {
    const organizationId = await freshOrg()
    const grantId = await freshGrant(organizationId)
    const stripeDisputeId = uniqueId('dp')
    await db.transaction((tx) => recordDisputeOpened(tx, {
      organizationId, grantId, stripeDisputeId, stripePaymentIntentId: uniqueId('pi'),
      amountCents: 2500, reason: null, stripeStatus: 'needs_response', evidenceDueBy: null,
    }))
    await db.transaction((tx) => resolveDispute(tx, organizationId, { stripeDisputeId, outcome: 'lost', stripeStatus: 'lost' }))

    const reinstatedAt = new Date()
    const updated = await db.transaction((tx) => recordDisputeFundsReinstated(tx, organizationId, stripeDisputeId, reinstatedAt))

    expect(updated?.fundsReinstatedAt?.getTime()).toBe(reinstatedAt.getTime())
    const grant = await db.transaction((tx) => findCreditGrant(tx, organizationId, grantId))
    expect(grant?.state).toBe('revoked')
  })

  it('returns null when the dispute is not found inside this organization scope', async () => {
    const organizationId = await freshOrg()
    const updated = await db.transaction((tx) => recordDisputeFundsReinstated(tx, organizationId, 'does-not-exist', new Date()))
    expect(updated).toBeNull()
  })
})

describe('listOrganizationDisputes', () => {
  it('never lists another organization\'s disputes', async () => {
    const organizationId = await freshOrg()
    const otherOrgId = await freshOrg()
    await db.transaction((tx) => recordDisputeOpened(tx, {
      organizationId, grantId: null, stripeDisputeId: uniqueId('dp'), stripePaymentIntentId: uniqueId('pi'),
      amountCents: 1000, reason: null, stripeStatus: 'needs_response', evidenceDueBy: null,
    }))

    const own = await db.transaction((tx) => listOrganizationDisputes(tx, organizationId))
    const other = await db.transaction((tx) => listOrganizationDisputes(tx, otherOrgId))

    expect(own).toHaveLength(1)
    expect(other).toHaveLength(0)
  })
})
