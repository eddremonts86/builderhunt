import { getTableConfig } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import {
  billingAutoRechargeRules,
  billingCheckoutAttempts,
  billingCreditAllocations,
  billingCreditGrants,
  billingCreditReservations,
  billingCustomers,
  billingLedgerEntries,
  billingProviderUsage,
  billingReconciliationRuns,
  billingRefunds,
  billingSellerProfiles,
  billingSubscriptions,
  billingTermsAcceptances,
  billingWebhookEvents,
} from './schema'

const tenantTables = [
  billingCustomers,
  billingSubscriptions,
  billingCheckoutAttempts,
  billingCreditGrants,
  billingCreditReservations,
  billingCreditAllocations,
  billingLedgerEntries,
  billingProviderUsage,
  billingRefunds,
  billingTermsAcceptances,
]

describe('billing schema', () => {
  it('requires organization scope and an organization-preserving candidate key on every tenant-private table', () => {
    for (const table of tenantTables) {
      expect(table.organizationId.notNull).toBe(true)
      const config = getTableConfig(table)
      expect(config.indexes.map((value) => value.config.name)).toContain(`${config.name}_organization_id_id_unique`)
    }
  })

  it('adds organization-preserving composite foreign keys for every cross-table billing reference', () => {
    const names = [
      billingSubscriptions,
      billingCreditAllocations,
      billingLedgerEntries,
      billingRefunds,
    ].flatMap((table) => getTableConfig(table).foreignKeys.map((key) => key.getName()))

    expect(names).toEqual(expect.arrayContaining([
      'billing_subscriptions_organization_customer_fk',
      'billing_credit_allocations_organization_reservation_fk',
      'billing_credit_allocations_organization_grant_fk',
      'billing_ledger_entries_organization_grant_fk',
      'billing_ledger_entries_organization_reservation_fk',
      'billing_refunds_organization_subscription_fk',
      'billing_refunds_organization_grant_fk',
    ]))
  })

  it('has no organization column on system-operational tables', () => {
    for (const table of [billingWebhookEvents, billingReconciliationRuns, billingSellerProfiles]) {
      expect('organizationId' in table).toBe(false)
    }
  })

  it('enforces one live customer per organization/livemode and one non-canceled base subscription', () => {
    const customerIndexes = getTableConfig(billingCustomers).indexes.map((value) => value.config.name)
    expect(customerIndexes).toContain('billing_customers_org_livemode_unique')

    const subscriptionIndexes = getTableConfig(billingSubscriptions).indexes.map((value) => value.config.name)
    expect(subscriptionIndexes).toContain('billing_subscriptions_org_livemode_active_unique')
  })

  it('constrains catalog tier and interval on subscriptions', () => {
    const checks = getTableConfig(billingSubscriptions).checks.map((value) => value.name)
    expect(checks).toEqual(expect.arrayContaining([
      'billing_subscriptions_tier_check',
      'billing_subscriptions_interval_check',
    ]))
  })

  it('keeps every Stripe event unique by livemode and event id', () => {
    const indexes = getTableConfig(billingWebhookEvents).indexes.map((value) => value.config.name)
    expect(indexes).toContain('billing_webhook_events_livemode_stripe_event_id_unique')
    expect(billingWebhookEvents.attempts.notNull).toBe(true)
  })

  it('never lets a credit grant report more remaining than original units', () => {
    const checks = getTableConfig(billingCreditGrants).checks.map((value) => value.name)
    expect(checks).toContain('billing_credit_grants_units_check')
    expect(billingCreditGrants.remainingUnits.notNull).toBe(true)
  })

  it('gives every monthly subscription credit window a unique key when set', () => {
    const index = getTableConfig(billingCreditGrants)
      .indexes.find((value) => value.config.name === 'billing_credit_grants_monthly_window_unique')
    expect(index).toBeDefined()
  })

  it('scopes credit reservations by organization and idempotency key', () => {
    const indexes = getTableConfig(billingCreditReservations).indexes.map((value) => value.config.name)
    expect(indexes).toContain('billing_credit_reservations_org_idempotency_unique')
    const checks = getTableConfig(billingCreditReservations).checks.map((value) => value.name)
    expect(checks).toContain('billing_credit_reservations_units_check')
  })

  it('never lets an allocation consume more than it was allocated', () => {
    const checks = getTableConfig(billingCreditAllocations).checks.map((value) => value.name)
    expect(checks).toContain('billing_credit_allocations_units_check')
    const indexes = getTableConfig(billingCreditAllocations).indexes.map((value) => value.config.name)
    expect(indexes).toContain('billing_credit_allocations_reservation_grant_unique')
  })

  it('is append-only for ledger entries — no updatedAt column exists', () => {
    expect('updatedAt' in billingLedgerEntries).toBe(false)
    const indexes = getTableConfig(billingLedgerEntries).indexes.map((value) => value.config.name)
    expect(indexes).toContain('billing_ledger_entries_org_source_idempotency_unique')
  })

  it('caps auto-recharge at one row per organization and the $1,000 absolute monthly cap', () => {
    expect(billingAutoRechargeRules.organizationId.primary).toBe(true)
    const checks = getTableConfig(billingAutoRechargeRules).checks.map((value) => value.name)
    expect(checks).toContain('billing_auto_recharge_rules_cap_check')
  })

  it('requires an idempotency key and a bounded policy decision for refunds', () => {
    const indexes = getTableConfig(billingRefunds).indexes.map((value) => value.config.name)
    expect(indexes).toContain('billing_refunds_org_idempotency_unique')
    const checks = getTableConfig(billingRefunds).checks.map((value) => value.name)
    expect(checks).toContain('billing_refunds_policy_check')
  })

  it('versions seller profiles uniquely with no CPR/card/bank columns', () => {
    const indexes = getTableConfig(billingSellerProfiles).indexes.map((value) => value.config.name)
    expect(indexes).toContain('billing_seller_profiles_version_unique')
    for (const forbidden of ['cpr', 'cardNumber', 'bankAccount', 'iban']) {
      expect(forbidden in billingSellerProfiles).toBe(false)
    }
  })

  it('records terms/privacy versions per commercial action', () => {
    const checks = getTableConfig(billingTermsAcceptances).checks.map((value) => value.name)
    expect(checks).toContain('billing_terms_acceptances_action_check')
    expect(billingTermsAcceptances.termsVersion.notNull).toBe(true)
    expect(billingTermsAcceptances.privacyVersion.notNull).toBe(true)
  })
})
