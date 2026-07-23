# Stripe setup guide — BuilderHunt

Step-by-step to make a Stripe account compatible with the app's billing catalog
(`src/shared/lib/billing/catalog.ts`). Do the parts marked **you** in the Stripe
dashboard/CLI (they need your login and, for KYC, your personal data — which
must **never** be pasted into this repo); the provisioning script does the
catalog objects for you.

Order: create account (test) → get test key → provision catalog → configure Tax
& webhook → local end-to-end test → KYC → provision live → go-live gates.

---

## 0. What the app expects

| Catalog key | Product | Price | Interval | Tax |
| --- | --- | --- | --- | --- |
| `pro_monthly` | Pro | $19.00 | month | exclusive |
| `pro_annual` | Pro | $182.00 | year | exclusive |
| `pro_max_monthly` | Pro Max | $79.00 | month | exclusive |
| `pro_max_annual` | Pro Max | $758.00 | year | exclusive |
| `team_monthly` | Team | $199.00 | month | exclusive |
| `team_annual` | Team | $1,910.00 | year | exclusive |
| `starter_300` | Credits 300 | $15.00 | one-time | exclusive |
| `scale_1000` | Credits 1000 | $45.00 | one-time | exclusive |
| `max_5000` | Credits 5000 | $299.00 | one-time | exclusive |

All USD, tax-behavior **exclusive**, no BuilderHunt-side currency conversion.
Clients only ever send a catalog key; the server resolves the Stripe Price ID.

---

## 1. Create the Stripe account (you)

1. Go to <https://dashboard.stripe.com/register> and sign up with a monitored
   business inbox (this becomes the support/refund contact).
2. Country: **Denmark**. Business type: **Individual** (matches the launch
   register's seller classification). You can stay in **test mode** for
   everything up to §7 — no KYC needed yet.
3. You now have test API keys. Leave live activation for §7.

## 2. Get the test secret key (you)

Dashboard → **Developers → API keys** (test mode toggle on) → reveal the
**Secret key** (`sk_test_...`). Do not commit it. Put it in `.env`:

```dotenv
STRIPE_BILLING_ENABLED=false          # keep false until §7 gates pass
STRIPE_SECRET_KEY=sk_test_...
STRIPE_API_VERSION=2026-06-24.dahlia  # exact version stripe@22.3.2 pins
STRIPE_WEBHOOK_SECRET=                # filled in §5
```

`STRIPE_API_VERSION` must be `2026-06-24.dahlia` — that's what the installed SDK
(`stripe@22.3.2`), the webhook endpoint, and the test fixtures all share.

## 3. Provision the catalog (script)

From the repo root, on your Mac:

```bash
# 1) See exactly what would be created — calls nothing:
pnpm stripe:provision --dry-run

# 2) Create the 6 subscription prices + 3 packs in TEST, then validate:
STRIPE_SECRET_KEY=sk_test_... pnpm stripe:provision

# 3) Paste the resulting Price IDs into catalog.ts (test column):
STRIPE_SECRET_KEY=sk_test_... pnpm stripe:provision --write
git diff src/shared/lib/billing/catalog.ts   # review before committing
```

What it does: one Product per tier (`bh_sub_pro/_max/_team`) and one per pack,
each Price tagged with a `lookup_key` = the catalog key and `tax_behavior:
'exclusive'`, USD, correct interval, plus catalog metadata. It is **idempotent**
— re-running validates existing objects and refuses to mutate anything whose
amount/currency/interval/product/tax/active-state diverges from `catalog.ts`
(this is the plan's "Validate Stripe Products and Prices before mutation" gate).
Use `--validate` to check without ever creating.

If a price ever needs to change: don't edit it in Stripe. Archive the old Price,
bump the catalog entry's `version`, and re-run — existing subscribers keep their
old Price until their next eligible renewal (≥30 days' notice).

## 4. Configure Stripe Tax (you)

1. Dashboard → **Settings → Tax** → enable **Stripe Tax**.
2. Add a tax **registration** for **Denmark** (the only launch country). Add
   others only after VAT/OSS registration — see the launch register.
3. Confirm the product **tax code**: the script sets `txcd_10103000` (SaaS —
   business use). If your accountant prefers a different code, change `TAX_CODE`
   in `scripts/billing/provision-stripe-catalog.ts` and re-run.
4. Set the **statement descriptor** (Settings → Public details) to something
   like `BUILDERHUNT` — shown on customers' card statements, must not mislead.

## 5. Webhook endpoint + secret (you + script)

**Local development** (Stripe CLI):

```bash
stripe login
stripe listen --forward-to localhost:3000/api/webhooks/stripe
# copy the whsec_... it prints into STRIPE_WEBHOOK_SECRET in .env
```

**Deployed environments:** Dashboard → **Developers → Webhooks → Add endpoint**,
URL `https://<your-domain>/api/webhooks/stripe`, API version
`2026-06-24.dahlia`. Subscribe at least to: `checkout.session.completed`,
`customer.subscription.created/updated/deleted`, `invoice.paid`,
`invoice.payment_failed`, `charge.refunded`, `charge.dispute.created`. Copy that
endpoint's signing secret (`whsec_...`) into `STRIPE_WEBHOOK_SECRET`.

## 6. Local end-to-end test (you)

1. Set `STRIPE_BILLING_ENABLED=true` in your local `.env` (local only).
2. `pnpm dev`, run a checkout with test card `4242 4242 4242 4242`.
3. Confirm the webhook is received and the credit ledger updates.
4. Keep `STRIPE_BILLING_ENABLED=false` in shared/staging until §7.

## 7. Go live (you) — only after every gate below

1. **KYC:** Dashboard → activate your account (business details, identity). Your
   personal ID/address/bank data go **only** into Stripe here — never into this
   repo or the launch register. Wait for `charges_enabled = true`.
2. Confirm CVR and, if adding any non-Denmark country later, VAT/OSS.
3. Get the **live** secret key (`sk_live_...`), set it only in production
   (`NODE_ENV=production` — the app rejects a live key anywhere else).
4. Provision the live catalog and patch the live column:
   ```bash
   STRIPE_SECRET_KEY=sk_live_... pnpm stripe:provision --allow-live --write
   ```
   (`--allow-live` is required; without it the script refuses a live key.)
5. Work through the release-gate checklist in
   `docs/operations/stripe-launch-register.md` — KYC, tax registrations,
   Terms/Privacy versions, support contact, reconciliation, runbooks, and the
   one-real-Danish-customer canary must all have evidence before flipping
   `STRIPE_BILLING_ENABLED=true` in production.

---

## Quick reference

| Variable | Value |
| --- | --- |
| `STRIPE_API_VERSION` | `2026-06-24.dahlia` |
| Webhook path | `/api/webhooks/stripe` |
| Provision (test) | `STRIPE_SECRET_KEY=sk_test_... pnpm stripe:provision` |
| Provision + patch | `… pnpm stripe:provision --write` |
| Validate only | `… pnpm stripe:provision --validate` |
| Provision (live) | `STRIPE_SECRET_KEY=sk_live_... pnpm stripe:provision --allow-live --write` |

**Never** commit a secret key or put CPR / home address / bank / card numbers in
this repo. Those live only inside Stripe.
