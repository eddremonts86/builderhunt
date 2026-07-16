# Feature: Pricing & Plans (Admin-Managed, No Paid Services)

## Scope (v1: bootstrap mode)

**No external paid services.** No Stripe, no Paddle, no Lemonsqueezy.

v1 uses **admin-managed plans**: an admin flips a switch in the DB to upgrade/downgrade a user. Real billing integrations come later when there's revenue to pay for them.

This is intentional: at 0 paying customers, integrating a payment processor is a multi-day investment that doesn't pay back. We can validate the tier model with manual plan grants first, then automate when volume justifies it.

## Tiers (same as the original plan)

| Tier       | Price     | Audience                         | Limits                          |
|------------|-----------|----------------------------------|----------------------------------|
| **Free**    | $0         | Curious, exploring              | 3 saved searches, 50 saved builders, basic RSS |
| **Pro**     | $19/mo    | Active recruiters/founders       | 50 saved searches, unlimited builders, smart alerts, semantic search, code fingerprinting |
| **Team**    | $99/mo    | Sourcing teams (3-10 seats)     | Everything in Pro + team-synergy, work-sample, shared lists |

## How users actually upgrade (v1)

1. User clicks "Get Pro" on `/pricing`
2. Modal: "Contact us at hello@builderhunt.dev to upgrade"
3. Admin sees the request (logged in DB), confirms payment manually (bank transfer, crypto, whatever)
4. Admin goes to `/admin/users`, finds the user, sets their `plan` to `pro` and `plan_ends_at` to now + 30 days
5. User's session refreshes, sees Pro features unlocked

When volume justifies it (50+ paying customers or $1k MRR), we integrate Stripe and automate the upgrade flow.

## Data model

**New table: `plans`** (subscription state per user)

```sql
CREATE TABLE plans (
  user_id text PRIMARY KEY REFERENCES auth_users(id),
  plan text NOT NULL DEFAULT 'free',  -- 'free' | 'pro' | 'team'
  status text NOT NULL DEFAULT 'active',  -- 'active' | 'past_due' | 'canceled'
  plan_ends_at timestamp with time zone,
  trial_ends_at timestamp with time zone,
  notes text,  -- admin notes (e.g., "paid via bank transfer 2026-08")
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);
```

**New table: `plan_changes`** (audit log)

```sql
CREATE TABLE plan_changes (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES authUsers(id),
  from_plan text,
  to_plan text NOT NULL,
  changed_by text NOT NULL,  -- userId of admin who made the change
  reason text,
  created_at timestamp with time zone DEFAULT now()
);
```

**New table: `plan_requests`** (user clicks "Get Pro" — admin sees a queue)

```sql
CREATE TABLE plan_requests (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES authUsers(id),
  requested_plan text NOT NULL,  -- 'pro' | 'team'
  status text NOT NULL DEFAULT 'pending',  -- 'pending' | 'approved' | 'declined'
  message text,
  created_at timestamp with time zone DEFAULT now()
);
```

**New env var**: `ADMIN_USER_IDS` (comma-separated list of user IDs that can access /admin)

## Limits enforcement

Same as the original plan, but enforced server-side via a `checkLimit()` helper:

```ts
// src/shared/lib/limits.ts
const FREE_LIMITS = { savedSearches: 3, savedBuilders: 50, rssSubscriptions: 3 }
const PRO_LIMITS = { savedSearches: 50, savedBuilders: Infinity, rssSubscriptions: Infinity }
const TEAM_LIMITS = PRO_LIMITS // same as Pro for v1

export async function checkLimit(userId, resource) {
  const plan = await getUserPlan(userId)
  const limits = plan === 'team' ? TEAM_LIMITS : plan === 'pro' ? PRO_LIMITS : FREE_LIMITS
  const current = await countResource(userId, resource)
  return { allowed: current < limits[resource], current, limit: limits[resource], plan }
}
```

**Resources affected**:
- POST `/api/queries` — savedSearches limit
- POST `/api/builders/:id/save` — savedBuilders limit
- RSS subscriptions — rssSubscriptions limit
- Smart alerts — Pro+ only
- Code fingerprinting — Pro+ only
- Team-synergy — Team only

## API endpoints

- `GET /api/plans/me` — current user's plan
- `POST /api/plans/request-upgrade` — user requests upgrade (creates `plan_request`)
- `GET /api/admin/plan-requests` — admin sees queue
- `POST /api/admin/plans/:userId` — admin sets plan (creates `plan_changes` entry)
- `GET /api/admin/users` — list users with their plans
- `GET /api/admin/plans` — all subscriptions

## UX

### /pricing (public)

- 3 tier cards
- Monthly/Annual toggle
- Free card: "Current plan" if applicable
- Pro/Team cards: "Get Pro" / "Contact us" button (mailto or modal)
- Comparison table
- FAQ

### /admin (admin only, gated by `ADMIN_USER_IDS` env)

- `/admin/users` — table of all users with their current plan
  - Click user → modal to set plan
- `/admin/plan-requests` — pending upgrade requests, with user contact info
- `/admin/incidents`, `/admin/changelog` — other admin tasks (separate plan)

## Migration path (when ready to add Stripe)

The `plans` table is already shaped to match what Stripe would sync:
- `status` = Stripe `subscription.status`
- `plan_ends_at` = Stripe `current_period_end`
- `plan` = Stripe `price.lookup_key`

When Stripe is added later:
- Add a `stripe_customer_id` and `stripe_subscription_id` column
- Webhook updates the same `plans` table
- Admin UI is unchanged
- Manual `POST /api/admin/plans/:userId` is replaced with auto-sync

The limits enforcement and UI work today; only the billing integration is deferred.

## Success metrics

- **Primary**: Free → Pro conversion (admin-granted). Track in `plan_changes`.
- **Secondary**: # of plan_requests per week (proxy for "intent to pay")
- **Tertiary**: Churn (# of `pro` users downgraded back to `free` in a month)

## Out of scope (v1)

- Self-serve payment (no Stripe)
- Subscription auto-renewal (admin renews manually)
- Tax compliance
- Coupons / promo codes
- Refund handling

## Open questions

- **How do we price in v1 if we can't take money?** Validation: do people upgrade when we ask them to email us? This is the real test.
- **Should we use Stripe Atlas to incorporate?** That's a separate plan (legal-and-compliance).

## Estimated effort: 1-2 days (much less than the Stripe version)
