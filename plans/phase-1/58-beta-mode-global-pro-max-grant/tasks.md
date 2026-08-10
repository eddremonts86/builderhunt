# Beta Mode — Global Pro Max Access and Credits Tasks

> **Status**: `pending — implementation-ready`
> **Spec**: [`spec.md`](./spec.md)
> **Plan**: [`plan.md`](./plan.md)
> **Execution rule**: work top to bottom. Keep a task open until its focused red/green cycle and
> Verify command pass. Do not close the plan from source inspection alone.

## Phase 0 — Global state and administration

- [ ] **Add the singleton platform setting through a generated migration**
  - Files: `src/shared/lib/db/schema.ts`, the next `drizzle/*_platform_beta_mode.sql` migration and
    matching snapshot assigned by Drizzle, `drizzle/meta/_journal.json`, `drizzle/migration-hashes.json`,
    `tests/unit/shared/lib/db/beta-mode-schema.test.ts`, and
    `tests/unit/shared/lib/db/migration-integrity.test.ts` only if its asserted count requires the
    new migration.
  - Do: First write a failing schema/security test for a `platformBetaMode` Drizzle table with
    exactly `id`, `enabled`, `revision`, `updatedAt`, and `updatedBy`. Pin `id = 'global'`, a
    nonnegative revision, a disabled singleton seed, `REVOKE ALL FROM PUBLIC`, SELECT-only grants
    for `builderhunt_app`/`builderhunt_readonly`/`builderhunt_worker`, and
    SELECT/INSERT/UPDATE for `builderhunt_platform`; pin the absence of DELETE, tenant id, and RLS.
    Run migration integrity before generation and stop if another unreviewed migration is present.
    Add the schema definition, run
    `pnpm exec drizzle-kit generate --name platform_beta_mode`, review the newly allocated SQL/snapshot/journal
    entry, add grants and seed only to that unapplied migration, then regenerate the hash manifest
    with `pnpm test:migration-integrity -- --write`. Plan 55 currently reserves `0163`; never name,
    edit, or reuse its migration.
  - Verify: `pnpm vitest run tests/unit/shared/lib/db/beta-mode-schema.test.ts && pnpm test:migration-integrity && pnpm exec drizzle-kit check && pnpm test:migrations:local`
    passes. The focused test must first fail for the missing table/migration, and the final replay
    must succeed twice on a disposable database.

- [ ] **Implement authoritative state, display cache, and optimistic writes**
  - Files: `src/shared/lib/billing/beta-mode.ts`,
    `tests/unit/shared/lib/billing/beta-mode.test.ts`.
  - Do: Export `BetaModeState { enabled, revision, updatedAt, updatedBy }`,
    `BetaModeRevisionConflict` carrying `current`, `BetaModeUnavailableError`,
    `disabledBetaModeState()`, `getBetaModeState(transaction)`,
    `getPlatformBetaModeState()`, `getCachedBetaModeStatus()`,
    `invalidateBetaModeStatusCache()`, and
    `setBetaModeState({ enabled, expectedRevision, updatedBy })`. Write tests first for missing row
    → disabled, authoritative database failure → typed availability error, direct reads bypassing
    cache, platform direct read, five-second cached hit/miss and disabled fallback, explicit
    invalidation, same-state no-op, one revision bump per transition, stale revision, and two
    competing writers where one wins. Tenant reads use the caller's `TenantTransaction` and take a
    transaction-scoped shared advisory lock in a beta-mode-specific key namespace; display reads
    alone use an in-process memo. A lock-order integration case must
    prove an admin update waits for an authorized transaction and no old-state work commits after
    disable returns. Writes use `platformDb.transaction`, take the matching exclusive advisory lock,
    lock the singleton `FOR UPDATE`, compare the expected revision, persist actor/time, and invalidate after
    commit. Never catch a PostgreSQL statement error and continue the aborted tenant transaction.
    Log structured availability warnings without leaking SQL or credentials.
  - Verify: `pnpm vitest run tests/unit/shared/lib/billing/beta-mode.test.ts && pnpm type-check`
    passes after the initial missing-module red run, with zero failed tests and zero type errors.

- [ ] **Publish a recent-authenticated, revision-safe platform-admin API**
  - Files: `src/routes/api/admin/billing/beta-mode.ts`,
    `tests/unit/routes/api/admin/billing/beta-mode.test.ts`, and `src/routeTree.gen.ts` only through
    the normal TanStack generation/build flow.
  - Do: Use `getPlatformBetaModeState()` for GET; add PUT with a strict Zod body
    `{ enabled: boolean, expectedRevision: nonnegative integer }`. Both require
    `requirePlatformAdminPrincipal`; PUT also calls `requireRecentPlatformAdminAuthentication`.
    Map malformed/unknown input to 400, `BetaModeRevisionConflict` to 409 plus current state,
    authorization errors through `platformAdminErrorResponse`, and unexpected failures to a
    redacted 500. Treat same-state PUT as a no-op. After a real transition, count organizations
    once and call `auditPlatformAdminAction` with action
    `admin.billing.beta-mode.enable|disable`, target `platform_beta_mode/global`, and details
    `{ from, to, revision, organizationCount }`; never include an organization list or PII. Write
    route tests before implementation for anonymous 401, non-admin 403, recent auth, exact body,
    stale revision, no-op, enable/disable, audit shape, and 405 with `Allow: GET, PUT`.
  - Verify: `pnpm vitest run tests/unit/routes/api/admin/billing/beta-mode.test.ts tests/unit/shared/lib/auth/platform-admin.test.ts && pnpm type-check`
    passes after the route test's initial missing-route red run.

## Phase 1 — Effective product entitlement

- [ ] **Create one raw/effective entitlement boundary and update feature authorization**
  - Files: `src/shared/lib/repositories/entitlements.ts`,
    `tests/unit/shared/lib/repositories/entitlements.test.ts`,
    `src/shared/lib/billing/feature-authorization.ts`,
    `tests/unit/shared/lib/billing/feature-authorization.test.ts`.
  - Do: Export `EffectiveEntitlementPolicy extends EntitlementPolicy` with `actualTier` and
    `betaModeActive`, pure
    `applyBetaModeEntitlement(actual, beta)`, and
    `getEffectiveOrganizationEntitlement(transaction, organizationId)`. Test first: enabled
    free/pro → Pro Max; enabled Pro Max/Team unchanged; disabled parity; actual tier, status,
    active, seats, and payment block preserved; beta paid actions allowed only without
    `paymentBlocked`. Change `checkEntitlement` to use the effective resolver and existing
    `tierMeetsMinimum`—do not add another rank map. Pin a free beta org passing Pro and Pro Max
    rate cards without Stripe, payment-blocked denial, Team preservation, unknown feature, and the
    exact existing beta-off `no_subscription`/`tier_too_low` behavior. Leave
    `getOrganizationEntitlement` unchanged as raw billing truth.
  - Verify: `pnpm vitest run tests/unit/shared/lib/repositories/entitlements.test.ts tests/unit/shared/lib/billing/feature-authorization.test.ts && pnpm type-check`
    passes after the new resolver/authorization cases are observed red.

- [ ] **Route every product allowance—and only product allowances—through the effective resolver**
  - Files: `src/routes/api/alerts/index.ts`, `src/routes/api/queries/index.ts`,
    `src/routes/api/builders/track.ts`, `src/routes/api/search/semantic.ts`,
    `src/routes/api/sprints/index.ts`, `src/routes/api/sprints/$sprintId.ts`,
    `src/routes/api/ai/complete.ts`, `src/shared/lib/ai/run-enrichment.ts`,
    `src/routes/api/builders/$builderId/fingerprint.ts`,
    `src/routes/api/builders/$builderId/synergy.ts`,
    `src/routes/api/fingerprint/match.ts`, `src/routes/api/work-samples/analyze.ts`, the nearest
    route/service tests for each distinct policy shape,
    `src/shared/lib/billing/contracts.ts`,
    `tests/unit/shared/lib/billing/contracts.test.ts`, and
    `tests/unit/security/effective-entitlement-call-sites.test.ts`.
  - Do: Start with a failing boundary test that requires effective reads in the enumerated product
    paths while keeping raw reads in `src/shared/lib/auth/organization-lifecycle.ts`,
    `src/shared/lib/billing-session.ts`, checkout, Stripe, dunning, refunds, operator grants, and
    admin reporting. In `src/shared/lib/billing/contracts.ts`, retain raw tier/status/period/seat
    reads but use the effective policy for product capability/limits and expose labeled
    `effectiveTier`/`betaModeActive` fields. Add behavioral cases for each shape:
    `paidActionsAllowed` (alerts), legacy plan limits (queries/tracked builders), direct free denial
    (semantic search), direct Pro Max table limit (sprints), and AI allowance. Replace only product
    reads and preserve response bodies/statuses. Run
    `rg -n "getOrganizationEntitlement\(" src/routes src/shared src/modules` afterward and record
    why every remaining hit is raw billing provenance, seats, lifecycle, or admin state; no unexplained product
    enforcement hit may remain.
  - Verify: `pnpm vitest run tests/unit/security/effective-entitlement-call-sites.test.ts tests/unit/shared/lib/billing/sourcing-sprint-allowance.test.ts tests/unit/shared/lib/billing.test.ts && pnpm type-check`
    plus the route/service test files selected in the Do step passes. The boundary test must be
    observed red before imports change.

## Phase 2 — Real beta credits and spend safety

- [ ] **Derive and mint one concurrency-safe monthly beta grant**
  - Files: `src/shared/lib/billing/beta-credits.ts`,
    `tests/unit/shared/lib/billing/beta-credits.test.ts`, and
    `src/shared/lib/billing/credits.ts` only if an injectable lock seam is required.
  - Do: Export `BETA_MONTHLY_CREDIT_UNITS = 700`,
    `BetaCreditWindow { key, sourceReference, monthlyWindowKey, expiresAt }`,
    `deriveBetaCreditWindow(now, organizationId)`, and
    `ensureBetaMonthlyCreditGrant(transaction, organizationId, state, now?)`, plus
    `getClaimableBetaCreditUnits(transaction, organizationId, state, now?): Promise<0 | 700>`.
    Pure tests pin normal
    month, December→January, leap February, exact boundary, distinct organization keys,
    `sourceReference = beta-mode:YYYY-MM`, globally unique
    `monthlyWindowKey = beta-mode:<organizationId>:YYYY-MM`, and next-month UTC expiry. Real
    PostgreSQL tests pin disabled no-op, one enabled `promotional` 700-unit grant plus one ledger
    entry, replay, and two concurrent transactions producing one grant/entry without an aborted
    loser. Read-only claimable-unit tests return 700 before the current window exists, zero after it
    exists or while disabled, and perform no write. Take a transaction advisory lock derived from
    organization/month before `grantCredits`;
    use stable idempotency/window keys and generate row ids only after the lock. The caller, not this
    service, enters `withCreditWriteRole`.
  - Verify: `pnpm vitest run tests/unit/shared/lib/billing/beta-credits.test.ts tests/unit/shared/lib/billing/credits.test.ts tests/unit/shared/lib/repositories/billing-ledger.test.ts`
    passes. The concurrency assertion must be observed failing before the lock and green afterward.

- [ ] **Use one beta-grant predicate for reservation, spendable balance, and downstream billing**
  - Files: `src/shared/lib/repositories/billing-ledger.ts`,
    `src/shared/lib/billing/reservations.ts`, `src/shared/lib/billing/credits.ts`,
    `src/shared/lib/repositories/billing.ts`, `src/shared/lib/billing/contracts.ts`,
    `src/shared/lib/billing/auto-recharge.ts`,
    `src/modules/solutions/server/billing-state.ts`,
    `src/shared/lib/billing/feature-authorization.ts`, and the corresponding
    ledger/reservation/contracts/auto-recharge/solutions/interviews tests. At HEAD, interview
    modules reserve through the feature facade and do not expose a separate available-balance DTO.
  - Do: Add `SpendableGrantScope { activeBetaSourceReference: string | null }` and one shared SQL
    condition. Non-beta promotional, pack, and subscription grants always qualify; a promotional
    grant whose source reference starts `beta-mode:` qualifies only on an exact active-reference
    match. Pin identical results in locked allocation, SQL balance aggregation, tenant active-grant
    DTO, auto-recharge threshold, and Solutions balance. Effective balance adds 700 claimable units
    before a current-month beta grant exists, without writing from the read path. Add
    `betaCreditsClaimableUnits` to tenant billing summaries, include it in `creditBalanceUnits`, and
    keep `activeCreditGrants` limited to persisted rows. Keep raw grant reads for dunning,
    expiry worker, notifications, reconciliation, and admin metrics. In
    `feature-authorization.reserveCredits`, read beta state once, authorize the effective policy,
    provision inside `withCreditWriteRole` only when `maxUnits > 0`, then reserve with the same
    source reference. Update `feature-authorization.extendReservation` to re-read authoritative
    state and pass the current scope into raw extension allocation; settlement/release continue to
    use existing allocations. Test claimable preflight, first reservation, zero-unit no grant,
    extension while on, extension refused after disable, disable exclusion, paid/pack
    preservation, same-month re-enable restoring only unused remainder, and month rollover excluding
    old beta before the worker runs. Confirm no product module imports raw `reservations.ts`.
  - Verify: `pnpm vitest run tests/unit/shared/lib/billing/reservations.test.ts tests/unit/shared/lib/billing/feature-authorization.test.ts tests/unit/shared/lib/billing/contracts.test.ts tests/unit/shared/lib/billing/auto-recharge.test.ts tests/unit/modules/solutions/billing-state.test.ts tests/unit/modules/interviews && pnpm vitest run tests/unit/shared/lib/billing`
    passes after the new eligibility cases are observed red, with zero failures.

## Phase 3 — Operator and member UX

- [ ] **Build the conflict-safe admin control on the existing billing page**
  - Files: `src/modules/admin/billing/BetaModeControl.tsx`,
    `tests/unit/modules/admin/billing/BetaModeControl.test.tsx`,
    `src/routes/_dashboard/admin/billing.tsx`.
  - Do: Write component tests first for loading, enabled/disabled state, actor/time/revision,
    confirmation and cancel, pending-disabled controls, success refresh, 409 authoritative reload,
    retryable 500/network error, keyboard labels, and focus. Implement explicit desired-state PUT
    with the rendered revision and mount the control above `BillingOperationsPage`. Confirmation
    copy must state organization scope, Pro Max capabilities, additive 700 beta credits per UTC
    month, unchanged seats/billing truth, and immediate exclusion of unused beta credits on disable.
    A 409 tells the admin another operator changed the state and renders the returned current state;
    generic errors preserve the current screen state and permit retry.
  - Verify: `pnpm vitest run tests/unit/modules/admin/billing/BetaModeControl.test.tsx tests/unit/routes/api/admin/billing/beta-mode.test.ts && pnpm type-check`
    passes after the component's initial missing-module red run.

- [ ] **Expose minimal authenticated status and render a presentational member badge**
  - Files: `src/routes/api/beta-mode.ts`, `tests/unit/routes/api/beta-mode.test.ts`,
    `src/modules/dashboard/hooks/useBetaModeStatus.ts`,
    `tests/unit/modules/dashboard/hooks/useBetaModeStatus.test.tsx`,
    `src/modules/dashboard/ui/shell/DashboardLayout.tsx`,
    `src/modules/dashboard/ui/shell/ContextTopbar.tsx`,
    `src/modules/dashboard/components/UserMenu.tsx`,
    `tests/unit/modules/dashboard/components/UserMenu.test.tsx`.
  - Do: Add authenticated GET `/api/beta-mode` returning exactly `{ enabled, revision }`; test
    tenant-auth refusal, no actor/timestamp/tier leakage, fail-closed disabled response, and 405 with
    `Allow: GET`. Add `useBetaModeStatus(): { enabled, loading }` using credentialed fetch and
    `AbortController`; test success, disabled, failure, abort, and no update after unmount. Pass a
    boolean through `DashboardLayout` → `ContextTopbar` → `UserMenu` and render accessible text
    `Beta · 700 credits/month` only when true. The UI/hook may not import database, environment,
    Node, or server-only modules.
  - Verify: `pnpm vitest run tests/unit/routes/api/beta-mode.test.ts tests/unit/modules/dashboard/hooks/useBetaModeStatus.test.tsx tests/unit/modules/dashboard/components/UserMenu.test.tsx && pnpm type-check && pnpm build`
    passes after the endpoint/hook/prop tests are observed red. The production build must show no
    client-bundle Node/Postgres import error.

## Phase 4 — Runtime certification and operations

- [ ] **Certify enable, disable, re-enable, rollover, and rollback end to end**
  - Files: `tests/e2e/beta-mode.spec.ts`, `docs/operations/beta-mode-runbook.md`, and this plan trio
    only after every gate passes.
  - Do: Write a Playwright journey with separate platform-admin and free-tenant sessions. Prove
    denial before enable; revisioned enable; badge within five seconds; Pro and Pro Max limits;
    exactly one 700-unit grant after the first metered action; unchanged raw tier/seat values;
    disable removing access and spendable beta balance while paid/pack balance remains; same-month
    re-enable restoring only unused remainder. Test month rollover with injected service time, never
    the host clock. Observe one expected failing assertion before the final fix, then rerun green.
    Write the runbook with prerequisites, state check, UI/API enable/disable, audit actions, redacted
    singleton/grant-count queries, alerts, rollback, emergency reviewed SQL fallback, and the rules
    never to edit migrations or ledger entries. Production enablement remains a separate
    outward-facing operator action requiring explicit confirmation.
  - Verify: run, fresh and in this order,
    `pnpm test:migration-integrity`, `pnpm test:migrations:local`,
    `pnpm exec drizzle-kit check`, `pnpm test:rls:local`, `pnpm test:security`,
    `pnpm test:e2e:coverage`, `pnpm type-check`, `pnpm lint`, `pnpm vitest run`,
    `pnpm playwright test tests/e2e/beta-mode.spec.ts --project=chromium --project=mobile`, and
    `pnpm build`. Every command must exit 0; lint must report zero errors and test runners zero
    failures. Review the final diff for unrelated files and repeat the raw-entitlement/grant-scope
    inventory. Only then set the three status headers to `closed`, check tasks, and record the date
    plus exact verification evidence.
