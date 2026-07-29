# ATS Integrations (Greenhouse, Lever, Ashby) (tasks)

> **Status**: `pending`
> **Depends on**: [`hiring-pipeline-kanban`](../hiring-pipeline-kanban/tasks.md) (hard — the pipeline stage model this plan maps external ATS status onto); [`security-and-multitenancy`](../../phase-1/01-security-and-multitenancy/tasks.md) (per-organization third-party credentials, RLS, tenant-scoped sync state); [`stripe-billing-platform`](../../phase-1/30-stripe-billing-platform/tasks.md) (the Team-tier gate this feature sells into does not bill anyone yet); [`legal-and-compliance`](../../phase-1/04-legal-and-compliance/tasks.md) (candidate data leaving the product to a third-party processor).
> **Blocks**: nothing
> **Reality check**: Touches `src/shared/lib/{env.ts,log.ts,billing-shared.ts,email.ts}`, `src/shared/lib/db/schema.ts`, `src/shared/lib/authorization/permissions.ts`, `src/shared/lib/operational-schedules.ts`, `src/shared/lib/repositories/account-privacy.ts`, `src/modules/dashboard/ui/shell/nav-config.ts`, `scripts/db/verify-api-isolation-local.mjs`, `docs/architecture/{data-classification.md,authorization-matrix.md}`, `docs/operations/{database-roles.md,deploy-runbook.md}`. Everything under `src/lib/ats/` and `src/shared/lib/repositories/ats*.ts` is new. `src/shared/lib/crypto/webhook-payload.ts` is left **untouched** — Phase 0 adapts its AES-256-GCM algorithm into a new sibling `crypto/secret-box.ts` (versioned envelope + AAD + its own key) rather than changing the Stripe call site. Phase 4 widens `builderhunt_worker`'s grants on the existing `organization_builders` table (today `SELECT`-only, `drizzle/0018_enrichment_worker_target_access.sql`) and on [`hiring-pipeline-kanban`](../hiring-pipeline-kanban/tasks.md)'s `organization_builder_stage_events` (that plan grants the worker `SELECT`, not `INSERT`).

Ordered so the app ships cleanly after every checkbox.

**Migration numbering.** No task below names a migration index. `drizzle/`'s head and
`drizzle/meta/_journal.json` move constantly; read the real next index from the journal at the moment
you run the generator, and let `drizzle-kit` name the file. Every hand-written migration is minted
with `pnpm exec drizzle-kit generate --custom --name <tag>` so the journal entry and
`drizzle/meta/NNNN_snapshot.json` exist — `scripts/db/verify-migration-integrity.mjs` hard-fails
unless the SQL set, the journal and the snapshots agree exactly, and `drizzle-kit migrate` never
applies an un-journaled file.

## Phase 0 — Secret-at-rest foundation

**This phase is independently shippable.** It adds no table, no migration, no route and no UI, and
depends on nothing else in this plan or in
[`hiring-pipeline-kanban`](../hiring-pipeline-kanban/tasks.md). Merge it on its own even if the rest
of ATS waits. Exit criteria are in [`plan.md`](./plan.md) §Phase 0.

- [ ] **Add the general-purpose secret box**
  - Files: `src/shared/lib/crypto/secret-box.ts` (new)
  - Do: AES-256-GCM adapted from `crypto/webhook-payload.ts` (12-byte random IV, `aes-256-gcm`,
    32-byte key — copy the algorithm, do not import from it and do not edit it). Exact envelope,
    four colon-separated parts, all lowercase hex except the literal prefix:

    ```
    v1:<ivHex(24)>:<authTagHex(32)>:<ciphertextHex>
    ```

    `decryptSecret` splits on `:`, rejects anything whose first part is not a known version, and
    rejects a part count other than 4 — `webhook-payload.ts`'s 3-part unversioned string must fail
    here rather than half-parse. AAD is a caller-supplied `context` string, applied on both sides via
    `cipher.setAAD(Buffer.from(context, 'utf8'))` / `decipher.setAAD(...)`; call sites pass
    `` `${organizationId}:${provider}` ``. `decryptSecret` tries `ATS_CREDENTIAL_ENCRYPTION_KEY`
    first, then `ATS_CREDENTIAL_ENCRYPTION_KEY_PREVIOUS` when set, and throws `SecretBoxError` if
    neither authenticates — never returns a partial or garbage plaintext. Export `encryptSecret`,
    `decryptSecret`, `secretFingerprint` (first 12 chars of the sha256 hex digest), `secretLast4`,
    `SecretBoxError`. Doc-comment that this file, unlike `webhook-payload.ts`, IS the
    general-purpose helper, and that `WEBHOOK_PAYLOAD_ENCRYPTION_KEY` must never be used with it.
  - Verify: `pnpm type-check`; `git diff --stat src/shared/lib/crypto/webhook-payload.ts` is empty.

- [ ] **Test the secret box, including the cross-tenant transplant case**
  - Files: `tests/unit/shared/lib/crypto/secret-box.test.ts` (new)
  - Do: round-trip; tampered ciphertext throws; **a ciphertext encrypted with context
    `orgA:greenhouse` fails to decrypt under context `orgB:greenhouse`**; a value encrypted with the
    previous key decrypts while the current key is set; wrong-length key throws; a 3-part
    `webhook-payload.ts`-shaped string throws rather than parsing; the same plaintext encrypts to
    different ciphertexts (fresh IV) but the same fingerprint.
  - Verify: `pnpm test -- tests/unit/shared/lib/crypto/secret-box.test.ts`.

- [ ] **Add the env contract and fail closed**
  - Files: `src/shared/lib/env.ts`, `tests/unit/shared/lib/env.security.test.ts`, `.env.example`
  - Do: `ATS_INTEGRATIONS_ENABLED: z.enum(['true','false']).default('false')`,
    `ATS_ENABLED_PROVIDERS: z.string().default('')`,
    `ATS_CREDENTIAL_ENCRYPTION_KEY`/`ATS_CREDENTIAL_ENCRYPTION_KEY_PREVIOUS` optional strings,
    `ATS_SYNC_LEASE_SECONDS` (default 300), `ATS_SYNC_MAX_PAGES_PER_RUN` (default 5),
    `ATS_SYNC_BATCH_CONNECTIONS` (default 10), `ATS_EXPORT_MAX_CANDIDATES_PER_REQUEST` (default 25).
    In `superRefine`, **outside** the `NODE_ENV !== 'production'` early return (same treatment as the
    Stripe block): when `ATS_INTEGRATIONS_ENABLED === 'true'`, require
    `ATS_CREDENTIAL_ENCRYPTION_KEY` matching `/^[0-9a-f]{64}$/i` and a non-empty
    `ATS_ENABLED_PROVIDERS`. The Stripe block at `env.ts:276` is the exact model — it sits above the
    `if (data.NODE_ENV !== 'production') return` guard, so it fires everywhere; put the ATS block
    beside it, not below the guard. Extend `env.security.test.ts` with those cases.
    Names/placeholders only in `.env.example`, never values.
  - Verify: `pnpm test -- tests/unit/shared/lib/env.security.test.ts` — enabling without the key
    fails in `development` too, not just production; defaults leave the feature off with no error.

- [ ] **Redact credentials in logs**
  - Files: `src/shared/lib/log.ts`, `tests/unit/shared/lib/log.test.ts`
  - Do: add `credential` to the `sensitiveKey` regex at `log.ts:27` (it already covers `secret`,
    `token`, `password`, `bio`, `location` — `credential` matches none of them today, so
    `credentialCiphertext` and `credentialLast4` log in the clear). Add a test asserting
    `redactLogValue({ credentialCiphertext: 'v1:aa:bb:cc' })` deep-equals
    `{ credentialCiphertext: '[REDACTED]' }` — the helper redacts values in place and returns the
    object, it does not return the bare string.
  - Verify: `pnpm test -- tests/unit/shared/lib/log.test.ts`.

## Phase 1 — Schema, RLS, grants, classification

- [ ] **Add the four ATS tables**
  - Files: `src/shared/lib/db/schema.ts`
  - Do: add `atsConnections`, `atsCandidateLinks`, `atsExportEvents`, `atsSyncState` exactly per
    spec.md §2, including every `uniqueIndex`, `check`, and composite `foreignKey`. Non-negotiable:
    `ats_candidate_links_org_provider_external_unique` on `(organizationId, provider,
    externalCandidateId)`, `ats_candidate_links_org_connection_identity_unique`, and the composite FK
    to `atsConnections(organizationId, id)`. **Equally non-negotiable: `ats_candidate_links` and
    `ats_export_events` reference `builderIdentities.id` only — never a composite FK to
    `organizationBuilders`**, because `deleteOrganizationBuilder`
    (`src/shared/lib/repositories/organization-builders.ts`) hard-deletes the tracking row from the
    existing `DELETE /api/builders/$builderId` and link rows are retained for audit (spec.md §2
    "Untracking a builder"). Add `'untracked'` to the `conflict_state` check constraint. Include
    `transmitTopics: boolean('transmit_topics').notNull().default(false)` on `atsConnections`
    (spec.md §7 — `topics` is opt-in, not default).
  - Verify: `pnpm type-check`; inspect the two new tables' constraint arrays and confirm neither
    contains a `foreignKey({ ... foreignColumns: [organizationBuilders...] })` (unlike
    `enrichmentJobs`, which legitimately does).

- [ ] **Keep account hard-deletion working with the three new restrict references**
  - Files: `src/shared/lib/repositories/account-privacy.ts`, `tests/unit/shared/lib/repositories/account-privacy.test.ts`
  - Do: this plan adds three `references(() => authUsers.id, { onDelete: 'restrict' })` columns —
    `atsConnections.createdByUserId`, `atsCandidateLinks.createdByUserId`,
    `atsExportEvents.actorUserId`. `hardDeleteAccountSubject` does **not** find those generically: it
    carries an explicit list and currently reassigns only `organizationBuilders.creatorUserId` and
    `sourcingSprints.creatorUserId` to `DELETED_USER_SENTINEL_ID`
    (`account-privacy.ts:310-312`, `drizzle/0026_deleted_user_sentinel.sql`). Add three
    `tx.update(...).set({ … : DELETED_USER_SENTINEL_ID }).where(eq(…, userId))` statements **inside
    the same per-membership `withTenantContext` block** — outside it, RLS silently matches 0 rows,
    which is the exact failure mode the comment above that code warns about. Do not add a new
    sentinel row; `system-deleted-user` already exists.
  - Verify: `pnpm test -- tests/unit/shared/lib/repositories/account-privacy.test.ts`; and end of
    Phase 3, `pnpm test:api-isolation:local` — `checkLegalRunWorker` hard-deletes a user who created
    a connection and an export event and must return success, not an FK violation.

- [ ] **Generate the table migration**
  - Files: `drizzle/` (new migration from `pnpm db:generate`), `drizzle/meta/_journal.json`, `drizzle/meta/NNNN_snapshot.json`, `drizzle/migration-hashes.json`
  - Do: `pnpm db:generate` (it writes the SQL, journal entry and snapshot together). It derives the
    next index from `drizzle/meta/_journal.json` itself — never hardcode or guess one, and note that
    `drizzle/`'s head moves between reading this plan and executing it. Review the SQL for any
    unexpected drop/rename; do not hand-edit the SQL afterwards. Regenerate the immutability
    manifest with `node scripts/db/verify-migration-integrity.mjs --write`.
  - Verify: `pnpm db:migrate` on a fresh database; `pnpm exec drizzle-kit check` and
    `pnpm test:migration-integrity` both pass.

- [ ] **Hand-write the RLS + grants migration**
  - Files: `drizzle/<next>_ats_integrations_rls_grants.sql` (new), `drizzle/meta/_journal.json`, `drizzle/meta/NNNN_snapshot.json`, `drizzle/migration-hashes.json`, `docs/operations/database-roles.md`
  - Do: mint the file with `pnpm exec drizzle-kit generate --custom --name ats_integrations_rls_grants`
    so the journal entry and snapshot exist — `scripts/db/verify-migration-integrity.mjs` hard-fails
    unless the SQL set exactly equals the journal tags with matching snapshots, and `drizzle-kit
    migrate` never applies an un-journaled file (follow
    [`abuse-and-usage-integrity`](../../phase-1/32-abuse-and-usage-integrity/tasks.md)'s
    `0043_abuse_usage_integrity_tables.sql` / `0044_abuse_usage_integrity_rls_grants.sql` precedent,
    including its rename-the-tag convention). Then write the body, mirroring
    `drizzle/0044_abuse_usage_integrity_rls_grants.sql`'s structure and header comment:
    `ENABLE`+`FORCE ROW LEVEL SECURITY` on all four tables; per-statement `builderhunt_app` policies
    on `organization_id = nullif(current_setting('app.organization_id', true), '')`; the grant split
    from spec.md §2 verbatim, in particular
    `GRANT UPDATE (status, last_verified_at, last_error_code, last_error_at, failure_notified_at, updated_at) ON ats_connections TO builderhunt_worker;`
    and a column-list `GRANT SELECT (...) ON ats_connections TO builderhunt_platform;` that **omits
    `credential_ciphertext`**. No `UPDATE`/`DELETE` on `ats_export_events` for anyone. Nothing at all
    for `builderhunt_auth`, `builderhunt_capability` or `builderhunt_readonly`. No `PUBLIC`,
    `TRUNCATE`, or `REFERENCES`. Add an "ATS integration tables" section to
    `docs/operations/database-roles.md`, as the abuse plan did for `0044`.
  - Verify: `pnpm db:migrate`; `pnpm test:migration-integrity` and `pnpm test:rls:local` pass; then as
    `builderhunt_platform`, `SELECT credential_ciphertext FROM ats_connections;` errors with
    `permission denied for column`; as `builderhunt_worker`,
    `UPDATE ats_connections SET label = 'x';` errors likewise.

- [ ] **Document the data classes and authorization**
  - Files: `docs/architecture/data-classification.md`, `docs/architecture/authorization-matrix.md`
  - Do: four new rows, all `tenant-private`, canonical owner `organization_id`, public fields `none`,
    retention: connections/sync-state = connection lifetime, links + export events = organization
    lifetime (audit outlives the credential). In the matrix, record `integration:read` /
    `integration:manage` as owner+admin and note that candidate export reuses `resource:export`.
  - Verify: Both documents mention all four tables; no code change.

## Phase 2 — Provider contract, fake, contract suite, stage mapping

- [ ] **Re-confirm each provider's API contract and record it**
  - Files: `docs/operations/ats-provider-register.md` (new)
  - Do: against live vendor documentation, confirm and record per provider: auth scheme, the exact
    write-time acting-user requirement (Greenhouse `On-Behalf-Of` header, Lever `perform_as` query
    parameter), the candidate create + search endpoints, the "updated since" listing/pagination
    mechanism and its cursor shape, rate-limit headers, and the stage/status field name. Mark any
    fact that could not be confirmed as `UNCONFIRMED` and do not build against it.
  - Verify: Register has a dated, sourced row per provider; every claim spec.md §3's table makes is
    either confirmed or corrected here (this file wins over the spec on API facts).

- [ ] **Define the provider contract**
  - Files: `src/lib/ats/provider.ts` (new)
  - Do: exactly spec.md §3 — `AtsProviderId`, `AtsErrorCode`, `AtsProviderError` (with
    `retryAfterMs`), `AtsCredential`, `AtsCandidatePayload` (**the complete transmit allowlist**),
    `AtsExternalCandidate`, `AtsProvider`. Doc comment stating that no ATS HTTP call may exist
    outside an adapter, mirroring `src/shared/lib/billing/provider.ts`'s opening comment.
  - Verify: `pnpm type-check`.

- [ ] **Build the deterministic fake provider**
  - Files: `src/lib/ats/fake-provider.ts` (new), `tests/unit/lib/ats/fake-provider.test.ts` (new)
  - Do: in-memory store seeded from a fixture, `createFakeAtsProvider({ scenario })` where scenario ∈
    `success | invalid_credentials | permission_denied | rate_limited | not_found |
    duplicate_on_create`; deterministic ids (`fake-cand-<n>`), monotonic `updatedAt`, cursor =
    stringified index so pagination is exercised. Model `src/shared/lib/billing/fake-provider.ts`.
    Record every call on the instance (`provider.calls`) so later tasks can assert "no provider call
    was made" for a restricted or suppressed identity.
  - Verify: `pnpm test -- tests/unit/lib/ats/fake-provider.test.ts` — no network, identical output
    across runs.

- [ ] **Write the shared provider contract suite**
  - Files: `src/lib/ats/provider-contract-suite.ts` (new), `tests/unit/lib/ats/provider-contract-suite.test.ts` (new)
  - Do: `describeAtsProviderContract(name, factory)` asserting: `verifyCredential` throws
    `AtsProviderError('invalid_credentials')` on a bad key; `findCandidates` returns `[]` (never
    throws) when nothing matches; `createCandidate` returns an id and never mutates an existing
    candidate; `listUpdatedCandidates` paginates to `exhausted: true` and never repeats a candidate
    within one cursor walk; `rate_limited` carries `retryAfterMs`; `externalStatus` is returned
    verbatim, never normalized. Run it against the fake in the sibling test file. Model
    `src/shared/lib/billing/provider-contract-suite.ts` — note the precedent puts the suite in
    `src/` (it imports `vitest` from a non-test source file, which is exactly how the real adapter
    can re-run it unmodified); keep that shape.
  - Verify: `pnpm test -- tests/unit/lib/ats/provider-contract-suite.test.ts`.

- [ ] **Add the provider registry**
  - Files: `src/lib/ats/registry.ts` (new), `tests/unit/lib/ats/registry.test.ts` (new)
  - Do: clone `src/lib/enrichment/registry.ts`: a frozen `ALL_PROVIDERS` record plus
    `getEnabledProviders(allowlistEnv)` / `getProvider(id, allowlistEnv)` returning only providers
    present in `ATS_ENABLED_PROVIDERS`. Unknown or non-allowlisted id → `null`, never a throw.
  - Verify: `pnpm test -- tests/unit/lib/ats/registry.test.ts`.

- [ ] **Implement the stage-mapping resolver (pure)**
  - Files: `src/lib/ats/stage-mapping.ts` (new), `tests/unit/lib/ats/stage-mapping.test.ts` (new)
  - Do: `resolveExternalStage` per spec.md §6 (operator rule → provider defaults →
    normalized-name equality → `unmapped`), `atsStageMappingRuleSchema` (zod: `externalStage` 1–120
    chars, `localStageKey` 1–64 chars, max 50 rules), `GREENHOUSE_DEFAULT_STAGE_RULES` and
    `ASHBY_DEFAULT_STAGE_RULES`. Tests: exact rule wins over default; `'Take-home sent'` with no rule
    → `unmapped/no_rule`; a rule pointing at a stage absent from `knownLocalStageKeys` →
    `unmapped/stale_local_stage` (**no throw, no write**); `'  HIRED '` normalizes onto a
    `hired` key; empty `knownLocalStageKeys` never mapped. `knownLocalStageKeys` is a plain
    parameter — this module imports nothing from `schema.ts` and nothing from
    [`hiring-pipeline-kanban`](../hiring-pipeline-kanban/tasks.md), which is what lets Phases 0–3
    ship before that plan exists. The DB-reading counterpart (`stage-source.ts`) is a Phase 4 task.
  - Verify: `pnpm test -- tests/unit/lib/ats/stage-mapping.test.ts`.

## Phase 3 — Credentials + export path (Greenhouse)

- [ ] **Implement the Greenhouse adapter**
  - Files: `src/lib/ats/providers/greenhouse.ts` (new), `tests/unit/lib/ats/providers/greenhouse.test.ts` (new)
  - Do: per the Phase-2 register. Basic auth header from `apiKey` with an empty password; the
    acting-user header on every write (`requiresActingUserReference: true`); map HTTP 401→
    `invalid_credentials`, 403→`permission_denied`, 404→`not_found`, 422→`invalid_payload`,
    429→`rate_limited` with `retryAfterMs` from the response headers, 5xx→`upstream_unavailable`.
    Tests use a stubbed `fetch`, never a real key, and run `describeAtsProviderContract` against the
    stub.
  - Verify: `pnpm test -- tests/unit/lib/ats/providers/greenhouse.test.ts` — contract suite green
    against the stubbed transport.

- [ ] **Build the tenant repository**
  - Files: `src/shared/lib/repositories/ats.ts` (new), `tests/unit/shared/lib/repositories/ats.test.ts` (new)
  - Do: every query takes `TenantTransaction` and never imports the global `db`.
    `listConnectionDtos` (**explicit column list, `credentialCiphertext` never selected**),
    `findConnectionWithCredential` (the only reader of the ciphertext), `upsertConnection`,
    `updateConnectionStatus`, `deleteConnection`, `replaceStageMappings`, `findLinkByIdentity`,
    `insertLinkIfAbsent` (`ON CONFLICT DO NOTHING RETURNING`), `updateLinkFromExternal`,
    `listLinksForOrganization`, `insertExportEvent`, `countActiveConnections`. Export
    `AtsConnectionDto` with exactly `{ id, provider, label, credentialLast4, credentialFingerprint,
    actingUserReference, status, lastVerifiedAt, lastErrorCode, lastSyncedAt, linkCount,
    unmappedStageCount, transmitBio, transmitLocation, transmitTopics, stageMappings }`.
  - Verify: `pnpm test -- tests/unit/shared/lib/repositories/ats.test.ts`.

- [ ] **Add a boundary test forbidding credential reads outside the allowlist**
  - Files: `tests/unit/shared/lib/repositories/ats-credential-boundary.test.ts` (new)
  - Do: scan `src/**/*.{ts,tsx}` for `credentialCiphertext` / `credential_ciphertext` and fail unless
    the file is in the allowlist (`src/shared/lib/repositories/ats.ts`,
    `src/shared/lib/db/schema.ts`, `src/shared/lib/repositories/ats-worker.ts`). Note
    `crypto/secret-box.ts` is deliberately **not** on the allowlist — it takes an opaque string and
    must never name the column. Model the source-scanning boundary test
    `tests/unit/shared/lib/client-route-boundary.test.ts` — reuse its recursive `tsFiles(dir)`
    helper shape (`readdir` with `withFileTypes`, `readFile`, no globbing dependency).
  - Verify: `pnpm test -- tests/unit/shared/lib/repositories/ats-credential-boundary.test.ts`;
    temporarily adding a `credentialCiphertext` reference to a route file makes it fail.

- [ ] **Add the permissions and the tier gate**
  - Files: `src/shared/lib/authorization/permissions.ts`, `tests/unit/shared/lib/authorization/permissions.test.ts`, `src/shared/lib/billing-shared.ts`
  - Do: add `'integration:read'` and `'integration:manage'` to the `PermissionAction` union
    (`permissions.ts:10-39`; both names are still unclaimed at HEAD) and one `case` pair in `can()`
    returning `elevated`. `can()`'s switch has no `default`, so a missing case is a type error, not a
    silent `undefined` — add both. Do **not** add an export permission: candidate export reuses the
    existing `'resource:export'`. In `billing-shared.ts`, next to `SOURCING_SPRINT_LIMITS`, add
    `export const ATS_CONNECTION_LIMITS: Record<PlanTier, number> = { free: 0, pro: 0, team: 3 }`
    with a comment that `pro_max` resolves to `team` via `resolveLegacyPlanTier`. (`PlanTier`, not
    `OrganizationTier` — matching `SOURCING_SPRINT_LIMITS`' documented convention and its
    `resolveLegacyPlanTier` call sites.)
  - Verify: `pnpm test -- tests/unit/shared/lib/authorization/permissions.test.ts` — a `member` is
    denied both new actions.

- [ ] **Implement the export service (pure orchestration)**
  - Files: `src/lib/ats/export.ts` (new), `tests/unit/lib/ats/export.test.ts` (new)
  - Do: `buildCandidatePayload(builder, options)` producing **only** `AtsCandidatePayload` fields and
    returning the transmitted field-name list for the audit event. Defaults are `fullName`
    (`displayName ?? username`), `sourceProfileUrl` (`profileUrl`) and `primaryLanguage`
    (`language`) — all three from `builder_identities`. `bio`, `location` and `topics` are emitted
    only when the connection opts in; `email` only when the operator supplied one for that row.
    **`topics` is not a `builder_identities` column** — read it from
    `organization_builders.private_metadata.topics` with the same defensive
    `Array.isArray(...).filter(v => typeof v === 'string')` shape `privateTopics` uses in
    `src/routes/api/export/builders.ts`, and emit no other `private_metadata` key ever.
    `planExport(items, existing)` resolves the §4 match ladder over `findCandidates` results into
    `create | link | needs_decision | skip_duplicate | skip_restricted` per row. Tests: any other
    private-metadata key, a note, an AI enrichment blob and a score are all absent from the payload;
    `topics` is absent when `transmitTopics` is false and present when true; a restricted identity is
    always `skip_restricted`; an exact profile-URL hit is `skip_duplicate` with the external id; a
    name-only hit is `needs_decision`, never auto-linked.
  - Verify: `pnpm test -- tests/unit/lib/ats/export.test.ts`.

- [ ] **Add the connection routes**
  - Files: `src/routes/api/ats/connections.ts` (new), `src/routes/api/ats/connections.$connectionId.ts` (new), `src/routes/api/ats/connections.$connectionId.verify.ts` (new), `src/routes/api/ats/connections.$connectionId.stage-mappings.ts` (new)
  - Do: every handler `requireTenantPrincipal` → `can(principal, 'integration:read'|'integration:manage')`
    → `withTenantContext`. 503 `{ error: 'ats_disabled' }` when `ATS_INTEGRATIONS_ENABLED !== 'true'`;
    403 `{ error: 'plan' }` when the entitlement tier's `ATS_CONNECTION_LIMITS` is 0 or the limit is
    reached. `POST` body `{ provider, label, apiKey, actingUserReference?, disclosureVersion }` —
    call `verifyCredential` **before** persisting, then store `encryptSecret(apiKey, `${orgId}:${provider}`)`
    plus fingerprint/last4 and the disclosure acknowledgement. Every response is an
    `AtsConnectionDto`; `apiKey` is never echoed. `DELETE` removes the connection + `ats_sync_state`
    and **keeps** links and export events. Rate limit
    `await rateLimit('ats-connection', principal.userId, 10, 60)` — `rateLimit`
    (`src/shared/lib/rate-limit.ts:44`) is async and returns a result object; the existing call sites
    in `src/routes/api/work-samples/analyze.ts:97` and `src/routes/api/fingerprint/match.ts:125` show
    the shape.
  - Verify: `curl -X POST` with a bad key returns 400 `invalid_credentials` and inserts no row;
    with a good key the response body contains `credentialLast4` and no `apiKey`; a `member` gets
    403; a `free` org gets 403 `plan`.

- [ ] **Add the export preview and export routes**
  - Files: `src/routes/api/ats/exports.preview.ts` (new), `src/routes/api/ats/exports.ts` (new)
  - Do: preview — `can(principal, 'resource:export')`, body `{ connectionId, builderIdentityIds }`
    capped at `ATS_EXPORT_MAX_CANDIDATES_PER_REQUEST`, runs `findCandidates` per row, returns
    duplicates + exclusions + the exact field list, **writes nothing**. Export — body
    `{ connectionId, items: [{ builderIdentityId, decision, externalCandidateId?, email? }] }`; per
    row: exclusion checks → `createCandidate` or link → `insertLinkIfAbsent` → `insertExportEvent`
    (with `transmittedFields`, never values). One `ats_export_events` row per item including
    skips/failures. A single row's provider error never fails the batch; the response is
    per-item results. Rate limit `await rateLimit('ats-export', principal.userId, 5, 60)`.
  - Do also — **two exclusion gates, not one**: `builder_processing_restrictions` (per-identity
    processing objection) *and* `filterSuppressed` from `src/shared/lib/profile-suppression.ts`
    (global `(source, sourceId)` removal request). That module's doc comment names exports as a
    mandatory enforcement surface and `src/routes/api/export/builders.ts:54` already calls it before emitting
    a single CSV row; pushing a candidate into a third party's permanent hiring record is strictly
    worse than a CSV. Both gates run before any provider call, in preview and in export.
  - Verify: Export 3 builders against the fake provider → 3 links, 3 export events; re-run the same
    request → 0 new links, 3 `skipped_duplicate` events; a restricted identity **and** a suppressed
    identity each yield `skipped_restricted` and no provider call (assert `provider.calls` is empty
    for those rows).

- [ ] **Prove untracking a previously-exported builder still works**
  - Files: `scripts/db/verify-api-isolation-local.mjs`, `tests/unit/shared/lib/repositories/ats.test.ts` (extended — created earlier in Phase 3)
  - Do: regression coverage for spec.md §2 "Untracking a builder". Track a builder, export it (link +
    export-event rows exist), then call `DELETE /api/builders/$builderId` — which reaches
    `deleteOrganizationBuilder` (`src/shared/lib/repositories/organization-builders.ts`) and
    hard-deletes the `organization_builders` row. Assert: the delete returns
    `200 { success: true }` (**not** a 500 foreign-key violation), the `ats_candidate_links` and
    `ats_export_events` rows survive, the link's `conflictState` is set to `'untracked'`, and
    re-tracking the same builder then re-exporting reuses the existing link and creates **no** second
    candidate in the fake provider.
  - Verify: `pnpm test:api-isolation:local` and
    `pnpm test -- tests/unit/shared/lib/repositories/ats.test.ts` — the untrack path is exercised
    after an export in both.

- [ ] **Extend the API isolation script**
  - Files: `scripts/db/verify-api-isolation-local.mjs`
  - Do: add `checkAtsIntegrations()` following the existing `checkEnrichmentAndEvidence()` shape:
    tenant A creates a connection and a link; tenant B cannot read either by id (404/403, no
    existence leak); tenant B cannot export against A's `connectionId`; a spoofed `organizationId` in
    the body is ignored; direct SQL as `builderhunt_app` with no `app.organization_id` returns zero
    rows from all four tables; `builderhunt_platform` cannot select `credential_ciphertext`;
    `builderhunt_worker` cannot update `ats_connections.label`; no response body anywhere contains
    the plaintext key or the ciphertext.
  - Verify: `pnpm test:api-isolation:local` — all checks pass, count increased.

## Phase 4 — Status write-back worker

- [ ] **Grant the worker the two writes `moveBuilderStage` performs** (blocks everything else in this phase)
  - Files: `drizzle/<next>_ats_worker_pipeline_write.sql` (new — let `drizzle-kit` assign the index), `drizzle/meta/_journal.json`, `drizzle/meta/NNNN_snapshot.json`, `drizzle/migration-hashes.json`, `docs/operations/database-roles.md`, `docs/architecture/authorization-matrix.md`
  - Do: `builderhunt_worker` currently holds only `GRANT SELECT ON TABLE organization_builders` with a
    lone `organization_builders_worker_select` policy
    (`drizzle/0018_enrichment_worker_target_access.sql`) — verified at HEAD:
    `grep builderhunt_worker drizzle/*.sql | grep organization_builders` returns that one line.
    [`hiring-pipeline-kanban`](../hiring-pipeline-kanban/tasks.md)'s RLS migration grants the worker
    `SELECT` on `organization_pipeline_stages` and `organization_builder_stage_events` and nothing
    more. `moveBuilderStage` does **two** writes — the card update and one append-only event row — so
    both grants must land, in one file, so they can never ship apart. Mint it with
    `pnpm exec drizzle-kit generate --custom --name ats_worker_pipeline_write` (journal + snapshot
    required, see Phase 1) and **order it after that plan's column and table migrations** — neither
    exists before then. Body, verbatim per spec.md §5:

    ```sql
    CREATE POLICY organization_builders_worker_update ON organization_builders
      FOR UPDATE TO builderhunt_worker
      USING      (organization_id = nullif(current_setting('app.organization_id', true), ''))
      WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));
    --> statement-breakpoint
    GRANT UPDATE (pipeline_stage, pipeline_stage_changed_at, updated_at)
      ON organization_builders TO builderhunt_worker;
    --> statement-breakpoint
    CREATE POLICY organization_builder_stage_events_worker_insert ON organization_builder_stage_events
      FOR INSERT TO builderhunt_worker
      WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));
    --> statement-breakpoint
    GRANT INSERT ON TABLE organization_builder_stage_events TO builderhunt_worker;
    ```

    Nothing wider: no table-level `GRANT UPDATE`, no `SECURITY DEFINER` function, no
    `pipeline_owner_user_id`, `status`, `visibility` or `private_metadata` in the column list, and no
    `UPDATE`/`DELETE` on the events table for anyone (it is append-only). No grant on
    `organization_pipeline_stages` — the sibling plan's `SELECT` already covers `listLocalStageKeys`.
    Head-comment why (spec.md §5's rejected alternatives) and record both widened grants in both docs.
  - Verify: `pnpm db:migrate`; `pnpm test:migration-integrity` and `pnpm test:rls:local` pass; as
    `builderhunt_worker` with `app.organization_id` set,
    `UPDATE organization_builders SET pipeline_stage = 'contacted' WHERE id = '<own-org row>'` succeeds
    and `INSERT INTO organization_builder_stage_events (...) VALUES (...)` for that org succeeds;
    the same two statements against another org's row/organization_id affect **0 rows** and raise
    `new row violates row-level security policy` respectively; with no `app.organization_id` set the
    update affects **0 rows**; `UPDATE organization_builders SET status = 'archived'` fails with
    `permission denied for column`; and `DELETE FROM organization_builder_stage_events` fails with
    `permission denied`.

- [ ] **Add the single stage-source coupling point**
  - Files: `src/lib/ats/stage-source.ts` (new)
  - Do: one exported function `listLocalStageKeys(transaction, organizationId): Promise<string[]>`
    selecting `key` from [`hiring-pipeline-kanban`](../hiring-pipeline-kanban/tasks.md)'s
    `organizationPipelineStages` (composite PK `(organization_id, key)`, tenant-private), filtered on
    `organizationId` and ordered by `position`. **No fallback ladder**: an organization with no stage
    rows returns `[]`, every external stage resolves to `unmapped`, and nothing is written — the
    sibling plan seeds its own `DEFAULT_PIPELINE_STAGES` via `ensureDefaultPipelineStages` and
    enforces the key set with an FK, so a duplicated default list here could only drift out of sync.
    Doc comment: this file is the ONLY place this plan reads that plan's stage model, and this plan
    never creates or migrates `organization_pipeline_stages`,
    `organization_builder_stage_events`, or the three `organization_builders` columns.
  - Verify: `pnpm type-check` (it will not compile until that plan's schema lands — that is the
    intended hard block).

- [ ] **Build the worker repository (lease, cursor, backoff)**
  - Files: `src/shared/lib/repositories/ats-worker.ts` (new), `tests/unit/shared/lib/repositories/ats-worker.test.ts` (new)
  - Do: clone `src/shared/lib/repositories/enrichment-worker.ts` + `billing-worker.ts`:
    `listWorkerOrganizationIds`/`withWorkerOrganization` (its own local pair, matching that
    precedent), `reclaimExpiredAtsLeases`, `claimDueAtsConnections(limit, leaseSeconds)`
    (`UPDATE … SET lease_token = <uuid>, lease_expires_at = now() + interval WHERE (lease_expires_at
    IS NULL OR lease_expires_at < now()) AND backoff_until <= now() AND status = 'active' … RETURNING`),
    `advanceAtsCursor`, `recordAtsRunFailure` (increments `consecutiveFailureCount`, sets
    `backoffUntil = now() + least(power(2, n) * interval '5 min', interval '6 hours')`),
    `applyExternalStatus`, and `isBuilderProcessingRestrictedForWorker` reuse (already exported from
    `enrichment-worker.ts:261`).
  - Do — **`applyExternalStatus` must not write `pipeline_stage` itself.** It updates the
    `ats_candidate_links` row, then, when the resolved stage differs from the current one, delegates
    to `moveBuilderStage(tx, organizationId, organizationBuilderId, { toStage, actorUserId, expectedStage, source: 'ats' })`
    from [`hiring-pipeline-kanban`](../hiring-pipeline-kanban/tasks.md)'s
    `src/shared/lib/repositories/pipeline.ts`. That is the contract that plan's spec.md states it
    owes this one: a direct column write would skip the append-only
    `organization_builder_stage_events` row and lose every ATS-driven transition from the board's own
    history. `actorUserId` = `ats_connections.created_by_user_id` (a real member, already stored,
    already sentinel-reassigned on account deletion by the Phase 1 task) — do not invent a second
    sentinel. `expectedStage` = the stage read at the top of this transaction, so a recruiter's
    concurrent drag returns `{ ok: false, currentStage }` and the worker records the divergence
    instead of clobbering it. `moveBuilderStage` is typed against `TenantTransaction`; widen that
    parameter to the shared transaction type rather than writing a second implementation.
  - Do — `applyExternalStatus` must tolerate a **missing tracking row** (the builder was untracked
    after export, spec.md §2): update the link, set `conflictState = 'untracked'`, skip the move
    entirely, never throw.
  - Do also: assert in tests that a claimed connection cannot be claimed again before its lease
    expires; that a link whose `organization_builders` row no longer exists yields `'untracked'` and
    no error; that one applied stage produces exactly one `organization_builder_stage_events` row
    with `source = 'ats'`; that an `expectedStage` mismatch performs no update and no insert; and
    that the stage write is a 0-row no-op when `app.organization_id` is unset.
  - Verify: `pnpm test -- tests/unit/shared/lib/repositories/ats-worker.test.ts`.

- [ ] **Implement the sync worker**
  - Files: `src/lib/ats/worker.ts` (new), `tests/unit/lib/ats/worker.test.ts` (new)
  - Do: `runAtsSyncWorker()` returning
    `{ disabled, connectionsClaimed, connectionsProcessed, linksUpdated, stagesApplied, unmapped, restrictedSkipped, rateLimited, failed, leasesReclaimed }`.
    `ATS_INTEGRATIONS_ENABLED !== 'true'` → `{ disabled: true, … }`. Per connection, in its own
    transaction and org context: decrypt the credential, page `listUpdatedCandidates` up to
    `ATS_SYNC_MAX_PAGES_PER_RUN`, advance the cursor only after each page persists, resolve each
    candidate's stage via `resolveExternalStage` + `listLocalStageKeys`, apply per spec.md §5.
    `rate_limited` → keep cursor + set backoff, stop that connection. `invalid_credentials` /
    `permission_denied` → set connection status + `lastErrorCode`/`lastErrorAt`. Any other throw →
    `recordAtsRunFailure`, continue to the next connection. Always release the lease.
    Also check `isSuppressed` (`src/shared/lib/profile-suppression.ts`) per link alongside the
    restriction check — a subject who filed a global profile-removal request after export stops being
    refreshed, same as a restricted one.
  - Do also test: a connection whose provider throws does not prevent the next connection from
    syncing; two consecutive runs over the same page produce identical state (idempotent); an
    unmapped stage leaves `pipeline_stage` untouched, writes no stage event, and sets `conflictState`.
  - Verify: `pnpm test -- tests/unit/lib/ats/worker.test.ts`.

- [ ] **Add the run-worker route, the schedule registry entry, and the cron row**
  - Files: `src/routes/api/admin/ats-sync/run-worker.ts` (new), `src/shared/lib/operational-schedules.ts`, `tests/unit/shared/lib/operational-schedules.test.ts`, `docs/operations/deploy-runbook.md`
  - Do: clone `src/routes/api/admin/alerts/run-worker.ts` exactly —
    `tryCronPrincipal(request) ?? await requirePlatformAdminPrincipal(request)`, **the `withJobRun`
    wrapper** (`const { payload: result } = await withJobRun({ jobKey: 'ats.sync' }, async () => { const outcome = await runAtsSyncWorker(); return { processedCount: outcome.connectionsProcessed, failedCount: outcome.failed, payload: outcome } })`
    — every other `run-worker` route does this and it is what gives the run a `job_runs` row that is
    closed even when the worker throws),
    `auditPlatformAdminAction(principal, { action: 'admin.worker.run', targetType: 'worker', targetId: 'ats-sync', result: 'allowed' })`,
    `platformAdminErrorResponse(err)` fallback. Then register the job in `OPERATIONAL_SCHEDULES`:
    `{ jobKey: 'ats.sync', cronExpression: '*/15 * * * *', timezone: 'UTC', scope: 'organization', label: 'ATS status sync', sourceRoute: '/api/admin/ats-sync/run-worker' }`
    — `withJobRun` resolves `operational_schedules` by `jobKey`, and `assertRegistryIsSafe` requires
    a unique key and an `/api/admin/` route. UTC, not Europe/Copenhagen, matching the file's own rule
    that sub-hourly mechanical polling is never pinned to a local zone. Add the row
    `| POST /api/admin/ats-sync/run-worker | ATS status write-back | ATS_* |` to the runbook's
    "Workers / scrapers" table (`docs/operations/deploy-runbook.md:137-154`) with a 15-minute cadence.
  - Verify: `pnpm test -- tests/unit/shared/lib/operational-schedules.test.ts`;
    `pnpm security:route-coverage` (the route is guarded, so it must pass without an allowlist entry);
    unauthenticated `curl` → 401/403; with `CRON_SECRET` → `{ ok: true, disabled: true }` while the
    feature is off, and real counts once enabled, with one closed `job_runs` row per call either way.

- [ ] **Add the sync-status route**
  - Files: `src/routes/api/ats/sync-status.ts` (new)
  - Do: `can(principal, 'integration:read')`; returns per connection `{ status, lastVerifiedAt,
    lastSyncedAt, consecutiveFailureCount, lastErrorCode, backoffUntil, linkCount,
    unmappedStageCount, externalMissingCount, restrictedCount, untrackedCount }`. No credential
    fields, no raw provider payloads.
  - Verify: `curl` as owner returns the shape; as `member` 403; tenant B sees only its own rows.

- [ ] **Prove the worker stage write against the real non-owner role**
  - Files: `scripts/db/verify-api-isolation-local.mjs`
  - Do: extend the existing `checkWorkerIsolation()` (or add `checkAtsWorkerStageWrite()` beside it) to
    run `runAtsSyncWorker()` against the fake provider while connected as the actual
    `builderhunt_worker` role — not the DB owner — per
    [`app-reality`](../../_meta/app-reality.md) constraint 7. Assert: a mapped external stage updates
    tenant A's `pipeline_stage`/`pipeline_stage_changed_at` **and inserts one
    `organization_builder_stage_events` row with `source = 'ats'`** (the event insert is a separate
    grant and fails separately — assert it explicitly, not implicitly through the card); tenant B's
    identical row is **unchanged** and gains no event; an attempt to write `status` or
    `pipeline_owner_user_id` raises `permission denied for column`; an attempt to `DELETE` a stage
    event raises `permission denied`; a run with no `app.organization_id` in context updates 0 rows
    and raises nothing; and a tenant whose provider throws does not prevent the next tenant's stage
    from being applied in the same run.
  - Verify: `pnpm test:api-isolation:local` — all new checks pass, count increased. If any of these
    fails, the Phase 4 grant migration is wrong; fix the migration, never the assertion.

## Phase 5 — UI, failure surface, notification, Ashby

- [ ] **Add the failure email**
  - Files: `src/shared/lib/email.ts`, `tests/unit/shared/lib/email.test.ts`
  - Do: `sendAtsConnectionFailureEmail(to, { provider, label, errorCode })` following the existing
    `sendBillingPaymentFailedEmail` shape (dev-mode log path when `RESEND_API_KEY` is unset, E2E
    outbox honoured). Body names the provider and links to `/settings/integrations`; it must not
    contain the key, the last4, or any candidate data.
  - Verify: `pnpm test -- tests/unit/shared/lib/email.test.ts` — rendered HTML contains no
    credential-shaped substring.

- [ ] **Wire one-notice-per-failure dedup into the worker**
  - Files: `src/lib/ats/worker.ts` (extended — created in Phase 4), `tests/unit/lib/ats/worker.test.ts` (extended — created in Phase 4)
  - Do: after setting `status = 'invalid_credentials'`, send the email only when
    `failureNotifiedAt IS NULL OR failureNotifiedAt < lastErrorAt`, then set
    `failureNotifiedAt = now()` in the same transaction. Recipients via the organization owner's
    email — `findOrganizationOwnerEmail`, exported from `src/shared/lib/repositories/billing.ts` and
    already consumed by `billing/notifications.ts:97`.
  - Verify: Test asserts three consecutive failing runs send exactly one email; a recovery followed
    by a new failure sends a second.

- [ ] **Build the integrations settings page**
  - Files: `src/modules/dashboard/components/AtsIntegrationsPage.tsx` (new), `src/routes/_dashboard/settings/integrations.tsx` (new), `src/modules/dashboard/ui/shell/nav-config.ts`
  - Do: route modelled on `src/routes/_dashboard/settings/team.tsx` (beforeLoad session guard,
    `useQuery` keyed via `organizationQueryKey` from `src/shared/lib/query-keys.ts`, presentational
    component in `modules/dashboard`).
    Renders per connection: provider, label, `••••{credentialLast4}` + fingerprint, status badge,
    timestamps, link/unmapped/missing counts, transmit-field toggles (`bio`, `location`, `topics` —
    each labelled with why it is off by default), Test connection, Disconnect; plus an
    add-connection form with a write-only API-key field (`type="password"`, `autoComplete="off"`) and
    the versioned disclosure checkbox. Free/Pro: locked card with a Team pill linking to the existing
    plan-request flow. Hidden entirely when `ATS_INTEGRATIONS_ENABLED=false`.
    **Navigation goes in the shell, not `UserMenu.tsx`** — that component renders only Account and
    Sign out and has no settings list. Add
    `{ to: '/settings/integrations', label: 'Integrations', icon: Plug, group: 'Organization' }`
    to the `workspace` area's `items` in `src/modules/dashboard/ui/shell/nav-config.ts`; that area's
    `routes` already claims the `/settings` prefix, which
    `tests/unit/modules/dashboard/ui/shell/nav-config.test.ts` requires ("keeps every destination
    inside an area that owns its prefix").
  - Verify: `pnpm test -- tests/unit/modules/dashboard/ui/shell/nav-config.test.ts`; owner sees the
    page and can add/test/disconnect; the key field is never repopulated after save; a `member` sees
    a read-only view; a `free` org sees the locked card.

- [ ] **Build the stage-mapping editor**
  - Files: `src/modules/dashboard/components/AtsStageMappingEditor.tsx` (new)
  - Do: lists unmapped external stages observed on this connection with a select of local stage keys
    from `listLocalStageKeys`, plus existing rules with remove. Saves via
    `PUT /api/ats/connections/$id/stage-mappings`. Shows `stale_local_stage` rules distinctly with a
    "this stage no longer exists" hint.
  - Verify: Mapping `'Take-home sent'` then re-running the worker moves the row's
    `pipeline_stage` and clears `conflictState`.

- [ ] **Build the shared export dialog and mount it on three surfaces**
  - Files: `src/modules/dashboard/components/AtsExportDialog.tsx` (new), `src/modules/dashboard/components/ExportsPage.tsx`, `src/routes/_dashboard/sprints/index.tsx`
  - Do: one component taking `{ builderIdentityIds }`; calls `/api/ats/exports/preview`, renders the
    verbatim field allowlist, the restriction **and suppression** exclusions, and duplicates with
    per-row Link / Create new / Skip, then posts `/api/ats/exports` and shows per-item results. Mount
    from a "Send to ATS" action next to the existing "Download CSV" button in
    `ExportsPage.tsx` (the `/exports` route — the tracked-builder list; there is no `/me/builders`
    route, and `src/routes/_dashboard/me/index.tsx` is the account page listing *claimed* profiles,
    not tracked builders), on the pipeline board owned by
    [`hiring-pipeline-kanban`](../hiring-pipeline-kanban/spec.md), and on a sprint's results
    selection. `ExportsPage` already fetches `/api/me/builders`, whose rows carry `identityId` —
    that is the id to pass. Batch client-side above `ATS_EXPORT_MAX_CANDIDATES_PER_REQUEST`.
  - Verify: Exporting 30 selected builders issues two requests and reports 30 results; the dialog
    lists exactly the fields the payload builder produced.

- [ ] **Show provenance and conflicts on the pipeline row**
  - Files: `src/modules/pipeline/components/PipelineCard.tsx` (new — created by the sibling plan, not by this one), `src/modules/pipeline/components/CardDetailDrawer.tsx` (new — same), neither of which exists at HEAD because both are created by [`hiring-pipeline-kanban`](../hiring-pipeline-kanban/spec.md), which is why this task sits behind that hard block; this plan adds a chip, it does not restructure them), `src/modules/dashboard/components/AtsIntegrationsPage.tsx` (extended — created earlier in Phase 5)
  - Do: chip `"{stage} · from {provider} · {relative time}"` when `mappedStage` is set; an
    "unmapped stage" affordance opening the mapping editor; "no longer in {provider}" for
    `conflictState = 'external_missing'`; "processing restricted" for `'restricted'`. `'untracked'`
    links have no pipeline row to render on — they appear only in the integrations page's history
    count, never as a phantom card.
  - Verify: Each of the five `conflictState` values renders its own affordance (or, for
    `'untracked'`, provably renders no pipeline card) in a manual pass.

- [ ] **Implement the Ashby adapter**
  - Files: `src/lib/ats/providers/ashby.ts` (new), `tests/unit/lib/ats/providers/ashby.test.ts` (new)
  - Do: per the Phase-2 register — same basic-auth credential shape (so `AtsCredential` is unchanged),
    RPC-over-POST endpoints, `missing_endpoint_permission` mapped to `permission_denied`, rate-limit
    headers mapped to `retryAfterMs`. Register it in `src/lib/ats/registry.ts`.
  - Verify: `pnpm test -- tests/unit/lib/ats/providers/ashby.test.ts` — `describeAtsProviderContract`
    green against the stubbed transport, with no change to `provider.ts`.

- [ ] **Update pricing copy and the processor disclosure**
  - Files: `src/shared/lib/billing-shared.ts`, `src/routes/_landing/legal/privacy.tsx`
  - Do: add `'ATS integrations (Greenhouse, Ashby)'` to `PLAN_PRICING.team.features`. Add to the
    privacy policy's processor/recipient list: "Customer-configured ATS (Greenhouse, Lever, Ashby) —
    recipient of candidate data the customer chooses to export; the customer's own agreement with
    that vendor governs it." Extend the subject-facing restriction response copy to disclose that an
    exported copy may already exist in a customer's ATS and cannot be recalled by BuilderHunt.
  - Verify: `/pricing` shows the Team line; `/legal/privacy` lists the ATS recipients.

- [ ] **Full verification pass**
  - Files: none
  - Do: `pnpm ci:local`, then the gates it does not cover:
    `pnpm test:rls:local && pnpm test:api-isolation:local && pnpm test:migration-integrity && pnpm security:boundaries && pnpm security:route-coverage`.
    Manual matrix: `ATS_INTEGRATIONS_ENABLED=false` hides the nav entry and 503s every route while
    the worker returns `{ disabled: true }`; a revoked key produces exactly one email and a blocked
    export; a rate-limited provider backs off without an email; a `free` org is blocked at both the
    UI and the API; hard-deleting the account that created a connection succeeds and leaves the
    export events intact under `system-deleted-user`.
  - Verify: All green; the degradation and gating matrix behaves per spec.

## Phase 6 — Lever (OAuth, deliberately last)

- [ ] **Design and record the Lever OAuth credential model**
  - Files: `docs/operations/ats-provider-register.md` (extended — created in Phase 2)
  - Do: record the authorization-code flow, redirect URI, scopes, token/refresh lifetimes, and how a
    refresh token would be stored (it is a second secret per connection — decide whether
    `ats_connections` gains a second ciphertext column or a dedicated table) and rotated. **Do not
    write the adapter until this is recorded and reviewed.**
  - Verify: Register section exists and names the storage decision explicitly.

- [ ] **Implement the Lever adapter**
  - Files: `src/lib/ats/providers/lever.ts` (new), `tests/unit/lib/ats/providers/lever.test.ts` (new)
  - Do: the Opportunity-based candidate model, `perform_as` on writes, and whichever credential mode
    the previous task settled on. Register in `src/lib/ats/registry.ts`.
  - Verify: `pnpm test -- tests/unit/lib/ats/providers/lever.test.ts` — contract suite green with no
    change to `provider.ts`; if the OAuth
    model forces a `provider.ts` change, stop and revisit the contract deliberately rather than
    widening it ad hoc.
