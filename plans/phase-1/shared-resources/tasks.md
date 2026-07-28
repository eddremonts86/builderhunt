# Tasks: Shared Searches and Builder Lists

> **Status**: `blocked`
> **Depends on**: [`security-and-multitenancy`](../security-and-multitenancy/tasks.md), [`team-accounts`](../team-accounts/tasks.md)
> **Blocks**: [`activity-feed`](../activity-feed/tasks.md)
> **Reality check**: do not implement until canonical tenant context, global builder identity,
> organization tracking, entitlements, RLS, and Team organization-keyed cache are verified.

- [ ] **Define shared-resource contracts and characterization tests**
  - Files: `src/shared/lib/shared-resources/contracts.ts`, `tests/unit/shared/lib/shared-resources/contracts.test.ts`, `test/security/shared-resources-characterization.test.ts`
  - Do: Define allowlisted query/list/item DTOs, `private | organization` visibility, creator attribution, permission actions, and typed errors. Characterize current personal query/alert behavior before switching repositories; forbid organization authority in request DTOs.
  - Verify: contract/characterization tests pass and reject unknown/private ORM/provider fields.

- [ ] **Verify normalized tenant schema and RLS for shared resources**
  - Files: `src/shared/lib/db/schema.ts`, `drizzle/` foundation migrations, `test/security/shared-resource-schema.test.ts`, `test/security/rls.test.ts`
  - Do: Confirm saved queries/keyword/source associations, alerts, lists/items, organization builders, and notes have mandatory organization keys, candidate keys, composite tenant FKs, indexes, checks, and command policies. Add no competing nullable tenant model.
  - Verify: app-role SQL rejects A alert→B query and A item→B list; missing/A/B contexts pass the manifest RLS suite.

- [ ] **Implement tenant saved-query repository**
  - Files: `src/shared/lib/repositories/saved-queries.ts`, `tests/unit/shared/lib/repositories/saved-queries.test.ts`, `src/shared/lib/authorization/permissions.ts`
  - Do: Accept `TenantTransaction` plus principal; list private creator rows and organization-visible rows only inside active organization; create/update/delete/change visibility via centralized permissions; maintain normalized keywords/sources atomically; return DTOs.
  - Verify: tests cover creator/member/admin/owner and tenant A/B for every operation, concurrent visibility change, and no global DB import.

- [ ] **Implement tenant builder-list repository**
  - Files: `src/shared/lib/repositories/builder-lists.ts`, `tests/unit/shared/lib/repositories/builder-lists.test.ts`
  - Do: Implement list/get/create/update/delete and add/remove item using canonical `builderIdentityId`, tenant composite FKs, creator/admin permissions, idempotent unique item insertion, and `trackedByOrganization`/allowed user attribution from organization tracking. Return no source snapshot/private artifact.
  - Verify: repository tests cover duplicate add, roles, deleted identity handling, A/B IDs, and DB rejection of cross-tenant parent references.

- [ ] **Migrate query APIs to tenant repository and DTO boundary**
  - Files: `src/routes/api/queries/index.ts`, `src/routes/api/queries/$id.visibility.ts`, `test/security/shared-query-api.test.ts`
  - Do: Resolve principal/context, validate inputs, call saved-query repository, map typed non-enumerating errors, return explicit DTOs, and emit redacted activity hook. Organization ID in body/query/header is rejected or ignored as data, never authority.
  - Verify: own/private/shared/role/A-B/spoofed-tenant/CSRF/rate tests pass using non-owner app role.

- [ ] **Add list and item APIs through tenant repository**
  - Files: `src/routes/api/lists/index.ts`, `src/routes/api/lists/$listId.ts`, `src/routes/api/lists/$listId/items/index.ts`, `src/routes/api/lists/$listId/items/$itemId.ts`, `test/security/builder-list-api.test.ts`
  - Do: Add zod bodies for names/descriptions/visibility and canonical `builderIdentityId`; enforce active Team entitlement and permissions; return allowlisted DTOs and generic other-tenant/not-found behavior; rate-limit mutations by user+organization.
  - Verify: full role and A/B matrix, duplicate item, invalid identity, spoofed tenant, and plan lapse tests pass.

- [ ] **Preserve tenant integrity when creating alerts from shared queries**
  - Files: `src/routes/api/alerts/index.ts`, `src/shared/lib/repositories/alerts.ts`, `tests/unit/shared/lib/repositories/alerts.test.ts`, `test/security/shared-alerts.test.ts`
  - Do: Allow an authorized member to opt into their own alert from an organization-visible query; copy validated keywords while composite FK preserves organization. Sharing alone creates no alert/delivery. Query visibility/deletion follows documented snapshot retention.
  - Verify: A member opt-in sends only that recipient; no share email; A cannot reference B query; PostgreSQL rejects forged composite relation.

- [ ] **Replace raw saved-query RSS access with a public feed capability**
  - Files: `src/shared/lib/db/schema.ts`, `src/shared/lib/repositories/public-feeds.ts`, `src/routes/api/feeds/$feedId.ts`, `plans/rss-feeds/{spec,plan,tasks}.md`, `test/security/public-feed-capabilities.test.ts`
  - Do: Create a hashed/revocable/rotatable public feed capability or publication record referencing tenant query internally; resolve it under authorized service logic and emit a minimized public feed. Raw saved query IDs no longer grant public access; revocation/plan lapse/organization deletion behavior is explicit.
  - Verify: guessing query/list IDs returns no feed; valid capability exposes only approved results; rotation/revocation/tenant deletion/lapse tests pass without revealing tenant metadata.

- [ ] **Build organization-scoped shared-resource UI**
  - Files: `src/modules/search/components/SearchPage.tsx`, `src/modules/dashboard/components/DashboardPage.tsx`, `src/routes/_dashboard/lists/index.tsx`, `src/routes/_dashboard/lists/$listId.tsx`, `src/modules/dashboard/components/ListsPage.tsx`, `src/modules/dashboard/components/ListDetailPage.tsx`, `src/modules/search/components/PersonResultCard.tsx`, `src/modules/builder-profile/components/BuilderProfilePage.tsx`
  - Do: Add private/organization visibility, creator attribution, lists/detail, canonical add-to-list, and permission-aware actions through Team's tenant query provider. Keep notes explicitly private. All query/cache/optimistic keys contain active organization and cancel on switch.
  - Verify: component/browser tests cover A→B switch with in-flight responses, role actions, canonical identity list add, duplicate notice, notes non-disclosure, keyboard/mobile/accessibility.

- [ ] **Run shared-resource isolation and release gates**
  - Files: `e2e/shared-resources.spec.ts`, `test/security/shared-resource-isolation.test.ts`, `docs/operations/shared-resources.md`, `.github/workflows/quality.yml`
  - Do: Seed A/B with multi-membership users; exercise queries, visibility, lists/items, alerts, feed capabilities, exports, switches, removal, plan lapse, stale tabs, direct SQL, and migration upgrade. Require foundation and Team security gates before deploy.
  - Verify: `pnpm test:security && pnpm test:rls && pnpm test:migrations && pnpm test:e2e -- e2e/shared-resources.spec.ts && pnpm lint && pnpm type-check && pnpm test && pnpm build` passes.

## Future

- Shared comments/contact state, list export, numeric list limits, and redacted organization digest.
