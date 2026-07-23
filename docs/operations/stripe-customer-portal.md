# Stripe Customer Portal: Configuration and Scope

## What the Portal is for here

spec.md: "Customer Portal is owner-only and limited to payment methods, tax identity, invoices, and
receipts. All plan changes/cancellation remain BuilderHunt-owned." The Portal exists purely as a
Stripe-hosted surface for account-and-payment housekeeping — it is never how an organization changes
tier, interval, or cancels. Every plan-change/cancellation flow lives in this app's own
subscription-change endpoints (plans/stripe-billing-platform/tasks.md §7), not the Portal.

## What our code does and does not control

`src/shared/lib/billing/portal.ts`'s `createBillingPortalSession` controls:

- **Who** can open a session: owner-only, and only with a recent sign-in (`'billing:portal'` is one
  of `permissions.ts`'s `RECENT_AUTH_REQUIRED_BILLING_ACTIONS` — a hijacked long-lived session cannot
  open the Portal without a fresh authentication).
- **Where** the browser returns after the Portal: `returnUrl` must resolve to this app's own origin
  (`isAllowedReturnUrl`, `stripe-client.ts` — an exact origin match, not a string-prefix check, which
  would be bypassable by a lookalike host like `https://app.example.com.evil.com`).
- **Which customer**: resolved server-side from the authenticated organization's own
  `billing_customers` row — never a client-supplied customer id.

It does **not** control which Portal *features* are enabled (payment methods, tax ID, invoice
history, subscription cancellation, plan switching, etc.) — that is a property of the Stripe Billing
Portal **Configuration** itself, set in the Stripe Dashboard (Settings → Billing → Customer portal)
or via a specific Configuration id our code would pass to `stripe.billingPortal.sessions.create()`.
Our application code cannot introspect or enforce this from the outside; a Portal session created
against a permissive Configuration would let a customer do things spec.md explicitly reserves for
BuilderHunt (change plan, cancel), regardless of what our own owner-only/recent-auth checks do.

## The manual gate

Because the Configuration lives entirely on Stripe's side, `readiness.ts`'s
`portalConfigurationRestricted` gate is a **manual attestation**, not a computed check — the same
shape as `termsPrivacyVersionsConfirmed`/`operatorRunbooksConfirmed`. Before `STRIPE_BILLING_ENABLED`
is ever set to `true` against a live key, an operator must:

1. Open the Stripe Dashboard's Billing Portal configuration (test mode first, then live).
2. Confirm the customer update section allows **only**: payment methods, tax ID (billing
   information), and invoice history/receipts.
3. Confirm **subscription cancellation is disabled** and **no products/prices are configured for
   switching** (the "Update subscriptions" feature should have no products listed, or be off
   entirely).
4. Save that state, then run:
   ```sh
   pnpm billing:check-readiness --live --confirm-portal-configuration ...
   ```
   Passing this flag without having actually completed the steps above defeats the point of the gate
   — see `docs/operations/stripe-live-readiness.md`.

Re-verify after any Stripe Dashboard change to the Billing Portal configuration — Stripe does not
version these, so a permissive edit here is invisible to this app's own tests.

## Sandbox verification (what our own tests do check)

`src/shared/lib/billing/portal.test.ts` and `src/routes/api/billing/portal.test.ts` verify everything
that *is* under this codebase's control against the deterministic fake provider:

- Owner with a recent sign-in can open a session; admin/member get `403`; a stale session gets `401`.
- `createBillingPortalSession`'s result is `{ url }` only — never a plan/price/product field, so
  there is nothing in our own response shape a client could use to infer or drive a plan change.
- A `returnUrl` outside this app's origin — including a lookalike host that merely *starts with* our
  own domain — is rejected before any provider call.
- Opening the Portal before the organization has ever had a Stripe customer created fails cleanly
  (`no_customer`), rather than creating one implicitly (Portal access is never how a Customer gets
  provisioned — Checkout is, in `billing/customers.ts`'s `ensureBillingCustomer`).

What these tests cannot verify: that a real Stripe sandbox Portal session, opened with the actual
Configuration in use, refuses a plan change or cancellation click. That is exactly what the manual
gate above exists to cover — it is inherently outside what a fake in-memory provider can simulate.
