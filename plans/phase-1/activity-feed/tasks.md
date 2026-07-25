# Tasks: Tenant Activity Feed

> **Status**: `blocked`
> **Depends on**: [`security-and-multitenancy`](../security-and-multitenancy/tasks.md), [`team-accounts`](../team-accounts/tasks.md), [`shared-resources`](../shared-resources/tasks.md)
> **Blocks**: nothing
> **Reality check**: implement only after canonical tenant transactions, activity/security-audit
> separation, shared resource services, non-owner roles, RLS, and tenant A/B harness exist.

- [ ] **Define versioned event and redaction registry**
  - Files: `src/shared/lib/activity/contracts.ts`, `src/shared/lib/activity/contracts.test.ts`, `docs/architecture/activity-events.md`
  - Do: Define approved event types, version, criticality, target integrity mode, zod metadata allowlist, formatter, retention, and security-audit mapping. Reject unknown keys and sensitive canaries; define deterministic idempotency key input.
  - Verify: one test per type/version/formatter/redaction plus unknown/email/token/note/query/prompt payload rejection passes.

- [ ] **Add tenant activity schema, RLS, grants, and indexes**
  - Files: `src/shared/lib/db/schema.ts`, `drizzle/`, `test/security/activity-schema.test.ts`, `test/security/rls.test.ts`
  - Do: Add organization activity table with candidate key, idempotency uniqueness, checked type/version, actor FK, keyset index, live-target composite FKs where applicable, force-RLS, app insert/select only, and worker bounded-delete policy. Keep security audit separate and unreadable to ordinary app feed queries.
  - Verify: app-role missing/A/B contexts, update denial, duplicate idempotency, cross-tenant target, and worker-grant tests pass.

- [ ] **Implement transaction-bound activity repository**
  - Files: `src/shared/lib/repositories/activity.ts`, `src/shared/lib/repositories/activity.test.ts`
  - Do: Implement `emitActivity(tx, principal, event)` and `listActivity(tx, principal, options)`; derive organization/actor/request from principal, validate metadata, use idempotency upsert/no-op, and keyset pagination. No global DB import or optional organization input.
  - Verify: atomic rollback, retry duplicate, A/B, missing context, equal timestamp pagination, actor deletion, and DTO allowlist tests pass.

- [ ] **Instrument canonical organization and shared-resource services**
  - Files: `src/shared/lib/auth/organization-lifecycle.ts`, `src/shared/lib/repositories/saved-queries.ts`, `src/shared/lib/repositories/organization-builders.ts`, `src/shared/lib/repositories/builder-notes.ts`, `src/shared/lib/repositories/builder-lists.ts`, `src/shared/lib/repositories/alerts.ts`, `test/security/activity-emission.test.ts`
  - Do: Emit only after authorized mutation inside the same tenant transaction; include minimized display metadata; classify membership/ownership/sharing/export/deletion events as transaction-critical. Avoid route-level duplicate emission and never include note/query/contact contents.
  - Verify: each mutation and retry yields expected exact event count; injected event failure rolls back critical mutation; sensitive canaries absent from DB/log/DTO.

- [ ] **Add tenant activity API and UI**
  - Files: `src/routes/api/organizations/activity.ts`, `src/routes/_dashboard/team/activity.tsx`, `src/modules/dashboard/components/TeamActivityPage.tsx`, `src/modules/dashboard/components/TeamActivityWidget.tsx`, `src/shared/lib/query-keys.ts`
  - Do: Resolve tenant principal/context, validate cursor/filter, return feed DTOs, and use organization-keyed cache. Render day groups, version-aware formatter, actor fallback, filters, load more, and no feed while context is switching/stale.
  - Verify: API role/A-B/spoof tests and component/browser switch/removal/in-flight/keyboard/mobile/accessibility tests pass.

- [ ] **Add bounded retention worker and privacy/export integration**
  - Files: `src/shared/lib/workers/activity-retention.ts`, `src/routes/api/admin/activity/prune.ts`, `src/shared/lib/legal.ts`, `test/security/activity-retention.test.ts`, `test/security/activity-privacy.test.ts`
  - Do: Authenticate worker, select server-side tenant batches, delete only expired product activity with worker role, checkpoint/retry safely, and emit operational metrics. Organization export uses allowed events; account export/deletion applies actor privacy without deleting organization history incorrectly.
  - Verify: recent/expired/A-B/idempotent/partial failure worker tests and owner/member/account export/deletion matrix pass.

- [ ] **Run activity release and performance gates**
  - Files: `e2e/activity-feed.spec.ts`, `docs/operations/activity-feed.md`, `.github/workflows/quality.yml`
  - Do: Seed 10k events per tenant and run keyset query plans, two-tenant API/direct-SQL, retries, equal timestamps, role/removal/switch, retention, privacy, and critical browser flows under production-like roles.
  - Verify: query meets recorded budget using organization keyset index; `pnpm test:security && pnpm test:rls && pnpm test:e2e -- e2e/activity-feed.spec.ts && pnpm lint && pnpm type-check && pnpm test && pnpm build` passes.

## Future

- Realtime, configurable retention/filters, and redacted weekly AI digest.
