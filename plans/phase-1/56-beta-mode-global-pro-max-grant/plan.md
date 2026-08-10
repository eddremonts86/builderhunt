# Beta Mode — Delivery Plan

> **Status**: `pending`

## Delivery principles

1. **One toggle, one place.** The flag is a single boolean in `system_flags`. Every
   feature check reads it; nothing else writes it.
2. **Floor, not ceiling.** The flag raises the effective tier to `pro_max` but never
   above an existing operator-grant tier. `team` stays `team`.
3. **Reversible, audited.** Every toggle writes a `security_audit_events` row. The
   existing audit page surfaces it.
4. **No UI redesign.** The toggle lives on `/admin/billing`; the user-menu badge is
   one icon swap.

## Dependency map

```
A ["Phase 0: migration + system_flags helper"] --> B ["Phase 1: feature-authorization floor"]
B --> C ["Phase 2: credit-reservation floor"]
C --> D ["Phase 3: admin toggle UI"]
D --> E ["Phase 4: user-menu badge + telemetry"]
E --> F ["Phase 5: verification report"]
```

## Phase 0 — Migration + `system_flags` helper

### Outcome

A migration creates `system_flags`. A typed helper `getBetaModeFlag()` reads the flag with
a Redis cache front. The helper returns `null` (flag absent) or the typed flag value.

### Work

- Author `drizzle/0142_system_flags.sql`. One table, one row expected.
- Add `system_flags` to `src/shared/lib/db/schema.ts` (typed Drizzle export).
- Author `src/shared/lib/billing/beta-mode.ts` exporting:
  - `interface BetaModeFlag { enabled: boolean; tier: 'pro_max'; creditGrant:
    'pro_max_monthly'; sprintCap: 10; auditEventId: string | null }`
  - `getBetaModeFlag(): Promise<BetaModeFlag | null>` — Redis cache (60s TTL) fronting
    Postgres.
  - `setBetaModeFlag(actor: string, enabled: boolean): Promise<BetaModeFlag>` — atomic
    upsert + audit row + Redis invalidation.
- The helper does **not** touch `organization_entitlements`. It is read-only on the
  catalog.
- Tests: `tests/unit/shared/lib/billing/beta-mode.test.ts` covers:
  - read with flag absent returns `null`,
  - read with flag present returns the typed value,
  - cache hit returns the same value within TTL,
  - cache miss re-reads from Postgres,
  - write creates an audit row,
  - write invalidates the Redis key,
  - Redis-down falls back to direct Postgres read with a WARN log.

### Verify

`pnpm type-check` clean. `pnpm vitest run tests/unit/shared/lib/billing/beta-mode.test.ts`
green. The migration applies cleanly against the dev DB.

## Phase 1 — `feature-authorization` floor

### Outcome

`requireFeature` and `hasFeature` (both in
`src/shared/lib/billing/feature-authorization.ts`) read the flag and apply the floor.

### Work

- At the top of `requireFeature` and `hasFeature`, call `getBetaModeFlag()`. If
  `enabled` and the current `entitlement.tier` is below `pro_max`, replace with `pro_max`
  for the rest of the function.
- Add a `tierRank` helper that orders `free < pro < pro_max < team`. Used to compare
  without leaking strings into the entitlement check.
- Keep the existing per-organization entitlement logic untouched. The flag is **a
  floor**: it raises the effective tier, never lowers it. A partner on `team`
  continues to read `team`.
- Tests: extend
  `tests/unit/shared/lib/billing/feature-authorization.test.ts` with:
  - free + flag-on → effective `pro_max`,
  - free + flag-off → effective `free`,
  - team + flag-on → effective `team` (unchanged),
  - team + flag-off → effective `team` (unchanged),
  - free + flag-on + `requireFeature('smart-alerts')` → `ok`,
  - free + flag-off + `requireFeature('smart-alerts')` →
    `FeatureBillingError`.

### Verify

`pnpm vitest run` green. E2E: sign-in as a `free` user with flag-on in `/admin/billing`,
navigate to `/alerts`, confirm the inbox renders. Flip flag off, confirm inbox
renders the "Free plan upgrade" prompt instead.

## Phase 2 — Credit-reservation floor

### Outcome

`reservation` and `consumption` paths (in
`src/shared/lib/billing/reservations.ts`) honour the floor. A `free` user with flag-on
gets `700` credits/month, not `0`.

### Work

- `getCreditGrantForOrg(orgId)` calls `getBetaModeFlag()` and returns the flag's
  `creditGrant` key (`pro_max_monthly` → 700) when the flag is on AND the org's
  effective tier is below `pro_max`. Otherwise returns the catalog's grant for the
  org's actual tier.
- The existing cycle (`src/shared/lib/billing/annual-grants.ts`) continues to call
  `getCreditGrantForOrg`. The cycle does not need to change.
- Tests: `tests/unit/shared/lib/billing/reservations.test.ts`:
  - free + flag-on → grant 700,
  - free + flag-off → grant 0,
  - pro + flag-on → grant unchanged (already higher),
  - team + flag-on → grant unchanged (already higher),
  - flag-on, free → reservations against the 700-cap succeed,
  - flag-off, free → reservations against the 0-cap fail with
    `CreditExhaustedError`.

### Verify

`pnpm vitest run` green. E2E: sign-in as a `free` user with flag-on, run an
AI-sourcing sprint, confirm the sprint is created (it would 4xx today without the
flag).

## Phase 3 — Admin toggle UI

### Outcome

A single toggle row on `/admin/billing`. One click. Confirm dialog before flipping. A
last-changed timestamp + actor.

### Work

- Author `src/modules/admin/components/BetaModeToggle.tsx`. It reads the flag via
  `getBetaModeFlag()`, renders the toggle, calls `setBetaModeFlag` on confirm, and
  re-fetches.
- Place the toggle above the existing manual-grant section on
  `/admin/billing`. The page is the natural home (admin-only, billing-aware).
- The confirm dialog says:
  - On: "Beta mode will give every signed-in user Pro Max with 700 credits/month
    and 10 concurrent sprints. Existing operator grants (e.g., team) are
    preserved. [Continue]"
  - Off: "Beta mode will revert every user to their existing entitlement. Any
    pack credits they bought remain. [Continue]"
- Tests:
  `tests/unit/modules/admin/components/BetaModeToggle.test.tsx` covers the render,
  the disabled-while-pending state, and the error path.

### Verify

`pnpm vitest run` green. E2E: log in as platform admin, navigate to `/admin/billing`,
toggle the flag, observe the flag's effect on a `free` user's `/dashboard`. Flip
back, observe the revert.

## Phase 4 — User-menu badge + telemetry

### Outcome

When the flag is on, every signed-in user's top-bar shows a small `Beta` badge. The
badge links to `/changelog` (or `/blog/<post>` if a launch post exists). Telemetry
records beta-mode flips with an allowlisted payload.

### Work

- `src/shared/components/UserMenu.tsx` reads `getBetaModeFlag()` and renders the
  badge when `enabled`. The badge is a tooltip-accessible icon, not a banner.
- A new telemetry event `beta-mode.flip` is recorded on every toggle. The payload
  contains only `enabled: boolean`, `actorUserId`, `at`. No organization list, no
  tier names — telemetry is privacy-safe per the existing `queue-telemetry.ts` rules.
- Tests:
  - `tests/unit/shared/components/UserMenu.test.tsx` covers the badge present /
    absent / loading states.
  - extend `tests/unit/security/queue-telemetry.test.ts` with the `beta-mode.flip`
    case.

### Verify

`pnpm vitest run` green. The badge renders only when the flag is on. E2E confirms
the badge appears within the cache TTL (≤ 60s) of a toggle.

## Phase 5 — Verification report

### Outcome

`docs/operations/beta-mode-verification-<date>.md` documents:

- the toggle's path,
- the audit row's shape,
- before/after feature checks for one `free` user (smart-alerts, AI sprint, export),
- the credit-grant comparison (free 0 → flag-on 700),
- the rollback procedure (`psql -c "UPDATE system_flags SET value = '{}' WHERE key =
  'tier.beta-mode'"`).

### Work

- Manual e2e test in the dev stack with a `free` user.
- Capture the metrics in a single dated markdown file.
- Link it from the plan's Status header.

### Verify

The file exists, lists every assertion from the spec's Verification section, and the
status flips to `closed`.

## Order of commits

```
feat(db): system_flags table + typed helper
feat(billing): feature-authorization honours beta-mode floor
feat(billing): credit reservation honours beta-mode floor
feat(admin): beta-mode toggle on /admin/billing
feat(ui): user-menu badge + telemetry event
docs(beta-mode): verification report
```

6 commits, all reversible on their own. The first commit (schema + helper) is the
largest; the rest are small and surgical.

## Risks

1. **Cache staleness.** A 60-second Redis TTL means the badge and feature checks can
   lag up to 60s after a toggle. This is acceptable for an admin-set flag. Mitigation:
   the toggle path explicitly invalidates the Redis key; the lag is between admin
   clicking and the cache expiry, not between admin clicking and the system
   recognizing it.
2. **Operator-grant interaction.** A partner on `team` keeps `team` when the flag is on.
   If the admin downgrades the partner to `free` manually, then the flag raises
   them back to `pro_max`. The plan documents this as the spec's "floor, not
   ceiling" semantics; if the maintainer disagrees, the rank comparison flips
   in one commit.
3. **Pack credits vs monthly grant.** When the flag turns off, pack credits remain
   (they are stored in `billing_credit_grants` independently). A user who had
   flag-on + 700 monthly + 0 packs → flag-off + 0 monthly + 0 packs. A user
   who had flag-on + 700 monthly + 500 packs → flag-off + 0 monthly + 500 packs.
   The latter is fine; the credit ledger handles the delta.
4. **Beta-testers churn.** When the flag turns off, beta-testers see the Free plan.
   Plan `phase-1/30-stripe-billing-platform` is the long-term answer (real Stripe
   checkout). The plan author notes this dependency in the spec.

## Rollback

Each phase is a single commit. `git revert <commit-hash>` returns to the prior state.
Phase 0's migration is additive — the table can be left empty without breaking
anything (the helper returns `null` when the row is absent). The fastest rollback is
`git revert <commit-of-phase-3>` (the UI commit) and `psql -c "DELETE FROM
system_flags WHERE key = 'tier.beta-mode'"`. Every feature check returns to the
per-organization entitlement unchanged.
