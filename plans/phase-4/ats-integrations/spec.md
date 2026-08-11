# ATS Integrations (Greenhouse, Lever, Ashby) (spec)

> **Status**: `pending`
> **Depends on**: [`hiring-pipeline-kanban`](../hiring-pipeline-kanban/spec.md) (hard — the pipeline stage model this plan maps external ATS status onto); [`security-and-multitenancy`](../../implemented/01-security-and-multitenancy/spec.md) (per-organization third-party credentials, RLS, tenant-scoped sync state); [`stripe-billing-platform`](../../implemented/30-stripe-billing-platform/spec.md) (the Team-tier gate this feature sells into does not bill anyone yet); [`legal-and-compliance`](../../implemented/04-legal-and-compliance/spec.md) (candidate data leaving the product to a third-party processor).
> **Blocks**: nothing
> **Reality check**: No ATS code, no per-tenant third-party credential storage, and no general-purpose secret encryption exist. The only encryption helper in the repo is `src/shared/lib/crypto/webhook-payload.ts`, whose own doc comment says "this is not a general-purpose encryption utility" and which is keyed on `WEBHOOK_PAYLOAD_ENCRYPTION_KEY` (only required when `STRIPE_BILLING_ENABLED=true`). The reusable foundations are real: the provider-contract + deterministic-fake + shared-contract-suite pattern in `src/shared/lib/billing/{provider.ts,fake-provider.ts,provider-contract-suite.ts}`, the connector registry in `src/lib/enrichment/registry.ts`, the lease/backoff worker in `src/lib/enrichment/worker.ts` + `src/shared/lib/repositories/enrichment-worker.ts`, the cross-org worker sweep in `src/shared/lib/repositories/billing-worker.ts`, and the notification-dedup idea in `src/shared/lib/billing/notifications.ts`. Re-verified against
`master` on 2026-07-27: still no `src/lib/ats/`, no `secret-box.ts`, no `integration:*` permission,
no `ATS_*` env var. Two surfaces moved since the first draft — dashboard navigation now lives in
`src/modules/dashboard/ui/shell/nav-config.ts` (not `UserMenu.tsx`), and the tracked-builder list is
`/exports` (`ExportsPage.tsx`), not a `/me/builders` route, which never existed.

## Problem

BuilderHunt ends at `/api/export/builders` — a CSV. A recruiting team's system of record is their
ATS, so every sourced candidate gets re-typed by hand into Greenhouse/Lever/Ashby, statuses diverge
within a day, and BuilderHunt never learns which sourced builder was actually contacted, interviewed
or hired. Two consequences: the product stays "one more tab" instead of part of the official
pipeline, and `src/lib/score.ts` has **zero outcome labels** to be evaluated against.

## Goal

1. Push a selected set of tracked builders (from `/exports`, the pipeline board, or a sprint's
   results) into the organization's own ATS as candidates, deduplicated against candidates that
   already exist there.
2. Poll status back and reflect it on the pipeline stage model that
   [`hiring-pipeline-kanban`](../hiring-pipeline-kanban/spec.md) owns, tolerating custom stages this
   plan cannot know in advance.
3. One provider contract + one deterministic fake, then per-provider adapters. Greenhouse ships
   first.
4. A tenant's ATS credential is encrypted at rest, never returned by any API, and never readable by
   a platform admin.

## Non-goals

- **Not an ATS.** No job/req creation, offers, scorecards, interview kits, feedback, EEO or
  demographic data, approvals, or job-board publishing.
- **Not a two-way source of truth for interview scheduling.**
  [`calendar-scheduling-interview-intelligence`](../../implemented/44-calendar-scheduling-interview-intelligence/spec.md)
  owns availability, booking, transcription and interview reports, and lists "a general ATS" as its
  own non-goal. Boundary: **this plan never reads or writes interview events, times, attendees,
  transcripts, or reports in either direction.** The only thing that crosses is the candidate's
  external stage label. If a customer schedules in their ATS, that stays in their ATS.
- **No webhooks.** See §5 for why polling, not "we ran out of time".
- **No file/résumé transfer.** No attachment upload, no document storage class, no CV parsing.
- **No import.** An ATS candidate BuilderHunt never exported is ignored forever; this is not a
  candidate-ingestion pipeline and creates no shadow copy of the customer's ATS.
- **No writes to existing ATS records.** BuilderHunt only ever creates candidates it has no link for
  (§4). It never PATCHes, re-tags, re-stages, or deletes anything in the customer's ATS.
- **No automatic export.** Every export is an explicit human action on a named selection, because
  every export is a data-processing disclosure event.
- No AI. No new AI task, no credit consumption, no `src/shared/lib/ai/tasks.ts` entry.
- No OAuth in phase 1 (Lever's customer-facing path) — deliberately deferred, see §3.

## User stories

1. As a **Team-tier owner**, I paste my Greenhouse Harvest API key into `/settings/integrations`, it
   is verified live before it is stored, and afterwards I only ever see `••••3f9a` plus a
   fingerprint — the key is never shown again, by anyone, including support.
2. As a **Team-tier owner/admin**, I select 12 builders on the pipeline board, hit "Send to ATS", and
   see exactly which fields will be transmitted, which 2 already exist in Greenhouse (with their
   names), and which 1 is excluded because the subject filed a processing restriction. I confirm; 9
   candidates are created, 2 are linked without being modified, 1 is skipped.
3. As a **Team-tier admin**, a candidate moves to "Offer" in Greenhouse and the BuilderHunt pipeline
   row shows `Offer · from Greenhouse · 6 min ago` without anyone touching it.
4. As a **Team-tier admin**, Greenhouse returns "Take-home sent" — a stage nobody mapped. The row
   keeps its local stage, and the integrations page shows `1 unmapped stage` with a one-click
   "map 'Take-home sent' → …" control.
5. As a **Team-tier owner**, my API key is revoked in Greenhouse. Sync pauses, the integrations page
   shows `Credentials invalid`, exports are blocked with a Reconnect CTA, and I get exactly one
   email — not one per worker run.
6. As a **Pro user**, `/settings/integrations` shows the feature with a Team pill linking to the
   existing plan-request flow.

## Architecture

### 1. Prerequisite: a real secret-at-rest helper (this is the first-order problem)

There is no general-purpose encryption in the repo. This plan must build one before anything else.

- `src/shared/lib/crypto/secret-box.ts` (new) — AES-256-GCM, adapted from
  `crypto/webhook-payload.ts` with three deliberate additions:
  - **versioned envelope** `v1:iv:authTag:ciphertext` so the key can be rotated
    (`webhook-payload.ts`'s unversioned format cannot);
  - **AAD binding**: additional authenticated data is `${organizationId}:${provider}`, so a
    ciphertext copied from tenant A's row into tenant B's row fails authentication instead of
    decrypting — RLS is the first layer, this is the second;
  - `secretFingerprint(plaintext)` → first 12 hex of `sha256`, and `secretLast4(plaintext)`, the
    only two derived values any API may return.
- New env vars: `ATS_CREDENTIAL_ENCRYPTION_KEY` (64 hex chars) and, for rotation overlap,
  `ATS_CREDENTIAL_ENCRYPTION_KEY_PREVIOUS` — mirroring the `STRIPE_WEBHOOK_SECRET_PREVIOUS`
  precedent already in `env.ts`. Deliberately a **separate key** from
  `WEBHOOK_PAYLOAD_ENCRYPTION_KEY`: different blast radius, different rotation cadence.
  `env.ts`'s `superRefine` fails closed in **every** environment when
  `ATS_INTEGRATIONS_ENABLED=true` and the key is absent or not 64 hex chars — the same
  fail-closed-everywhere treatment Stripe gets, not the production-only treatment enrichment gets.
- **Write-only rule**: no route, DTO, log line, error message, or admin surface returns
  `credential_ciphertext`. Enforced by (a) a source-scanning boundary test that allowlists the exact
  files permitted to reference the column (repository + crypto module only), modelled on
  `tests/unit/shared/lib/client-route-boundary.test.ts`; (b) adding `credential` to the `sensitiveKey`
  regex in `src/shared/lib/log.ts`; (c) column-level `GRANT` so `builderhunt_platform` physically
  cannot `SELECT` the ciphertext column.

### 2. Schema (4 new tenant-private tables)

```ts
// src/shared/lib/db/schema.ts
export const atsConnections = pgTable('ats_connections', {
  id: text('id').primaryKey(),                                  // randomId() from ~/lib/utils
  organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),                         // greenhouse | lever | ashby
  label: text('label').notNull(),
  credentialCiphertext: text('credential_ciphertext').notNull(), // v1:iv:tag:ct — NEVER selected into a DTO
  credentialFingerprint: text('credential_fingerprint').notNull(),
  credentialLast4: text('credential_last4').notNull(),
  credentialKeyVersion: integer('credential_key_version').notNull().default(1),
  actingUserReference: text('acting_user_reference'),            // Greenhouse On-Behalf-Of / Lever perform_as user id
  stageMappings: jsonb('stage_mappings').$type<AtsStageMappingRule[]>().default([]).notNull(),
  stageMappingsVersion: integer('stage_mappings_version').notNull().default(1),
  transmitBio: boolean('transmit_bio').notNull().default(false),      // opt-in, see §7
  transmitLocation: boolean('transmit_location').notNull().default(false),
  transmitTopics: boolean('transmit_topics').notNull().default(false), // opt-in — app-reality.md constraint 8, see §7
  disclosureVersion: text('disclosure_version').notNull(),
  disclosureAcknowledgedAt: timestamp('disclosure_acknowledged_at', { withTimezone: true }).notNull(),
  status: text('status').notNull().default('active'),            // active | invalid_credentials | revoked | disabled
  lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
  lastErrorCode: text('last_error_code'),
  lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
  failureNotifiedAt: timestamp('failure_notified_at', { withTimezone: true }),
  createdByUserId: text('created_by_user_id').notNull().references(() => authUsers.id, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('ats_connections_org_provider_unique').on(t.organizationId, t.provider),
  uniqueIndex('ats_connections_organization_id_id_unique').on(t.organizationId, t.id), // composite-FK target
  check('ats_connections_provider_check', sql`${t.provider} in ('greenhouse','lever','ashby')`),
  check('ats_connections_status_check', sql`${t.status} in ('active','invalid_credentials','revoked','disabled')`),
])

// ats_candidate_links — columns: id, organizationId, connectionId, provider, builderIdentityId
// (FK -> builder_identities, onDelete restrict), externalCandidateId, externalApplicationId?,
// externalJobId?, matchMethod (provider_profile_url | operator_email | name_and_source_url |
// created_new | manual), matchConfidence (exact | probable | created), externalStatus (RAW provider
// label, verbatim), externalStatusAt, mappedStage (resolved local stage key or null), conflictState
// (none | unmapped_external_stage | external_missing | restricted | untracked), lastSyncedAt,
// createdByUserId, createdAt, updatedAt. Its constraints are the load-bearing part:
export const atsCandidateLinksConstraints = (t) => [
  uniqueIndex('ats_candidate_links_org_provider_external_unique').on(t.organizationId, t.provider, t.externalCandidateId),
  uniqueIndex('ats_candidate_links_org_connection_identity_unique').on(t.organizationId, t.connectionId, t.builderIdentityId),
  foreignKey({ columns: [t.organizationId, t.connectionId], foreignColumns: [atsConnections.organizationId, atsConnections.id], name: 'ats_candidate_links_connection_fk' }),
  // Deliberately NO composite FK to organization_builders — see "Untracking a builder" below.
  index('ats_candidate_links_conflict_idx').on(t.organizationId, t.conflictState),
]
```

**Every `auth_users` reference these tables add must be taught to `hardDeleteAccountSubject`.**
`ats_connections.createdByUserId`, `ats_candidate_links.createdByUserId` and
`ats_export_events.actorUserId` are all `onDelete: 'restrict'` — deliberately, because these are
organization-owned audit records that must not vanish when the operator who made them leaves. But
`hardDeleteAccountSubject` (`src/shared/lib/repositories/account-privacy.ts`) does **not** discover
`restrict` references generically: it carries an explicit list and reassigns
`organization_builders.creator_user_id` / `sourcing_sprints.creator_user_id` to the permanent
`system-deleted-user` sentinel (`DELETED_USER_SENTINEL_ID`, `drizzle/0026_deleted_user_sentinel.sql`).
Adding a `restrict` reference without extending that list reintroduces exactly the bug 0026 exists to
fix — every account that ever configured a connection or ran an export becomes permanently
undeletable, failing silently in a swallowed worker log. This is
[`app-reality`](../../_meta/app-reality.md) constraint 6, and the fix is one `UPDATE … SET
… = DELETED_USER_SENTINEL_ID` per column inside the existing per-membership tenant transaction.
`scripts/db/verify-api-isolation-local.mjs`'s `checkLegalRunWorker` is what caught the original and
is where the regression check belongs.

**Untracking a builder — why there is no FK to `organization_builders`.** An earlier draft of this
table carried a composite FK `(organizationId, builderIdentityId) → organizationBuilders`. That is
wrong: `deleteOrganizationBuilder`
(`src/shared/lib/repositories/organization-builders.ts`) **hard-deletes** the tracking row, and it is
reached from the existing `DELETE /api/builders/$builderId`
(`src/routes/api/builders/$builderId.ts`). Because link rows are deliberately retained forever for
audit, that FK would make untracking any previously-exported builder raise a foreign-key violation
and 500 a route that works today. Three options were considered: `ON DELETE SET NULL` on the
tracking reference (needs a nullable duplicate of the join key the pipeline UI reads — messy),
blocking untrack (breaks existing behavior for a bookkeeping reason — unacceptable), or **anchoring
the link to the global identity instead**. Chosen: the only FK is
`builderIdentityId → builder_identities.id` (`onDelete: 'restrict'`, matching
`organization_builders`' own choice). `builder_identities` is `global-public`, so a single-column FK
is the correct shape and
[`security-policy`](../../_meta/security-policy.md) #6's composite-FK rule (which governs
*tenant-to-tenant* relations) is satisfied by `organization_id` + RLS on this table.

Resulting semantics: untrack succeeds unchanged; the link row survives with
`conflictState = 'untracked'` and the sync worker skips its stage write (there is no tracking row to
write to) while still refreshing `externalStatus`; and re-tracking the same builder later reuses the
surviving link row, so **re-tracking never creates a second candidate in the customer's ATS** — a
property that falls out of retaining the row rather than one that needed extra code.

`ats_export_events` — append-only audit: `id`, `organizationId`, `connectionId`, `provider`,
`actorUserId`, `builderIdentityId` (FK → `builder_identities`, same reasoning — never to
`organization_builders`), `action` (`exported | linked_existing | skipped_restricted |
skipped_duplicate | failed`), `transmittedFields jsonb $type<string[]>()` (**field names only, never
values** — that is how "redacted per policy" is satisfied without the audit table becoming a second
copy of the candidate data), `externalCandidateId`, `errorCode`, `createdAt`. No `UPDATE`/`DELETE`
grant for any role.

`ats_sync_state` — one row per connection: `id`, `organizationId`, `connectionId` (unique with org),
`cursor`, `cursorKind`, `leaseToken`, `leaseExpiresAt`, `lastRunAt`, `lastRunStatus`,
`consecutiveFailureCount`, `backoffUntil`, `linksUpdated`, timestamps. Composite FK on
`(organizationId, connectionId)`.

**Why sync state is a separate table**: folding the cursor and lease onto `ats_connections` would
force `builderhunt_worker` to hold `UPDATE` on the very row that stores the ciphertext, and would mix
operator-edited configuration with worker-owned operational state. Split, the grants stay clean.

**Data classes**: all four → `tenant-private`, `organization_id`-owned, recorded in
`docs/architecture/data-classification.md`. `stage_mappings` as JSONB is within
[`security-policy`](../../_meta/security-policy.md) #8 — validated, versioned config (zod +
`stageMappingsVersion`), not authorization or relational data.

**RLS/grants** (hand-written migration mirroring `drizzle/0044_abuse_usage_integrity_rls_grants.sql`):
`ENABLE` + `FORCE` on all four, with per-statement `USING`/`WITH CHECK` on
`organization_id = nullif(current_setting('app.organization_id', true), '')`.

- `builderhunt_app` — full `SELECT`/`INSERT`/`UPDATE`/`DELETE` on `ats_connections` (the synchronous
  export path must decrypt the credential in-request, so this role does hold the ciphertext column),
  `SELECT`/`INSERT`/`UPDATE` on `ats_candidate_links`, `INSERT`/`SELECT` on `ats_export_events`,
  `SELECT`/`INSERT`/`DELETE` on `ats_sync_state`. No `UPDATE` on `ats_export_events` — append-only.
- `builderhunt_worker` — `SELECT` on `ats_connections` and `ats_candidate_links`, `INSERT`/`UPDATE`
  on `ats_candidate_links` and `ats_sync_state`, `INSERT` on `ats_export_events`, and **only**
  column-level `UPDATE (status, last_verified_at, last_error_code, last_error_at,
  failure_notified_at, updated_at)` on `ats_connections` — a buggy worker can never rewrite a
  credential or a stage mapping.
- `builderhunt_platform` — **no grant of any kind on `credential_ciphertext`**: `SELECT` is granted
  column-by-column over the non-secret columns only, so a platform admin can diagnose a connection's
  status and never read its key. `SELECT` on `ats_export_events` for abuse/support investigation.
- `builderhunt_auth` and `builderhunt_capability` — nothing on any of the four tables.
  `builderhunt_capability` (`drizzle/0078_capability_role.sql`) exists only to resolve an
  accountless candidate's scheduling capability and must never reach an integration credential.
- `builderhunt_readonly` — nothing. No `PUBLIC`, `TRUNCATE`, or `REFERENCES` privileges anywhere.

Two further grants this plan needs live on *another plan's* tables and are covered in §5, not here:
`INSERT` on `organization_builder_stage_events` and column-scoped `UPDATE` on
`organization_builders`, both for `builderhunt_worker`.

### 3. One provider contract, three adapters

`src/lib/ats/provider.ts` (mirrors `src/shared/lib/billing/provider.ts`):

```ts
export type AtsProviderId = 'greenhouse' | 'lever' | 'ashby'
export type AtsErrorCode = 'invalid_credentials' | 'permission_denied' | 'rate_limited'
  | 'not_found' | 'conflict' | 'invalid_payload' | 'upstream_unavailable'
export class AtsProviderError extends Error { constructor(message: string, readonly code: AtsErrorCode, readonly retryAfterMs?: number) {…} }

export interface AtsCredential { apiKey: string; actingUserReference?: string }

/** The complete transmit allowlist. Nothing outside this interface ever leaves the product. */
export interface AtsCandidatePayload {
  fullName: string
  sourceProfileUrl: string
  primaryLanguage?: string
  email?: string       // ONLY when an operator typed it in the export dialog (§4)
  topics?: string[]    // opt-in per connection — synthesized on several sources, see §7
  bio?: string         // opt-in per connection
  location?: string    // opt-in per connection
}

export interface AtsExternalCandidate {
  externalCandidateId: string
  externalApplicationId?: string
  externalJobId?: string
  name: string
  profileUrls: string[]
  externalStatus: string       // RAW provider label, never normalized by the adapter
  externalStatusAt: string     // ISO
  updatedAt: string            // ISO — the poll cursor's ordering key
}

export interface AtsProvider {
  readonly id: AtsProviderId
  readonly requiresActingUserReference: boolean
  verifyCredential(c: AtsCredential): Promise<{ accountLabel: string | null }>
  findCandidates(c: AtsCredential, q: { profileUrl: string; fullName: string; email?: string }): Promise<AtsExternalCandidate[]>
  createCandidate(c: AtsCredential, input: { payload: AtsCandidatePayload; externalJobId?: string; idempotencyKey: string }): Promise<AtsExternalCandidate>
  listUpdatedCandidates(c: AtsCredential, input: { cursor: string | null; limit: number }): Promise<{ candidates: AtsExternalCandidate[]; nextCursor: string | null; exhausted: boolean }>
}
```

Plus `src/lib/ats/fake-provider.ts` — deterministic, in-memory, seeded from a fixture, with an
injectable scenario switch (`rate_limited`, `invalid_credentials`, `not_found`,
`duplicate_on_create`), exactly as `billing/fake-provider.ts` does; and
`src/lib/ats/provider-contract-suite.ts` — a shared vitest suite every adapter must pass, exactly as
`billing/provider-contract-suite.ts` does. **CI never needs live ATS credentials.** Registry:
`src/lib/ats/registry.ts`, returning only providers that are both compiled in and present in
`ATS_ENABLED_PROVIDERS`, cloning `src/lib/enrichment/registry.ts`.

**Phase 1 ships Greenhouse.** Their auth models genuinely differ, and the ordering follows from that
(each fact below was checked against vendor/docs sources in 2026-07, and **each is re-confirmed as a
Phase-2 task before the adapter is written** — do not treat these as frozen):

| Provider | Auth | Write quirk | Shape | Phase |
| --- | --- | --- | --- | --- |
| Greenhouse (Harvest) | HTTP Basic, API key as username, blank password | `On-Behalf-Of: <active Greenhouse user id>` required on every write; omitting it 403s | REST | 1 |
| Ashby | HTTP Basic, API key as username, blank password | per-key endpoint permissions → 403 `missing_endpoint_permission`; standard `ratelimit-*` headers | RPC-over-POST (`candidate.create`, `candidate.search`) | 5 |
| Lever | Basic (API key) for internal use, **OAuth 2.0 authorization code for customer-facing apps** | `perform_as` query parameter on writes; "Opportunity" is the candidate object | REST | 6 |

Greenhouse first: largest installed base among the recruiting teams this sells to, and a plain API
key means no partner-program or OAuth-app approval gate between us and a working integration. Ashby
second because it is mechanically the closest sibling (same basic-auth credential model — the
`AtsCredential` shape does not change) at a fraction of the risk. Lever last because doing it
properly for customers means an OAuth app: redirect URIs, refresh-token storage, token rotation — a
**second credential model**, deliberately out of scope until the first two are in production.

### 4. Deduplication — both directions

BuilderHunt's ground truth: `RawBuilder` (`src/lib/sources/types.ts`) and `builder_identities`
(`schema.ts`) carry **no email field at all**. `builder_identities`' full column set is `source`,
`sourceId`, `username`, `displayName`, `avatarUrl`, `bio`, `profileUrl`, `followersCount`,
`language`, `country` plus timestamps — note that **`topics` is not on it**: for a tracked builder,
topics live in `organization_builders.private_metadata.topics`, which is what
`GET /api/me/builders` and `GET /api/export/builders` already read (see `readStringArray` in
`src/routes/api/me/builders/index.ts` and `privateTopics` in `src/routes/api/export/builders.ts`).
Enrichment evidence adds headline/organization/role/location, still no email. So email cannot be the
primary match key.

**Match ladder, first hit wins:**

1. `provider_profile_url` — the ATS candidate has a website/social link whose normalized form
   (lowercase host, drop `www.`, strip trailing slash and query) equals
   `builder_identities.profile_url`. This is the strongest key BuilderHunt actually has: a GitHub/
   GitLab profile URL is a unique identity anchor. Confidence `exact`.
2. `operator_email` — only an email the exporting operator typed into the export dialog for that
   specific row. **A claimant's account email is never used**, even for a `verified`
   `builder_claims` row: proving you own a public profile inside BuilderHunt is not consent to have
   your account email sent to a third party's hiring system. Confidence `exact`.
3. `name_and_source_url` — normalized display-name equality **and** at least one shared normalized
   host+path across the candidate's links. Confidence `probable`.
4. No hit → `created_new`.

**Conflict policy:** `exact` → link the existing candidate and **write nothing to the ATS**
(`action: 'linked_existing'`). `probable` → never auto-link; the export dialog shows
"possible duplicate: <name>" with Link / Create new / Skip, and the operator's choice is recorded as
`matchMethod: 'manual'`. Reverse direction — a polled candidate with no link row is ignored (import
is a non-goal).

**Concurrency:** two operators exporting the same builder race on
`ats_candidate_links_org_connection_identity_unique`; the loser's `ON CONFLICT DO NOTHING RETURNING`
comes back empty, it re-reads the winner's row and reports `skipped_duplicate`. The DB constraint is
the real guard — Greenhouse Harvest has no general idempotency-key header we can rely on, so
`idempotencyKey = sha256(orgId:connectionId:builderIdentityId)` is passed where a provider supports
it and is otherwise only used for our own logging.

### 5. Status write-back: polling, and the conflict rule

**Polling, not webhooks.** The repo does now have a Stripe webhook receiver
(`src/routes/api/webhooks/stripe.ts`, `src/shared/lib/billing/webhook-inbox.ts`), but it is a single
platform-owned endpoint with one signing secret verified against one account. ATS webhooks are
*per-tenant*: N tenant-scoped signing secrets, per-tenant endpoint registration/deregistration
lifecycle, replay windows, and a public unauthenticated route that mutates tenant data — a second
security program, not a sync mechanism. Coverage also varies by provider and customer plan. Polling
has zero inbound attack surface and needs no configuration inside the customer's ATS.

`POST /api/admin/ats-sync/run-worker` clones `src/routes/api/admin/alerts/run-worker.ts`
(`tryCronPrincipal(request) ?? await requirePlatformAdminPrincipal(request)` +
`auditPlatformAdminAction`). `runAtsSyncWorker()` in `src/lib/ats/worker.ts`:

1. `ATS_INTEGRATIONS_ENABLED !== 'true'` → `{ disabled: true, … }` (enrichment-worker precedent).
2. Reclaim expired leases, then claim due connections with a lease
   (`UPDATE … SET lease_token, lease_expires_at WHERE (lease_expires_at IS NULL OR lease_expires_at
   < now()) AND backoff_until <= now() … RETURNING`) — two overlapping runs cannot process the same
   connection. Cross-org discovery via the `listWorkerOrganizationIds` / `withWorkerOrganization`
   pair in `src/shared/lib/repositories/billing-worker.ts`.
3. **One transaction per connection, in that connection's own org context.** A tenant's failure
   increments `consecutiveFailureCount`, sets `backoffUntil = now() + min(2^n × 5 min, 6 h)`, and
   never aborts the run or touches another tenant's rows.
4. Page through `listUpdatedCandidates` up to `ATS_SYNC_MAX_PAGES_PER_RUN`; the cursor advances only
   after a page is persisted → resumable and idempotent (re-running the same page is a no-op because
   every write is keyed on `(organizationId, provider, externalCandidateId)`).
5. `rate_limited` → stop this connection cleanly, keep the cursor, `backoffUntil = now() +
   retryAfterMs` (honouring the provider's reset header where it sends one). Never retry in-loop.
6. `invalid_credentials` / `permission_denied` → set `ats_connections.status =
   'invalid_credentials'`, `lastErrorCode`, `lastErrorAt`; notify once (§7).

**The conflict rule — ATS-authoritative for mapped stages, non-destructive otherwise.** When
Greenhouse says `hired` and the BuilderHunt stage says `contacted`, the ATS wins. Alternatives
considered: *last-write-wins by timestamp* is wrong because the two timestamps measure different
things — a drag-and-drop at 14:05 is not more authoritative than a recruiter's hire decision
recorded at 13:50 — and it makes the row flap between two writers; *always surface a conflict*
buries the single most valuable datum (the real outcome) behind a click nobody makes. So: the ATS is
the system of record for hiring decisions, which is the entire premise of the feature. The bound on
that authority is what makes it safe:

- the worker moves the card **only** when the external stage resolves to a known local stage key and
  differs from the current value;
- when it does not resolve, the worker writes **nothing** to the pipeline, stores the raw label in
  `ats_candidate_links.externalStatus`, and sets `conflictState = 'unmapped_external_stage'` for the
  UI to surface (story 4). Never guess;
- every worker-written stage carries provenance (`mappedStage`, `lastSyncedAt` on the link, plus
  `source = 'ats'` on the stage event) so the pipeline UI renders `Offer · from Greenhouse · 6 min
  ago` rather than an unexplained jump;
- `pipeline_owner_user_id`, `status`, `visibility`, `private_metadata` and stage notes are **never**
  touched by the worker;
- a link whose tracking row has been untracked writes no stage at all (§2).

**Write path — `moveBuilderStage`, never a direct column write.**
[`hiring-pipeline-kanban`](../hiring-pipeline-kanban/spec.md) models stage history as an append-only
`organization_builder_stage_events` table whose `source` check constraint already enumerates
`'ats'`, with `organization_builders.pipeline_stage_changed_at` as a *denormalized cache* of the
latest event. That plan states the contract it owes this one explicitly: ATS write-back goes through
`moveBuilderStage(tx, organizationId, organizationBuilderId, { toStage, actorUserId, expectedStage, source: 'ats' })`
(`src/shared/lib/repositories/pipeline.ts`), which updates the row, the cache, and inserts exactly
one event in one transaction. A direct `UPDATE organization_builders SET pipeline_stage = …` would
leave the history table silently missing every ATS-driven transition — the exact transitions this
feature exists to capture. Two consequences for this plan:

- **`expectedStage` is free concurrency safety.** The worker passes the stage it read at the top of
  the transaction; a recruiter who dragged the card in the meantime causes `{ ok: false,
  currentStage }`, and the worker records `conflictState` and retries on the next run instead of
  clobbering the human.
- **`actorUserId` is `NOT NULL` and FK-restricted.** A cron worker has no session. Use
  `ats_connections.created_by_user_id` — the real operator who configured that connection, already
  stored, already in the organization, and already reassigned to `system-deleted-user` by §2's
  account-deletion fix if that person is later hard-deleted. Do **not** invent a second sentinel.
- `moveBuilderStage` is typed against `TenantTransaction`; the ATS worker runs on the worker
  connection inside `withWorkerOrganization`. Widen that parameter to the shared transaction type
  rather than duplicating the write — a second implementation is how the event table drifts.

**The worker is not currently permitted to make either write, and this plan must fix both.**
`builderhunt_worker` holds only `GRANT SELECT ON TABLE organization_builders` with a single
`organization_builders_worker_select` policy (`drizzle/0018_enrichment_worker_target_access.sql`),
and no later migration widens it — verified at HEAD: `grep builderhunt_worker drizzle/*.sql | grep
organization_builders` returns that one `GRANT SELECT` line and nothing else. The sibling plan's own
RLS migration grants the worker `SELECT` only on `organization_pipeline_stages` and
`organization_builder_stage_events` — not `INSERT`. Without both changes, write-back cannot execute
at all. This is exactly the failure class [`app-reality`](../../_meta/app-reality.md) constraint 7
exists for, so it is proven against the real non-owner role, not the DB owner.

Resolution — **two column/verb-scoped grants plus their policies**, shipped as this plan's own
hand-written migration in Phase 4 (it must run after the sibling plan's column and table migrations,
since neither exists before then):

```sql
-- 1. The card move itself: exactly three columns, org-scoped.
CREATE POLICY organization_builders_worker_update ON organization_builders
  FOR UPDATE TO builderhunt_worker
  USING      (organization_id = nullif(current_setting('app.organization_id', true), ''))
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));

GRANT UPDATE (pipeline_stage, pipeline_stage_changed_at, updated_at)
  ON organization_builders TO builderhunt_worker;

-- 2. The history row moveBuilderStage writes alongside it. INSERT only — the table is
--    append-only, so no UPDATE or DELETE for any role, worker included.
CREATE POLICY organization_builder_stage_events_worker_insert ON organization_builder_stage_events
  FOR INSERT TO builderhunt_worker
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));

GRANT INSERT ON TABLE organization_builder_stage_events TO builderhunt_worker;
```

No grant is needed on `organization_pipeline_stages` — the sibling plan already gives the worker
org-scoped `SELECT` there, which is all `listLocalStageKeys` needs. And because
`organization_builders.pipeline_stage` carries a composite FK to
`organization_pipeline_stages(organization_id, key)` with `ON DELETE RESTRICT`, an unmapped or stale
stage key cannot be written even if the resolver were wrong: the database is the third layer under
the resolver and the FK.

Alternatives rejected: a **table-wide** `GRANT UPDATE` would let a buggy worker rewrite `status`,
`visibility`, `private_metadata` or `pipeline_owner_user_id`; a **SECURITY DEFINER function** (the
`setPlatformUserPlan` pattern) bypasses RLS entirely and is the far heavier hammer for a three-column
write; running write-back **under the app role** is impossible — a cron-triggered worker has no user
session to resolve a `TenantPrincipal` from. Column-level `UPDATE` is the least privilege Postgres
can express here, and it mirrors the same column-level worker grant this plan already uses on
`ats_connections`.

### 6. Stage mapping — tolerant of stages we cannot know

`src/lib/ats/stage-mapping.ts`, pure and tested:

```ts
export interface AtsStageMappingRule { externalStage: string; localStageKey: string }
export type ResolveStageResult =
  | { kind: 'mapped'; localStageKey: string; via: 'rule' | 'provider_default' | 'normalized_name' }
  | { kind: 'unmapped'; reason: 'no_rule' | 'stale_local_stage' }

export function resolveExternalStage(input: {
  externalStage: string
  rules: readonly AtsStageMappingRule[]        // operator-configured, per connection
  knownLocalStageKeys: readonly string[]       // from hiring-pipeline-kanban's per-org stage config
  providerDefaults: readonly AtsStageMappingRule[]
}): ResolveStageResult
```

Order: operator rule → provider default table (`Offer→offer`, `Hired→hired`,
`Rejected|Declined→rejected`, …) → punctuation/case-normalized name equality against
`knownLocalStageKeys` → `unmapped`. A rule pointing at a local stage the organization has since
deleted resolves to `unmapped { reason: 'stale_local_stage' }` — not an error, not a write. That is
the tolerance requirement in both directions.

`resolveExternalStage` is deliberately pure and takes `knownLocalStageKeys` as plain input, so
Phases 1–3 (export only) carry **no dependency on the sibling plan at all** and ship independently.

`src/lib/ats/stage-source.ts` is the **single** coupling point to
[`hiring-pipeline-kanban`](../hiring-pipeline-kanban/spec.md): one function
`listLocalStageKeys(tx, organizationId): Promise<string[]>` selecting `key` from
`organization_pipeline_stages` ordered by `position` (composite PK `(organization_id, key)`,
tenant-private, worker-readable). It ships in **Phase 4**, not earlier — before the sibling plan
lands, the table is not in `schema.ts` and the function cannot type-check. An earlier draft hedged
with a "frozen default ladder" fallback (`new, reviewed, contacted, in_conversation, hired`); that
is now dead weight and a source of drift, because the sibling plan seeds its own
`DEFAULT_PIPELINE_STAGES` via `ensureDefaultPipelineStages` and enforces the key set with an FK. An
organization with zero stage rows yields `[]`, every external stage resolves to `unmapped`, and
nothing is written — which is the correct behaviour, not a fallback. This plan does **not** create,
migrate, or re-specify `pipeline_stage` / `pipeline_stage_changed_at` / `pipeline_owner_user_id`,
`organization_pipeline_stages`, or `organization_builder_stage_events`.

### 7. Processing disclosure, exclusions, audit

**Transmitted by default (minimum necessary):** `fullName` (`builder_identities.display_name` ??
`username`), `sourceProfileUrl` (`profile_url`), `primaryLanguage` (`builder_identities.language`).
That is all.
**Opt-in per connection:** `bio`, `location`, and — new in this revision — `topics`.
`bio` is the field most likely to contain something the subject would not want in a permanent hiring
file; `location` is inferred and often wrong, and a wrong location in a hiring record is a real harm.
`topics` moved out of the default set because
[`app-reality`](../../_meta/app-reality.md) constraint 8 documents that it is **synthesized, not
measured**, on several sources: `hn.ts` sets `topics` to the operator's own query keywords, which
would arrive in a customer's ATS looking like an assessment of the candidate. Sending a fabricated
skill list to a third-party hiring system is a worse failure than sending a stale bio, and the field
is not worth a default. It is also not on `builder_identities` at all — the payload builder reads
`organization_builders.private_metadata.topics`, the same key `GET /api/export/builders` already
emits.
**Per-row, operator-typed only:** `email`.
**Never transmitted:** notes, any `private_metadata` key other than `topics`, AI enrichment output,
scores, enrichment evidence, `builder_source_snapshots` payloads, alert history, claimant account
emails, anything belonging to another organization.

**Suppression gate — the same one every other export honours.** `src/shared/lib/profile-suppression.ts`
names exports as a mandatory enforcement surface, and `GET /api/export/builders` already calls
`filterSuppressed` before writing a row of CSV. Pushing a candidate into a third party's permanent
hiring record is strictly worse than putting them in a CSV, so the ATS export path runs
`filterSuppressed` (preview and export) and the sync worker checks `isSuppressed` before refreshing a
link. A suppressed identity is reported to the operator exactly like a restricted one and audited as
`skipped_restricted`. This is separate from, and additional to, the restriction gate below:
suppression is a global `(source, sourceId)` removal request, restriction is a per-identity
processing objection.

**Restriction gate.** Before any `findCandidates`/`createCandidate` call and before any link write,
an `active` row in `builder_processing_restrictions` for that `builderIdentityId` excludes the
subject: `ats_export_events.action = 'skipped_restricted'`, UI shows "excluded — processing
restricted". If a restriction is filed *after* export, the worker stops updating and stops
transmitting for that link and sets `conflictState = 'restricted'`; it does **not** attempt deletion
inside the customer's ATS, because BuilderHunt is not the controller of that copy. The integrations
page says so explicitly, and the subject-facing restriction response is extended to disclose that an
exported copy may exist in a customer's ATS. Honest beats magical.

**Disclosure surface.** Before the first export on a connection, the operator must affirmatively
acknowledge a versioned disclosure listing the exact field allowlist and stating that their ATS
vendor becomes an independent controller under the customer's own agreement with that vendor.
Recorded as `disclosureVersion` + `disclosureAcknowledgedAt` on `ats_connections` (per organization
per provider — not `user_consents`, which is account-subject scoped).
[`legal-and-compliance`](../../implemented/04-legal-and-compliance/spec.md)'s privacy-policy processor list gains
"customer-configured ATS (Greenhouse / Lever / Ashby) — recipient of candidate data you choose to
export".

## UX integration

- **`/settings/integrations`** (new route `src/routes/_dashboard/settings/integrations.tsx` +
  `src/modules/dashboard/components/AtsIntegrationsPage.tsx`, modelled on
  `settings/team.tsx` → `TeamSettingsPage`). Per connection: provider, label, `••••last4` +
  fingerprint, status badge, `lastVerifiedAt`, `lastSyncedAt`, link count, unmapped-stage count with
  an inline mapping editor, transmit-field toggles, "Test connection", "Disconnect".
  **Navigation lives in `src/modules/dashboard/ui/shell/nav-config.ts`, not `UserMenu.tsx`.** The
  dashboard shell owns navigation now; `UserMenu.tsx` renders exactly two entries (Account, Sign out)
  and has no settings list to add to. The new item goes in the `workspace` area's `items`, whose
  `routes` array already claims the `/settings` prefix — `tests/unit/modules/dashboard/ui/shell/nav-config.test.ts`
  fails any destination placed under an area that does not own its prefix.
- **Export dialog** — one shared component (`AtsExportDialog`) fed a list of `builderIdentityId`s, so
  every surface uses identical logic. The surfaces are `/exports`
  (`src/modules/dashboard/components/ExportsPage.tsx` — the tracked-builder list that already offers
  "Download CSV"; there is no `/me/builders` route, an earlier draft's error), the pipeline board,
  and a sprint's results. Shows the field allowlist, restriction and suppression exclusions, and
  duplicate candidates with per-row Link / Create / Skip.
- **Pipeline row** — external stage chip with provenance, or an "unmapped stage" affordance, or
  "no longer in Greenhouse" for `conflictState = 'external_missing'`.
- **Failure notification** — one email per failure instance via a new
  `sendAtsConnectionFailureEmail` in `src/shared/lib/email.ts`, deduped by comparing
  `failureNotifiedAt` against `lastErrorAt` on the single connection row. This deliberately does
  **not** reuse `billing_notification_log` (a billing-named table with billing grants) — it reuses
  the *idea* from `src/shared/lib/billing/notifications.ts` without a fifth table, which is exact
  because there is exactly one row per `(organization, provider)`.

## Tier/billing gating

Team tier. Concrete gate, cloning the `SOURCING_SPRINT_LIMITS` precedent in
`src/shared/lib/billing-shared.ts`:

```ts
export const ATS_CONNECTION_LIMITS: Record<PlanTier, number> = { free: 0, pro: 0, team: 3 }
```

Read via `getOrganizationEntitlement(tx, organizationId)`
(`src/shared/lib/repositories/entitlements.ts`) and `resolveLegacyPlanTier`, which maps `pro_max` →
`team` per that module's documented convention — so Pro Max inherits the allowance. Flagged as a
product decision to revisit if Pro Max should *not* include ATS. Gate requires
`policy.active && !policy.paymentBlocked && ATS_CONNECTION_LIMITS[tier] > 0`.

**While `STRIPE_BILLING_ENABLED=false`** (today, everywhere): nothing changes structurally. Team
entitlements are provisioned manually by a platform admin, the feature works for those
organizations, nobody is billed for it, and a Pro user's upgrade CTA routes to the existing
`plan_requests` flow rather than Stripe Checkout. When Stripe goes live the gate needs no edit,
because `organization_entitlements.tier` is exactly what Stripe's subscription projection already
writes. `PLAN_PRICING.team.features` gains "ATS integrations", naming only the providers actually
shipped at that point (Greenhouse, then Ashby).

Independent kill switch: `ATS_INTEGRATIONS_ENABLED` (default `false`, enrichment precedent). Off ⇒
routes `503 { error: 'ats_disabled' }`, worker returns `{ disabled: true }`, settings tab hidden.

**Authorization**: no new export permission. Pushing candidates *is* an export, so it reuses the
existing `'resource:export'` action in `src/shared/lib/authorization/permissions.ts` (already
owner/admin, consistent with the CSV export). Two new actions only: `'integration:read'` (elevated)
and `'integration:manage'` (elevated) for credentials and stage mappings.

## Success metrics

- ≥ 60% of connected organizations complete ≥ 1 export within 14 days of connecting.
- **Closed loop**: ≥ 1 candidate per connected organization per 60 days reaches a terminal external
  stage (`hired` / `rejected`) via sync — the product's first real outcome labels for evaluating
  `src/lib/score.ts`.
- Duplicate creations < 1% of exports (`matchMethod = 'created_new'` rows later found to have an
  exact-URL twin).
- Zero credentials in any response body, log line, or error — asserted by test, not measured.
- Worker: p95 < 60 s per connection; one failing tenant provably never blocks another.

## Cost model

Not an AI feature: no AI task, no embeddings, no credit reservation, no `rate-cards.ts` entry. The
only marginal cost is outbound HTTP to a customer-owned API, bounded by
`ATS_SYNC_MAX_PAGES_PER_RUN` and `ATS_EXPORT_MAX_CANDIDATES_PER_REQUEST` (25 — keeps an export
inside one request, no queue needed; larger selections are batched client-side).

## Resolved edge cases

- **BuilderHunt has no email for almost anyone** — resolved in §4: the profile URL is the primary
  match key, operator-typed email is secondary, claimant emails are never used.
- **Custom stage nobody mapped** — `unmapped_external_stage`, no local write, surfaced with a
  one-click mapping action (§6).
- **Local stage deleted after a rule referenced it** — `unmapped { stale_local_stage }`, no write,
  no error.
- **ATS candidate deleted or its job deleted** — `not_found` on that link only →
  `conflictState = 'external_missing'`; the local builder is never deleted, `pipeline_stage`
  untouched.
- **Credential revoked mid-run** — connection `invalid_credentials`, sync paused, export blocked,
  exactly one email, Reconnect CTA.
- **Rate limited** — cursor kept, exponential backoff, "syncing slowly (provider rate limit)" in the
  UI, no email.
- **Two operators export the same builder simultaneously** — unique constraint decides; the loser
  reports `skipped_duplicate` (§4).
- **A previously-exported builder is untracked** (`DELETE /api/builders/$builderId` →
  `deleteOrganizationBuilder`, which hard-deletes the `organization_builders` row) — untrack
  succeeds exactly as it does today. There is no FK from `ats_candidate_links` to
  `organization_builders` (§2), so no violation is possible; the link row survives as history with
  `conflictState = 'untracked'`, the worker refreshes `externalStatus` but writes no stage, and
  re-tracking later reuses the same link row instead of creating a second ATS candidate.
- **The worker lacks permission to write the pipeline stage** — resolved in §5 by a column-scoped
  `GRANT UPDATE (pipeline_stage, pipeline_stage_changed_at, updated_at)` plus an org-scoped
  `FOR UPDATE` policy, **and** an `INSERT`-only grant + policy on
  `organization_builder_stage_events` (the sibling plan grants the worker `SELECT` there, not
  `INSERT`), proven by `pnpm test:api-isolation:local` against `builderhunt_worker` itself.
- **A recruiter drags the card while the worker is mid-run** — the worker passes the stage it read
  as `expectedStage` to `moveBuilderStage`, gets `{ ok: false, currentStage }`, writes no stage,
  records the divergence on the link, and reconciles on the next run. The human is never clobbered
  silently (§5).
- **The operator who configured the connection deletes their account** — every `auth_users`
  reference this plan adds is `onDelete: 'restrict'`, so `hardDeleteAccountSubject` must reassign
  it to `system-deleted-user` alongside `organization_builders.creator_user_id` (§2). Without that,
  the account becomes permanently undeletable and the failure is swallowed by a worker log — the
  exact bug `drizzle/0026_deleted_user_sentinel.sql` exists to fix.
- **A builder files a global profile-removal request after being exported** — `filterSuppressed`
  blocks any further export and `isSuppressed` stops the worker refreshing that link (§7). As with a
  restriction, no deletion is attempted inside the customer's ATS.
- **`topics` on a Hacker News-sourced builder is just the operator's search keywords** —
  `app-reality.md` constraint 8. `topics` is opt-in per connection rather than default, and the
  disclosure names its provenance (§7).
- **Restriction filed after export** — sync stops for that link, no deletion attempted in the
  customer's ATS, disclosed to the subject (§7).
- **Organization deleted** — `organization_id` cascades all four tables; no ATS-side action (we
  cannot and must not delete a customer's own records).
- **Connection disconnected** — connection + `ats_sync_state` deleted; `ats_candidate_links` and
  `ats_export_events` are **kept** as read-only history, because the audit trail of what was
  transmitted must outlive the credential that transmitted it.
- **`ATS_CREDENTIAL_ENCRYPTION_KEY` rotated** — `v1:` envelope + `…_KEY_PREVIOUS` decrypts old rows
  during the overlap; a re-encrypt pass is an explicit operator task, not an implicit migration.
- **Encryption key lost** — every ciphertext is unrecoverable by design. Connections surface
  `invalid_credentials` on first use and the operator re-enters the key. No backdoor, no escrow.
