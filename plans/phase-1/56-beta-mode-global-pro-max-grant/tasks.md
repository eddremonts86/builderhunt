# Beta Mode — Tasks

> **Status**: `pending`
> **Spec**: [`spec.md`](./spec.md)
> **Plan**: [`plan.md`](./plan.md)
> **Rule**: a task is complete only when its runtime verification passes AND the existing
> operator-grant path remains untouched. The flag is a floor, not a ceiling.

## Phase 0 — Migration + `system_flags` helper

- [ ] **Author `drizzle/0142_system_flags.sql`**
  - Files: `drizzle/0142_system_flags.sql`
  - Do: Create `system_flags (key text PRIMARY KEY, value jsonb NOT NULL, updated_at
    timestamptz NOT NULL DEFAULT now(), updated_by text REFERENCES auth_users(id))`. Add
    RLS allowing `builderhunt_app` to read every row and `builderhunt_platform` to
    upsert via a SECURITY DEFINER function (`set_system_flag(key, value, actor)`).
  - Verify: `pnpm db:migrate` applies cleanly; the table exists; the SECURITY DEFINER
    function returns the upserted row.

- [ ] **Add `system_flags` to the schema**
  - Files: `src/shared/lib/db/schema.ts`
  - Do: Export `systemFlagsTable` with typed columns matching the migration. Re-export
    the SECURITY DEFINER function name as a string constant for `platformDb` callers.
  - Verify: `pnpm type-check` clean.

- [ ] **Author `src/shared/lib/billing/beta-mode.ts`**
  - Files: `src/shared/lib/billing/beta-mode.ts`,
    `tests/unit/shared/lib/billing/beta-mode.test.ts`
  - Do: Typed `BetaModeFlag` interface. `getBetaModeFlag()` with Redis 60s cache
    fronting Postgres. `setBetaModeFlag(actor, enabled)` that writes the audit row,
    upserts the table, and invalidates Redis.
  - Verify: tests cover absent row, present row, cache hit, cache miss, audit row
    exists, Redis key invalidation, Redis-down falls back to Postgres with WARN.

## Phase 1 — `feature-authorization` floor

- [ ] **Add `tierRank` helper**
  - Files: `src/shared/lib/billing/feature-authorization.ts`
  - Do: `function tierRank(tier): number` mapping `free < pro < pro_max < team`. Used by
    the floor logic to compare without leaking strings.
  - Verify: `pnpm vitest run` green; new unit test pins the order.

- [ ] **Apply the floor in `requireFeature` and `hasFeature`**
  - Files: `src/shared/lib/billing/feature-authorization.ts`,
    `tests/unit/shared/lib/billing/feature-authorization.test.ts`
  - Do: At the top of each function, call `getBetaModeFlag()`. If `enabled` and the
    current `entitlement.tier` rank is below `pro_max`, replace with `pro_max` for the
    rest of the function.
  - Verify: existing tests still pass; new tests cover the four scenarios (free +
    on/off, team + on/off, requireFeature + smart-alerts in all four).

## Phase 2 — Credit-reservation floor

- [ ] **Apply the floor in `getCreditGrantForOrg`**
  - Files: `src/shared/lib/billing/reservations.ts`,
    `tests/unit/shared/lib/billing/reservations.test.ts`
  - Do: Read `getBetaModeFlag()`. If `enabled` and the org's effective tier is below
    `pro_max`, return the `pro_max_monthly` credit grant (700). Otherwise return the
    catalog's grant for the org's actual tier.
  - Verify: tests cover the four scenarios + reservation against 0-cap vs 700-cap.

- [ ] **Audit the existing annual-grants cycle**
  - Files: `src/shared/lib/billing/annual-grants.ts`
  - Do: Confirm the cycle calls `getCreditGrantForOrg`. If not, route it through.
  - Verify: `grep -n getCreditGrantForOrg src/shared/lib/billing/annual-grants.ts`
    shows the call.

## Phase 3 — Admin toggle UI

- [ ] **Author `BetaModeToggle` component**
  - Files: `src/modules/admin/components/BetaModeToggle.tsx`,
    `tests/unit/modules/admin/components/BetaModeToggle.test.tsx`
  - Do: Reads `getBetaModeFlag()`, renders the toggle, calls `setBetaModeFlag` on
    confirm, re-fetches. Disabled while pending.
  - Verify: tests cover render, disabled-while-pending, error path, confirm dialog.

- [ ] **Place the toggle on `/admin/billing`**
  - Files: `src/routes/_dashboard/admin/billing.tsx`
  - Do: Above the existing manual-grant section. The page already requires
    `requirePlatformAdminPrincipal` (existing code).
  - Verify: `pnpm vitest run` green; e2e login as platform admin and toggle the flag.

## Phase 4 — User-menu badge + telemetry

- [ ] **Add the badge to `UserMenu`**
  - Files: `src/shared/components/UserMenu.tsx`,
    `tests/unit/shared/components/UserMenu.test.tsx`
  - Do: Read `getBetaModeFlag()` and render a `Beta` icon when `enabled`. Tooltip on
    hover links to `/changelog` (or `/blog/<slug>` if a launch post exists).
  - Verify: tests cover present / absent / loading states.

- [ ] **Add the `beta-mode.flip` telemetry event**
  - Files: `src/shared/lib/dashboard/queue-telemetry.ts`,
    `tests/unit/security/queue-telemetry.test.ts`
  - Do: New entry in `QUEUE_TELEMETRY_KINDS` with payload `{ enabled: boolean,
    actorUserId, at }`. Strict schema; no organization list, no tier names.
  - Verify: telemetry tests cover the new event.

## Phase 5 — Verification report

- [ ] **Manual e2e test in the dev stack**
  - Files: `docs/operations/beta-mode-verification-<date>.md`
  - Do: Seed a `free` user; toggle the flag on; verify `/dashboard`, `/alerts`, and
    `/sprints` render with `pro_max` features; toggle off; verify the same user sees
    the Free plan prompt. Capture before/after for one assertion in the spec's
    Verification section.
  - Verify: the report lists every assertion; every assertion is met.

- [ ] **Close the plan**
  - Files: `plans/phase-1/56-beta-mode-global-pro-max-grant/`
  - Do: Update the `Status:` header in each of `spec.md`, `plan.md`, `tasks.md` to
    `closed` with a dated implementation note. Link the verification report.
  - Verify: every `[ ]` in `tasks.md` is checked; the plan header reflects the final
    state.
