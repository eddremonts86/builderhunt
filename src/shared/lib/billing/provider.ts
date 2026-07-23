/**
 * The billing provider contract (spec.md §Domain boundaries: billing/payments,
 * billing/subscriptions). Every mutating billing operation in this codebase
 * goes through an implementation of `BillingProvider` — never a raw Stripe
 * SDK call scattered across route handlers — so the exact same call sites
 * and tests run unchanged against `FakeBillingProvider` (deterministic, no
 * network, used by every unit/API test) and a future real Stripe-backed
 * adapter (sandbox/live), built once real credentials exist.
 *
 * `idempotencyKey` is required on every mutating call: a retried call with
 * the same key must return the original result, never create a second
 * object or double-charge.
 */

export type BillingScenario =
  | 'success'
  | 'sca_required'
  | 'decline'
  | 'timeout'
  | 'duplicate'
  | 'delayed'
  | 'out_of_order'

export class BillingProviderError extends Error {
  constructor(
    message: string,
    readonly scenario: Exclude<BillingScenario, 'success' | 'duplicate'>,
  ) {
    super(message)
    this.name = 'BillingProviderError'
  }
}

export interface BillingCustomer {
  id: string
  email: string | null
  metadata: Record<string, string>
  createdAt: string
}

export type CheckoutSessionStatus = 'open' | 'complete' | 'expired'
export type CheckoutMode = 'subscription' | 'payment'

export interface BillingCheckoutSession {
  id: string
  customerId: string
  mode: CheckoutMode
  status: CheckoutSessionStatus
  url: string
  priceId: string
  metadata: Record<string, string>
  createdAt: string
  updatedAt: string
  /** Echoes back the Checkout-time settings this session was created with — lets callers/tests confirm the required spec.md disclosures/collection settings were actually requested, without a separate spy. */
  automaticTax: boolean
  billingAddressCollection: 'auto' | 'required'
  taxIdCollection: boolean
  allowPromotionCodes: boolean
  paymentMethodTypes: string[]
}

export type SubscriptionStatus = 'active' | 'past_due' | 'canceled' | 'trialing' | 'incomplete'

export interface BillingSubscription {
  id: string
  customerId: string
  status: SubscriptionStatus
  priceId: string
  currentPeriodEnd: string
  cancelAtPeriodEnd: boolean
  createdAt: string
  updatedAt: string
}

export interface SubscriptionPreview {
  amountDue: number
  currency: string
  prorationDate: string
  nextPaymentDate: string
}

export type PaymentIntentStatus = 'requires_payment_method' | 'requires_action' | 'processing' | 'succeeded' | 'canceled'

export interface BillingPaymentIntent {
  id: string
  customerId: string
  status: PaymentIntentStatus
  amount: number
  currency: string
  createdAt: string
  updatedAt: string
}

export type RefundStatus = 'pending' | 'succeeded' | 'failed'

export interface BillingRefund {
  id: string
  paymentIntentId: string
  amount: number
  status: RefundStatus
  createdAt: string
  updatedAt: string
}

export interface CreateCustomerInput {
  email: string
  metadata?: Record<string, string>
  idempotencyKey: string
}

export interface CreateCheckoutSessionInput {
  customerId: string
  mode: CheckoutMode
  priceId: string
  successUrl: string
  cancelUrl: string
  idempotencyKey: string
  scenario?: BillingScenario
  /** Stripe Tax — spec.md: "Checkout uses subscription mode, automatic tax, billing address, tax-ID collection, ...". The fake provider accepts and ignores these; a future real adapter translates them into the matching `stripe.checkout.sessions.create` parameters. */
  automaticTax?: boolean
  billingAddressCollection?: 'auto' | 'required'
  taxIdCollection?: boolean
  allowPromotionCodes?: boolean
  customerUpdate?: { address?: 'auto'; name?: 'auto' }
  /** Restricts Checkout to methods that settle immediately (never ACH/SEPA/vouchers) — see `billing/checkout.ts`'s `APPROVED_IMMEDIATE_PAYMENT_METHOD_TYPES`. */
  paymentMethodTypes?: string[]
}

export interface CreatePortalSessionInput {
  customerId: string
  returnUrl: string
}

export interface PreviewSubscriptionChangeInput {
  subscriptionId: string
  newPriceId: string
}

export interface ChangeSubscriptionInput {
  subscriptionId: string
  newPriceId: string
  idempotencyKey: string
  scenario?: BillingScenario
}

export interface CancelSubscriptionInput {
  subscriptionId: string
  atPeriodEnd: boolean
}

export interface CreateSetupIntentInput {
  customerId: string
  idempotencyKey: string
}

export interface SetupIntentResult {
  id: string
  clientSecret: string
  status: 'requires_payment_method' | 'requires_action' | 'succeeded'
}

export interface CreatePaymentIntentInput {
  customerId: string
  amount: number
  currency: string
  idempotencyKey: string
  scenario?: BillingScenario
}

export interface CreateRefundInput {
  paymentIntentId: string
  amount?: number
  idempotencyKey: string
}

export type ReconciliationObjectType = 'customers' | 'subscriptions' | 'payment_intents' | 'refunds'
export type RefreshableObjectType = 'customer' | 'subscription' | 'checkout_session' | 'payment_intent'

export interface BillingProvider {
  createCustomer(input: CreateCustomerInput): Promise<BillingCustomer>
  getCustomer(customerId: string): Promise<BillingCustomer | null>

  createCheckoutSession(input: CreateCheckoutSessionInput): Promise<BillingCheckoutSession>
  getCheckoutSession(checkoutSessionId: string): Promise<BillingCheckoutSession | null>

  createPortalSession(input: CreatePortalSessionInput): Promise<{ url: string }>

  previewSubscriptionChange(input: PreviewSubscriptionChangeInput): Promise<SubscriptionPreview>
  changeSubscription(input: ChangeSubscriptionInput): Promise<BillingSubscription>
  cancelSubscription(input: CancelSubscriptionInput): Promise<BillingSubscription>
  getSubscription(subscriptionId: string): Promise<BillingSubscription | null>

  createSetupIntent(input: CreateSetupIntentInput): Promise<SetupIntentResult>
  createPaymentIntent(input: CreatePaymentIntentInput): Promise<BillingPaymentIntent>

  createRefund(input: CreateRefundInput): Promise<BillingRefund>

  /** Re-fetches the current provider-side state of an object — used when webhook delivery order is ambiguous (spec.md §Webhook and consistency contract). */
  refreshObject(type: RefreshableObjectType, id: string): Promise<unknown>

  /** Lists objects for daily reconciliation (spec.md §Operations). Order is NOT guaranteed to match creation order — callers must reconcile by id/timestamp, never by list position. */
  listForReconciliation(type: ReconciliationObjectType, options?: { since?: string }): Promise<unknown[]>
}
