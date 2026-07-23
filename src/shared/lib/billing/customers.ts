/**
 * Creates and reuses one Stripe Customer per organization per livemode
 * (plans/stripe-billing-platform/tasks.md §5 "Create organization Stripe Customers idempotently").
 * The only email ever sent to the provider is the organization owner's account email — never
 * candidate/product data, never a client-supplied value. `metadata` carries only the opaque
 * organization id, nothing else.
 *
 * Idempotency has two layers, matching every other mutating billing operation in this codebase:
 * - The provider call uses a key derived only from `(organizationId, livemode)` — stable across
 *   retries, so a lost-response retry (or a genuinely concurrent second caller) gets back the
 *   SAME provider-side customer, never a second one.
 * - The DB insert uses `createBillingCustomerIfAbsent`, which tolerates losing the
 *   `billing_customers_org_livemode_unique` race to a concurrent transaction — the loser
 *   re-reads and returns the winner's row instead of throwing.
 */
import { randomUUID } from 'node:crypto'
import type { TenantPrincipal } from '../authorization/permissions'
import type { TenantTransaction } from '../db/client'
import {
  createBillingCustomerIfAbsent,
  findBillingCustomer,
  findOrganizationOwnerEmail,
  type BillingCustomerRecord,
} from '../repositories/billing'
import type { BillingProvider } from './provider'
import { idempotencyKeyFor, isLiveMode } from './stripe-client'

export class CustomerProvisioningError extends Error {
  constructor(message: string, readonly code: 'no_owner' | 'lost_customer') {
    super(message)
    this.name = 'CustomerProvisioningError'
  }
}

export interface BillingCustomerDto {
  livemode: boolean
}

function toDto(record: BillingCustomerRecord): BillingCustomerDto {
  return { livemode: record.livemode }
}

export interface EnsureBillingCustomerOptions {
  provider: BillingProvider
}

/**
 * Resolves the organization's Customer for the current livemode, creating it on first use.
 * Safe to call on every Checkout attempt — a second call for the same org/livemode is a
 * read, not a re-create.
 */
export async function ensureBillingCustomer(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  options: EnsureBillingCustomerOptions,
): Promise<BillingCustomerDto> {
  const livemode = isLiveMode()

  const existing = await findBillingCustomer(transaction, principal.organizationId, livemode)
  if (existing) return toDto(existing)

  const ownerEmail = await findOrganizationOwnerEmail(transaction, principal.organizationId)
  if (!ownerEmail) {
    throw new CustomerProvisioningError(`Organization ${principal.organizationId} has no owner to bill`, 'no_owner')
  }

  const operationKey = idempotencyKeyFor('create-customer', principal.organizationId, livemode ? 'live' : 'test')
  const stripeCustomer = await options.provider.createCustomer({
    email: ownerEmail,
    metadata: { organizationId: principal.organizationId },
    idempotencyKey: operationKey,
  })

  const inserted = await createBillingCustomerIfAbsent(transaction, {
    id: randomUUID(),
    organizationId: principal.organizationId,
    livemode,
    stripeCustomerId: stripeCustomer.id,
  })
  if (inserted) return toDto(inserted)

  // Lost the insert race to a concurrent caller — its row is now visible; return that one instead
  // of treating this as an error (this call still succeeded from the caller's point of view).
  const winner = await findBillingCustomer(transaction, principal.organizationId, livemode)
  if (!winner) {
    throw new CustomerProvisioningError(
      `Billing customer for organization ${principal.organizationId} disappeared after a conflicting insert`,
      'lost_customer',
    )
  }
  return toDto(winner)
}
