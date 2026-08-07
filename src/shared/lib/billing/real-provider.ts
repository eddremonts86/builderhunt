/**
 * Real Stripe-backed implementation of `BillingProvider` — built against `getStripeClient()`'s
 * memoized SDK singleton (stripe-client.ts). Every mutating call passes the caller-supplied
 * `idempotencyKey` as Stripe's own request-level idempotency key option (never embedded in the
 * payload), so a retried request never double-creates/double-charges — the same pattern
 * `provision-stripe-catalog.ts` already established for this codebase's one other real-Stripe
 * caller.
 *
 * Documented divergence from `FakeBillingProvider` (see provider-contract-suite.ts's own header
 * comment for the "must pass unmodified" contract this breaks): `changeSubscription` on this
 * adapter REQUIRES `subscriptionId` to already exist as a real Stripe subscription — Stripe assigns
 * subscription ids itself, there is no create-on-arbitrary-id upsert, and `stripe.subscriptions.update`
 * 404s against an id Stripe never issued. Every real call site (`subscription-changes.ts`,
 * `price-migrations.ts`) already only ever calls `changeSubscription` with a `stripeSubscriptionId`
 * read from a DB row populated by a prior webhook — never an invented id — so this is a documented
 * interface-vs-real-API gap, not a functional one. `provider-contract-suite.ts`'s "creates a
 * subscription via changeSubscription" and idempotent-create tests therefore cannot run against
 * this adapter; `real-provider.test.ts` runs the suite's remaining assertions individually plus its
 * own subscription-lifecycle tests seeded through a real `stripe.subscriptions.create` call.
 */
import Stripe from 'stripe'
import type {
  BillingCheckoutSession,
  BillingCustomer,
  BillingPaymentIntent,
  BillingProvider,
  BillingRefund,
  BillingSubscription,
  CancelSubscriptionInput,
  ChangeSubscriptionInput,
  CreateCheckoutSessionInput,
  CreateCustomerInput,
  CreatePaymentIntentInput,
  CreatePortalSessionInput,
  CreateRefundInput,
  CreateSetupIntentInput,
  PaymentMethodSummary,
  PreviewSubscriptionChangeInput,
  ReconciliationObjectType,
  RefreshableObjectType,
  SetupIntentResult,
  SubscriptionPreview,
  SubscriptionStatus,
} from './provider'
import { BillingProviderError } from './provider'
import { getStripeClient, redactStripeError } from './stripe-client'

/** Never log/throw a raw Stripe error object — always go through this first. */
function mapStripeError(error: unknown): Error {
  if (!(error instanceof Stripe.errors.StripeError)) {
    return error instanceof Error ? error : new Error('Unknown Stripe error')
  }
  const redacted = redactStripeError(error)
  if (error instanceof Stripe.errors.StripeCardError) {
    return new BillingProviderError(redacted.message, 'decline')
  }
  if (
    error instanceof Stripe.errors.StripeConnectionError ||
    error instanceof Stripe.errors.StripeAPIError ||
    error instanceof Stripe.errors.StripeRateLimitError
  ) {
    return new BillingProviderError(redacted.message, 'timeout')
  }
  // Everything else (invalid request, auth, permission, idempotency conflict) is a real bug in how
  // we called Stripe, not a customer-facing decline/timeout scenario — surface it as a plain error
  // rather than forcing it into the fake provider's narrow scenario vocabulary.
  return new Error(`Stripe ${redacted.type ?? 'error'}${redacted.code ? ` (${redacted.code})` : ''}: ${redacted.message}`)
}

/** True when Stripe rejected an off-session confirm specifically because the customer must
 * authenticate — the embedded intent on the error carries the `requires_action`/`requires_confirmation`
 * state we need to return, not throw (mirrors real Stripe's off-session recovery flow). */
function isAuthenticationRequiredError(error: Stripe.errors.StripeError): boolean {
  return error.code === 'authentication_required' || Boolean(error.payment_intent) || Boolean(error.setup_intent)
}

function toIso(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString()
}

function customerIdOf(customer: string | Stripe.Customer | Stripe.DeletedCustomer): string {
  return typeof customer === 'string' ? customer : customer.id
}

function mapCustomer(customer: Stripe.Customer): BillingCustomer {
  return {
    id: customer.id,
    email: customer.email,
    metadata: customer.metadata ?? {},
    createdAt: toIso(customer.created),
  }
}

/** Stripe's `Subscription.Status` has 8 values; our domain `SubscriptionStatus` has 5. The three
 * extra values never represent a subscription that should currently grant access, so they collapse
 * into the closest "not active" bucket rather than getting their own domain status: `unpaid`/`paused`
 * behave like a recoverable non-payment (`past_due`, already handled by dunning.ts's 7-day flow);
 * `incomplete_expired` never collected its first payment and will never retry (`canceled`). */
function mapSubscriptionStatus(status: Stripe.Subscription.Status): SubscriptionStatus {
  switch (status) {
    case 'active': return 'active'
    case 'past_due': return 'past_due'
    case 'trialing': return 'trialing'
    case 'incomplete': return 'incomplete'
    case 'canceled': return 'canceled'
    case 'incomplete_expired': return 'canceled'
    case 'unpaid': return 'past_due'
    case 'paused': return 'past_due'
    default: return 'incomplete'
  }
}

function mapSubscription(subscription: Stripe.Subscription): BillingSubscription {
  // `current_period_end`/price live on the SubscriptionItem, not the Subscription itself (a recent
  // Stripe API change) — see provider.ts's callers, all single-price subscriptions, item [0] only.
  const item = subscription.items.data[0]
  const priceId = item?.price?.id ?? ''
  // Stripe's Subscription object has no top-level "updated" timestamp — `created` is the closest
  // stable value available; same choice made for Checkout Sessions below.
  const createdAt = toIso(subscription.created)
  return {
    id: subscription.id,
    customerId: customerIdOf(subscription.customer),
    status: mapSubscriptionStatus(subscription.status),
    priceId,
    currentPeriodEnd: item ? toIso(item.current_period_end) : createdAt,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    createdAt,
    updatedAt: createdAt,
  }
}

function mapCheckoutSession(session: Stripe.Checkout.Session, priceId: string): BillingCheckoutSession {
  const createdAt = toIso(session.created)
  return {
    id: session.id,
    customerId: session.customer ? customerIdOf(session.customer) : '',
    // This adapter never creates 'setup' mode Checkout Sessions itself (see CreateCheckoutSessionInput's
    // narrower CheckoutMode); a defensively-retrieved session in that mode has no meaningful mapping
    // onto our domain, so it collapses to 'payment' rather than throwing on a read path.
    //
    // Tested positively for the one mode we do create, because stripe's own union carries an
    // `OtherString` arm for modes added after this SDK version. Excluding 'setup' would leave that
    // arm assignable to CheckoutMode, so an unrecognised future mode would flow through untranslated.
    mode: session.mode === 'subscription' ? 'subscription' : 'payment',
    status: session.status ?? 'open',
    url: session.url ?? '',
    priceId,
    metadata: session.metadata ?? {},
    createdAt,
    updatedAt: createdAt,
    automaticTax: session.automatic_tax?.enabled ?? false,
    // Same `OtherString` arm as `mode` above: `?? 'auto'` only replaces null, so an unrecognised
    // collection setting would reach a field this domain declares as 'auto' | 'required'.
    billingAddressCollection: session.billing_address_collection === 'required' ? 'required' : 'auto',
    taxIdCollection: session.tax_id_collection?.enabled ?? false,
    allowPromotionCodes: session.allow_promotion_codes ?? false,
    paymentMethodTypes: session.payment_method_types ?? [],
  }
}

function mapPaymentIntent(paymentIntent: Stripe.PaymentIntent): BillingPaymentIntent {
  const createdAt = toIso(paymentIntent.created)
  return {
    id: paymentIntent.id,
    customerId: paymentIntent.customer ? customerIdOf(paymentIntent.customer) : '',
    // Our domain PaymentIntentStatus omits Stripe's requires_confirmation/requires_capture — this
    // adapter only ever confirms off-session (confirm:true, off_session:true) so those two never
    // occur in practice; collapse defensively to requires_action rather than throwing on a read path.
    status: mapPaymentIntentStatus(paymentIntent.status),
    amount: paymentIntent.amount,
    currency: paymentIntent.currency,
    createdAt,
    updatedAt: createdAt,
  }
}

function mapPaymentIntentStatus(status: Stripe.PaymentIntent.Status): BillingPaymentIntent['status'] {
  switch (status) {
    case 'succeeded': return 'succeeded'
    case 'processing': return 'processing'
    case 'canceled': return 'canceled'
    case 'requires_payment_method': return 'requires_payment_method'
    default: return 'requires_action'
  }
}

function mapSetupIntent(setupIntent: Stripe.SetupIntent): SetupIntentResult {
  return {
    id: setupIntent.id,
    clientSecret: setupIntent.client_secret ?? '',
    status: mapSetupIntentStatus(setupIntent.status),
  }
}

function mapSetupIntentStatus(status: Stripe.SetupIntent.Status): SetupIntentResult['status'] {
  switch (status) {
    case 'succeeded': return 'succeeded'
    case 'requires_payment_method': return 'requires_payment_method'
    default: return 'requires_action'
  }
}

function mapRefund(refund: Stripe.Refund): BillingRefund {
  const createdAt = toIso(refund.created)
  return {
    id: refund.id,
    paymentIntentId: refund.payment_intent ? customerIdOf(refund.payment_intent as string | Stripe.Customer | Stripe.DeletedCustomer) : '',
    amount: refund.amount,
    status: refund.status === 'succeeded' ? 'succeeded' : refund.status === 'failed' ? 'failed' : 'pending',
    createdAt,
    updatedAt: createdAt,
  }
}

function extractDefaultPaymentMethodId(customer: Stripe.Customer): string | null {
  const defaultPaymentMethod = customer.invoice_settings.default_payment_method
  if (!defaultPaymentMethod) return null
  return typeof defaultPaymentMethod === 'string' ? defaultPaymentMethod : defaultPaymentMethod.id
}

/** Restricted Customer Portal Configuration this adapter always requests — spec.md requires the
 * Portal be scoped to payment methods/tax identity/invoices/receipts only, with no plan-switch or
 * cancel capability exposed. Tagged with metadata rather than relying on Stripe's "default"
 * configuration flag, so re-running provisioning finds the SAME configuration idempotently instead
 * of accumulating duplicates. */
const PORTAL_CONFIGURATION_METADATA_KEY = 'builderhunt_restricted_portal'

export class RealBillingProvider implements BillingProvider {
  private readonly stripe: Stripe
  private portalConfigurationId: string | null = null

  constructor(stripe: Stripe = getStripeClient()) {
    this.stripe = stripe
  }

  async createCustomer(input: CreateCustomerInput): Promise<BillingCustomer> {
    try {
      const customer = await this.stripe.customers.create(
        { email: input.email, metadata: input.metadata },
        { idempotencyKey: input.idempotencyKey },
      )
      return mapCustomer(customer)
    } catch (error) {
      throw mapStripeError(error)
    }
  }

  async getCustomer(customerId: string): Promise<BillingCustomer | null> {
    try {
      const customer = await this.stripe.customers.retrieve(customerId)
      if (customer.deleted) return null
      return mapCustomer(customer)
    } catch (error) {
      if (error instanceof Stripe.errors.StripeError && error.code === 'resource_missing') return null
      throw mapStripeError(error)
    }
  }

  async getDefaultPaymentMethodSummary(customerId: string): Promise<PaymentMethodSummary | null> {
    try {
      const customer = await this.stripe.customers.retrieve(customerId, {
        expand: ['invoice_settings.default_payment_method'],
      })
      if (customer.deleted) return null
      const defaultPaymentMethod = customer.invoice_settings.default_payment_method
      const paymentMethod = typeof defaultPaymentMethod === 'string' || !defaultPaymentMethod ? null : defaultPaymentMethod
      if (!paymentMethod?.card) return null
      return { brand: paymentMethod.card.brand, last4: paymentMethod.card.last4 }
    } catch (error) {
      if (error instanceof Stripe.errors.StripeError && error.code === 'resource_missing') return null
      throw mapStripeError(error)
    }
  }

  async createCheckoutSession(input: CreateCheckoutSessionInput): Promise<BillingCheckoutSession> {
    try {
      const session = await this.stripe.checkout.sessions.create(
        {
          customer: input.customerId,
          mode: input.mode,
          line_items: [{ price: input.priceId, quantity: 1 }],
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
          automatic_tax: input.automaticTax ? { enabled: true } : undefined,
          billing_address_collection: input.billingAddressCollection,
          tax_id_collection: input.taxIdCollection ? { enabled: true } : undefined,
          allow_promotion_codes: input.allowPromotionCodes,
          customer_update: input.customerUpdate,
          payment_method_types: input.paymentMethodTypes as Stripe.Checkout.SessionCreateParams.PaymentMethodType[] | undefined,
        },
        { idempotencyKey: input.idempotencyKey },
      )
      // The session we just created always carries the price we asked for — Checkout Sessions never
      // echo it back at the top level (only inside line_items, which needs a separate expand+fetch),
      // so use the input directly rather than re-retrieving.
      return mapCheckoutSession(session, input.priceId)
    } catch (error) {
      throw mapStripeError(error)
    }
  }

  async getCheckoutSession(checkoutSessionId: string): Promise<BillingCheckoutSession | null> {
    try {
      const session = await this.stripe.checkout.sessions.retrieve(checkoutSessionId, { expand: ['line_items'] })
      const priceId = session.line_items?.data[0]?.price?.id ?? ''
      return mapCheckoutSession(session, priceId)
    } catch (error) {
      if (error instanceof Stripe.errors.StripeError && error.code === 'resource_missing') return null
      throw mapStripeError(error)
    }
  }

  private async ensureRestrictedPortalConfiguration(): Promise<string> {
    if (this.portalConfigurationId) return this.portalConfigurationId
    const existing = await this.stripe.billingPortal.configurations.list({ limit: 100 })
    const match = existing.data.find((c) => c.active && c.metadata?.[PORTAL_CONFIGURATION_METADATA_KEY] === 'true')
    if (match) {
      this.portalConfigurationId = match.id
      return match.id
    }
    const created = await this.stripe.billingPortal.configurations.create({
      business_profile: { headline: 'BuilderHunt billing' },
      metadata: { [PORTAL_CONFIGURATION_METADATA_KEY]: 'true' },
      features: {
        customer_update: { enabled: true, allowed_updates: ['address', 'tax_id'] },
        invoice_history: { enabled: true },
        payment_method_update: { enabled: true },
        subscription_cancel: { enabled: false },
        subscription_update: { enabled: false },
      },
    })
    this.portalConfigurationId = created.id
    return created.id
  }

  async createPortalSession(input: CreatePortalSessionInput): Promise<{ url: string }> {
    try {
      const configuration = await this.ensureRestrictedPortalConfiguration()
      const session = await this.stripe.billingPortal.sessions.create({
        customer: input.customerId,
        return_url: input.returnUrl,
        configuration,
      })
      return { url: session.url }
    } catch (error) {
      throw mapStripeError(error)
    }
  }

  async previewSubscriptionChange(input: PreviewSubscriptionChangeInput): Promise<SubscriptionPreview> {
    try {
      const subscription = await this.stripe.subscriptions.retrieve(input.subscriptionId)
      const item = subscription.items.data[0]
      const preview = await this.stripe.invoices.createPreview({
        subscription: input.subscriptionId,
        subscription_details: {
          items: item ? [{ id: item.id, price: input.newPriceId }] : [{ price: input.newPriceId }],
          proration_behavior: 'create_prorations',
        },
      })
      const now = new Date().toISOString()
      return {
        amountDue: preview.amount_due,
        currency: preview.currency,
        prorationDate: now,
        nextPaymentDate: item ? toIso(item.current_period_end) : now,
      }
    } catch (error) {
      throw mapStripeError(error)
    }
  }

  async changeSubscription(input: ChangeSubscriptionInput): Promise<BillingSubscription> {
    try {
      const subscription = await this.stripe.subscriptions.retrieve(input.subscriptionId)
      const item = subscription.items.data[0]
      if (!item) throw new Error(`Subscription ${input.subscriptionId} has no items to change`)
      const updated = await this.stripe.subscriptions.update(
        input.subscriptionId,
        {
          items: [{ id: item.id, price: input.newPriceId }],
          proration_behavior: 'create_prorations',
          // `default_incomplete` leaves the subscription in `past_due`/`incomplete` (never silently
          // `active`) when the immediate proration invoice fails to collect — matching the fake
          // provider's `sca_required` contract that a price change never silently succeeds.
          payment_behavior: 'default_incomplete',
        },
        { idempotencyKey: input.idempotencyKey },
      )
      return mapSubscription(updated)
    } catch (error) {
      throw mapStripeError(error)
    }
  }

  async cancelSubscription(input: CancelSubscriptionInput): Promise<BillingSubscription> {
    try {
      if (input.atPeriodEnd) {
        const updated = await this.stripe.subscriptions.update(input.subscriptionId, { cancel_at_period_end: true })
        return mapSubscription(updated)
      }
      const canceled = await this.stripe.subscriptions.cancel(input.subscriptionId)
      return mapSubscription(canceled)
    } catch (error) {
      throw mapStripeError(error)
    }
  }

  async getSubscription(subscriptionId: string): Promise<BillingSubscription | null> {
    try {
      const subscription = await this.stripe.subscriptions.retrieve(subscriptionId)
      return mapSubscription(subscription)
    } catch (error) {
      if (error instanceof Stripe.errors.StripeError && error.code === 'resource_missing') return null
      throw mapStripeError(error)
    }
  }

  async createSetupIntent(input: CreateSetupIntentInput): Promise<SetupIntentResult> {
    try {
      const customer = await this.stripe.customers.retrieve(input.customerId)
      if (customer.deleted) throw new Error(`Unknown Stripe customer: ${input.customerId}`)
      const defaultPaymentMethod = extractDefaultPaymentMethodId(customer)
      if (!defaultPaymentMethod) {
        throw new BillingProviderError('No default payment method on file to confirm off-session', 'decline')
      }
      const setupIntent = await this.stripe.setupIntents.create(
        {
          customer: input.customerId,
          payment_method: defaultPaymentMethod,
          confirm: true,
          // SetupIntents have no separate `off_session` confirm flag (unlike PaymentIntents) —
          // `usage: 'off_session'` is what signals this payment method must support a future
          // off-session charge; Stripe still returns `requires_action` here if the card needs 3DS.
          usage: 'off_session',
          // Restrict to immediate, non-redirect confirmation (mirrors checkout.ts's
          // APPROVED_IMMEDIATE_PAYMENT_METHOD_TYPES) — without this, Stripe defaults to whatever's
          // enabled in the Dashboard, which can include redirect-based methods that require a
          // `return_url` we have no on-session customer to redirect.
          payment_method_types: ['card'],
        },
        { idempotencyKey: input.idempotencyKey },
      )
      return mapSetupIntent(setupIntent)
    } catch (error) {
      if (error instanceof Stripe.errors.StripeError && isAuthenticationRequiredError(error) && error.setup_intent) {
        return mapSetupIntent(error.setup_intent)
      }
      throw mapStripeError(error)
    }
  }

  async createPaymentIntent(input: CreatePaymentIntentInput): Promise<BillingPaymentIntent> {
    try {
      const customer = await this.stripe.customers.retrieve(input.customerId)
      if (customer.deleted) throw new Error(`Unknown Stripe customer: ${input.customerId}`)
      const defaultPaymentMethod = extractDefaultPaymentMethodId(customer)
      if (!defaultPaymentMethod) {
        throw new BillingProviderError('No default payment method on file to confirm off-session', 'decline')
      }
      const paymentIntent = await this.stripe.paymentIntents.create(
        {
          customer: input.customerId,
          amount: input.amount,
          currency: input.currency,
          payment_method: defaultPaymentMethod,
          confirm: true,
          off_session: true,
          // Same rationale as createSetupIntent above — no on-session customer to redirect.
          payment_method_types: ['card'],
        },
        { idempotencyKey: input.idempotencyKey },
      )
      return mapPaymentIntent(paymentIntent)
    } catch (error) {
      if (error instanceof Stripe.errors.StripeError && isAuthenticationRequiredError(error) && error.payment_intent) {
        return mapPaymentIntent(error.payment_intent)
      }
      throw mapStripeError(error)
    }
  }

  async createRefund(input: CreateRefundInput): Promise<BillingRefund> {
    try {
      const refund = await this.stripe.refunds.create(
        { payment_intent: input.paymentIntentId, amount: input.amount },
        { idempotencyKey: input.idempotencyKey },
      )
      return mapRefund(refund)
    } catch (error) {
      throw mapStripeError(error)
    }
  }

  async refreshObject(type: RefreshableObjectType, id: string): Promise<unknown> {
    switch (type) {
      case 'customer': return this.getCustomer(id)
      case 'subscription': return this.getSubscription(id)
      case 'checkout_session': return this.getCheckoutSession(id)
      case 'payment_intent': {
        try {
          const paymentIntent = await this.stripe.paymentIntents.retrieve(id)
          return mapPaymentIntent(paymentIntent)
        } catch (error) {
          if (error instanceof Stripe.errors.StripeError && error.code === 'resource_missing') return null
          throw mapStripeError(error)
        }
      }
    }
  }

  async listForReconciliation(type: ReconciliationObjectType, options?: { since?: string }): Promise<unknown[]> {
    const createdFilter = options?.since ? { gte: Math.floor(new Date(options.since).getTime() / 1000) } : undefined
    try {
      switch (type) {
        case 'customers': {
          const results: BillingCustomer[] = []
          for await (const customer of this.stripe.customers.list({ created: createdFilter, limit: 100 })) {
            results.push(mapCustomer(customer))
          }
          return results
        }
        case 'subscriptions': {
          const results: BillingSubscription[] = []
          for await (const subscription of this.stripe.subscriptions.list({ created: createdFilter, status: 'all', limit: 100 })) {
            results.push(mapSubscription(subscription))
          }
          return results
        }
        case 'payment_intents': {
          const results: BillingPaymentIntent[] = []
          for await (const paymentIntent of this.stripe.paymentIntents.list({ created: createdFilter, limit: 100 })) {
            results.push(mapPaymentIntent(paymentIntent))
          }
          return results
        }
        case 'refunds': {
          const results: BillingRefund[] = []
          for await (const refund of this.stripe.refunds.list({ created: createdFilter, limit: 100 })) {
            results.push(mapRefund(refund))
          }
          return results
        }
      }
    } catch (error) {
      throw mapStripeError(error)
    }
  }
}
