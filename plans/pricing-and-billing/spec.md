# Feature: Pricing & Billing (Stripe)

## Problem

BuilderHunt hoy es 100% gratis sin modelo de monetización. Para crear una empresa necesitas revenue. Sin pricing:

1. **No podés pagar hosting, dominios, Sentry, Resend, etc.** a escala
2. **No hay alignment con el usuario**: los free riders se van a frustrar cuando llegue el momento de cobrar
3. **No podés invertir en growth** sin revenue
4. **Sin plan limits**, los heavy users pueden abusar (correr 1000 saved queries × infinite scroll = API bills enormes)

## Goal

Pricing tiers simples con Stripe como payment processor:

| Tier       | Precio     | Destinado a                         | Límites                          |
|------------|-----------|-------------------------------------|----------------------------------|
| **Free**    | $0         | Curiosos, devs que exploran        | 3 saved searches, 50 saved builders, RSS público |
| **Pro**     | $19/mo    | Recruiters / founders activos       | 50 saved searches, unlimited saved builders, smart alerts, semantic search, code fingerprinting |
| **Team**    | $99/mo    | Equipos de sourcing (3-10 seats)   | Todo Pro + team-synergy, work-sample, shared lists |

**Anual: 20% off** ($182/yr Pro, $950/yr Team)

## Non-goals

- **No es enterprise SSO.** v1 — el team plan asume shared login o Google OAuth
- **No es self-serve B2B contracts.** Sales-led solo si Team > 10 seats
- **No es metered pricing.** Hard caps, no "pay per search"
- **No es multi-currency.** USD v1
- **No es tax-inclusive.** Stripe Tax v2

## Pricing strategy (why these numbers)

- **$19/mo Pro**: alineado con productos similares (Hunter.io $49, Snov.io $39, Apollo $49). $19 es el sweet spot para un indie dev / solo recruiter que necesita 2-3 features clave.
- **$99/mo Team**: alineado con Team tiers de Linear ($8/seat), Pitch ($25/seat for 5+). 5 seats incluidos, $20/seat adicional.
- **Anual 20% off**: estándar SaaS; mejora LTV/cash ratio.

## User stories

1. **Como free user**, quiero ver mis límites actuales claramente y saber qué obtengo al upgrade
2. **Como usuario en el límite de saved searches**, quiero un paywall que me diga exactamente qué gano con Pro
3. **Como paid user**, quiero gestionar mi suscripción (cancel, upgrade, change card)
4. **Como team admin**, quiero invitar miembros, asignar roles, gestionar billing
5. **Como paid user en trial**, quiero un countdown y un email reminder antes de que termine

## Data model

**New table: `subscriptions`**

```sql
CREATE TABLE subscriptions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES auth_users(id) UNIQUE,
  stripe_customer_id text NOT NULL,
  stripe_subscription_id text,
  plan text NOT NULL,  -- 'free' | 'pro' | 'team'
  status text NOT NULL, -- 'active' | 'trialing' | 'past_due' | 'canceled'
  current_period_end timestamp with time zone,
  cancel_at_period_end boolean DEFAULT false,
  trial_ends_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE INDEX idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX idx_subscriptions_stripe_customer_id ON subscriptions(stripe_customer_id);
```

**New table: `team_memberships`** (Team plan)

```sql
CREATE TABLE team_memberships (
  id text PRIMARY KEY,
  team_owner_id text NOT NULL REFERENCES auth_users(id),
  member_id text NOT NULL REFERENCES auth_users(id),
  role text NOT NULL DEFAULT 'member',  -- 'owner' | 'admin' | 'member'
  created_at timestamp with time zone DEFAULT now(),
  UNIQUE(team_owner_id, member_id)
);
```

## UX flow

### Pricing page (`/pricing`)

- **3 tier cards** side by side
- Free card: "Current plan" if applicable
- Pro/Team cards: "Get Pro" / "Start free trial" CTA
- Bottom: comparison table with all features
- FAQ section: "Can I cancel anytime?", "What happens to my saved builders if I downgrade?"

### Upgrade modal (in-app paywall)

When user hits a limit:
```
┌──────────────────────────────────────────────┐
│  You've used all 3 saved searches.            │
│                                              │
│  Pro gives you:                              │
│  ✓ 50 saved searches                         │
│  ✓ Unlimited saved builders                  │
│  ✓ Smart email alerts                        │
│  ✓ Semantic search                           │
│  ✓ Code fingerprinting                       │
│                                              │
│  [ Start 14-day free trial ]                 │
│  [ Maybe later ]                             │
└──────────────────────────────────────────────┘
```

### Stripe checkout

- Click "Get Pro" → redirect to Stripe Checkout (hosted, PCI-compliant)
- Webhook updates `subscriptions` table on `customer.subscription.*` events
- User redirected to `/dashboard?upgraded=1` with success toast

### Customer portal

- `/settings/billing` — view current plan, manage subscription via Stripe Customer Portal link
- Cancel, update card, download invoices — all via Stripe's hosted portal

## Enforcement (server-side)

**Hard limits enforced in API:**

```ts
const FREE_LIMITS = { savedSearches: 3, savedBuilders: 50 }
const PRO_LIMITS = { savedSearches: 50, savedBuilders: Infinity }

async function checkLimit(userId, resource) {
  const sub = await getSubscription(userId)
  const limits = sub.plan === 'pro' || sub.plan === 'team' ? PRO_LIMITS : FREE_LIMITS
  const current = await countResource(userId, resource)
  return current < limits[resource]
}
```

**Resources affected:**
- POST /api/queries — check savedSearches limit
- POST /api/builders (save) — check savedBuilders limit
- /api/recommendations — only Pro+ sees the "For you" section
- /api/alerts (smart alerts, when implemented) — Pro+ only
- /api/semantic-search — Pro+ only
- RSS feeds — Free, public; Pro+ get rich content
- Code fingerprinting — Pro+ only
- Project hygiene signals — Pro+ only

**Soft limits** (warning, not blocked): exports > 100 builders, saved searches > 10

**No enforcement needed for:**
- Public read endpoints (search, profile pages)
- RSS feeds (public by design)
- Auth

## Webhook events

```ts
// POST /api/stripe/webhook
async function handleWebhook(event) {
  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      await upsertSubscription(event.data.object)
      break
    case 'customer.subscription.deleted':
      await markCanceled(event.data.object)
      break
    case 'invoice.paid':
      await extendPeriod(event.data.object)
      break
    case 'invoice.payment_failed':
      await markPastDue(event.data.object)
      break
  }
  return new Response('ok')
}
```

## Success metrics

- **Primary**: Free → Pro conversion rate. Target: 3% within 30 days of launch
- **Secondary**: MRR (monthly recurring revenue). Target: $1k MRR by month 2, $10k by month 6
- **Tertiary**: Churn rate. Target: < 5% monthly
- **Guardrail**: % of users who hit the free limit and bounce (without upgrading). Target: < 50% (if too high, the limits are too aggressive)

## Out of scope (v1)

- Multi-currency
- Tax compliance (Stripe Tax)
- Annual plan auto-renewal emails (Stripe handles)
- Custom team plans (>10 seats, sales-led)
- Coupons / promo codes (Stripe handles, but no UI)
- Refund handling (manual via Stripe dashboard)

## Open questions

- **Free tier limits**: 3 saved searches seems low. Should it be 5? Trade-off: lower = more conversions; higher = less pressure to upgrade.
- **Trial length**: 14 days is standard. 7 days forces faster conversion. 30 days is generous.
- **Team plan seats**: 5 included, $20/extra? Or 3 + $25/extra?

## Dependencies

- New package: `stripe` (Node SDK)
- New env var: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID_PRO_MONTHLY`, `STRIPE_PRICE_ID_PRO_ANNUAL`, `STRIPE_PRICE_ID_TEAM_MONTHLY`
- New tables: `subscriptions`, `team_memberships`
- Schema migrations: 2 new tables

## Estimated effort

| Phase | Effort |
|-------|--------|
| 1 — Data model + Stripe SDK | S (3-4h) |
| 2 — Pricing page UI | S (3-4h) |
| 3 — Checkout + webhooks | M (4-6h) |
| 4 — Limit enforcement | M (4-6h) |
| 5 — Customer portal + settings | S (2-3h) |
| 6 — Team plan (members, roles) | M (4-6h) |
| **Total** | **~3-4 days** |
