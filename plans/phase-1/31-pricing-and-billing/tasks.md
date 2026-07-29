# Tasks: Pricing and Billing V1 — Superseded

> **Status**: `superseded`
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: the checked inventory below exists in source; all remaining corrections,
> migration, and Stripe work are executable only in
> [`30-stripe-billing-platform/tasks.md`](../30-stripe-billing-platform/tasks.md).

## Delivered historical inventory

- [x] **Create legacy user plan, plan-change, and plan-request tables**
  - Files: `src/shared/lib/db/schema.ts`
  - Evidence: `plans`, `planChanges`, and `planRequests` are present with migrated runtime use.
  - Verify: historical schema/repository tests identify the delivered tables.

- [x] **Create manual billing helpers and platform administration**
  - Files: `src/shared/lib/repositories/platform-billing.ts`, `src/shared/lib/billing.ts`, `src/routes/api/admin/plan-requests/index.ts`, `src/routes/_dashboard/admin/plan-requests.tsx`
  - Evidence: manual request, approve/decline, plan set, list, and audit flows exist.
  - Verify: existing billing and route tests cover the delivered path.

- [x] **Create initial pricing and billing user surfaces**
  - Files: `src/shared/lib/billing-shared.ts`, `src/routes/_landing/pricing.tsx`, `src/routes/_dashboard/settings/billing.tsx`, `src/routes/api/plans/me.ts`
  - Evidence: Free/Pro/Team pricing, billing page, and organization-aware summary exist, with known stale catalog/manual copy handled by the replacement.
  - Verify: existing pricing/billing tests provide the historical baseline.

## No remaining executable work

Do not implement the former thin Stripe phase, user-plan expiry task, pricing correction, or dead
limit cleanup from this directory. The replacement task list handles them together with canonical
organization ownership and migration so partial fixes cannot create a second billing authority.
