# Public Profile Enrichment — Implementation Plan

> **Status:** `code-complete-dark` — Phases 0-6 implemented and verified locally (real
> migrations against Postgres, 508/508 project tests, type-check/lint/build all green).
> Phase 7 is partial: static/local gates ran clean; the runtime adversarial matrix, RLS
> fixture tests, dark-deploy smoke, 7-day canary, and legal/source-register sign-off have
> NOT happened — none of that can be faked or compressed into one sitting.
> **Canonical requirements:** [`spec.md`](./spec.md)
> **Execution rule:** complete phases in order. Do not enable production traffic until
> Phase 7. Every checkpoint must remain deployable with `ENRICHMENT_ENABLED=false`.

## Reality check and optimization decisions

The repository already has PostgreSQL, optional Redis, normalized global identities,
organization-scoped tracked builders, a dedicated worker DB role, RLS, structured logs,
rate limiting, HTTP-cron workers, and twelve source connectors. The plan therefore adds no
new service and no browser runtime.

Removed from the old proposal:

- duplicate PostgreSQL/Redis setup;
- BullMQ and a permanently running queue consumer;
- Patchright/noDriver and browser image maintenance;
- WARP/Tor routing and proxy health management;
- CAPTCHA solver deployment and session handoff;
- LinkedIn/X/Facebook scrapers and Google dorks.

The optimized topology remains `app + PostgreSQL + optional Redis`. Postgres is the
durable queue; the existing authenticated HTTP-cron pattern starts bounded worker runs.

## Phase 0 — Policy freeze and fixtures

Create the policy layer before any network-capable worker code.

Files:

- `src/lib/enrichment/types.ts`
- `src/lib/enrichment/policies.ts`
- `src/lib/enrichment/policies.test.ts`
- `docs/operations/public-enrichment-source-register.md`

Deliverables:

1. Types from spec §§4 and 8.
2. Compile-time policy entries for every connector name.
3. LinkedIn, X, Facebook, and Instagram explicitly `blocked`.
4. Runtime allowlist parser that can only narrow compile-time policies.
5. Source register template: owner, permission reference, lawful-basis/LIA reference,
   approved fields/hosts, review date, expiry, robots requirement, and rollback owner.

Checkpoint: a unit test proves an env string containing `linkedin` cannot make it
executable. No network code exists yet.

## Phase 1 — Schema, migration, RLS, and repositories

Files:

- `src/shared/lib/db/schema.ts`
- next generated `drizzle/00XX_*.sql` and metadata/hash updates
- `src/shared/lib/repositories/enrichment.ts`
- `src/shared/lib/repositories/enrichment-worker.ts`
- repository and exact-role RLS tests under `src/shared/lib/**.test.ts` / `test/security/`

Deliverables:

1. Add `enrichment_jobs`, `enrichment_evidence`, and
   `builder_processing_restrictions` exactly as specified.
2. Add composite tenant integrity and partial indexes using hand-reviewed SQL where
   Drizzle cannot express them.
3. Enable and force RLS for organization tables.
4. App policies: member read/enqueue; admin/owner review; no cross-tenant access.
5. Worker policies: organization discovery only as already permitted, scoped job/evidence
   operations only after transaction-local `app.organization_id` is set.
6. Platform policy for subject restrictions; no direct app-table mutation.
7. Repositories own all queries. Route/worker modules never import `publicDb` for tenant
   records.
8. Lease methods: claim due jobs, renew/reclaim lease, persist evidence, terminal update,
   cancel active jobs, and bounded retention deletion.

Checkpoint: fresh migration, upgrade migration, migration-integrity checks, exact-role
RLS A/B/missing-context suite, and lease concurrency integration tests pass.

## Phase 2 — Pure validation and entity resolution

Files:

- `src/lib/enrichment/schemas.ts`
- `src/lib/enrichment/normalize.ts`
- `src/lib/enrichment/resolver.ts`
- matching unit/golden tests

Deliverables:

1. Zod schemas for API body, connector candidate, minimized payload, and stored evidence.
2. URL normalization and host validation as pure functions.
3. Deterministic resolver v1 with score components and contradictions.
4. Content hash over canonical JSON of connector ID, source record ID, and minimized
   payload; never hash raw response material.
5. Property tests: score range, deterministic output, normalization idempotence, and
   contradiction caps.

Checkpoint: golden fixtures make every threshold decision explicit. No I/O in this phase.

## Phase 3 — Safe connector runtime

Files:

- `src/lib/enrichment/network.ts`
- `src/lib/enrichment/robots.ts`
- `src/lib/enrichment/registry.ts`
- `src/lib/enrichment/connectors/github.ts` (first canary adapter)
- connector/network tests with a local fake HTTP server

Deliverables:

1. Central network client enforces HTTPS, allowed host, public resolved IP, redirect
   revalidation, timeout, byte limit, content type, honest user agent, and abort signal.
2. Robots cache keyed by scheme/host with bounded TTL; deny on parse/fetch failure for
   `authorized_crawl`.
3. Shared per-host limiter. No adapter calls `fetch` directly.
4. Registry returns only policy-enabled and runtime-allowed adapters.
5. Implement one exact-profile official API adapter for a source already tied to the
   tracked identity (GitHub first). Reuse source DTO conventions but do not call broad
   federated search.
6. Normalize upstream failures into `ConnectorResult`; challenge/auth/policy outcomes are
   permanent stops.

Checkpoint: fake-server tests prove SSRF/redirect/size/timeout/rate/challenge behavior and
assert no request reaches a disallowed server.

## Phase 4 — Worker and retention

Files:

- `src/lib/enrichment/worker.ts`
- `src/lib/enrichment/worker.test.ts`
- `src/routes/api/admin/enrichment/run-worker.ts`
- `src/shared/lib/env.ts`
- `.env.example`
- `.env.production.example`

Deliverables:

1. Add and validate spec §12 env keys.
2. Implement bounded lease worker per spec §11.
3. Execute connectors sequentially per job with at most two concurrent jobs.
4. Recheck restriction and policy after leasing and before each connector.
5. Persist only validated minimized evidence.
6. Run bounded retention at the end of each worker pass: maximum 500 rows, oldest first.
7. Add structured events/counts and extend log redaction.
8. Add admin-only POST endpoint with no caller-controlled target.
9. Disabled mode returns `{ disabled: true, claimed: 0, processed: 0 }` without DB/network
   mutation.

Checkpoint: two overlapping real Postgres runs create no duplicate jobs/evidence; a killed
worker lease is reclaimed after expiry; kill switch and retention are runtime-tested.

## Phase 5 — Tenant APIs and subject rights

Files:

- `src/routes/api/builders/$builderId/evidence-refresh.ts`
- `src/routes/api/builders/$builderId/evidence/index.ts`
- `src/routes/api/builders/$builderId/evidence/$evidenceId.ts`
- `src/routes/api/me/builder/$builderId/restrict-processing.ts`
- `src/routes/api/me/builder/$builderId/evidence-provenance.ts`
- repositories from Phase 1
- route tests

Deliverables:

1. Enqueue/idempotency/rate-limit behavior from spec §10.
2. Read latest job and non-expired evidence in tenant context.
3. Admin/owner review with immutable reviewer/timestamp audit fields.
4. Verified-claim restriction flow cancels work and invokes bounded evidence purge.
5. Verified-claim provenance read aggregates source/field/date/retention only and reveals
   no tenant, recruiter, job, reviewer, note, or score metadata.
6. Extend organization/account export and deletion repositories to include/remove
   enrichment records.
7. Return stable machine error codes; do not leak source response errors.

Checkpoint: own/other/random-ID matrix for member/admin/owner, two organizations, claimed
subject, restricted subject, and unauthenticated caller passes against exact DB roles.

## Phase 6 — UI and product language

Files:

- `src/modules/builder-profile/components/PublicEvidenceCard.tsx`
- `src/modules/builder-profile/components/PublicEvidenceCard.test.tsx`
- `src/modules/builder-profile/components/BuilderProfilePage.tsx`
- relevant legal/product pages and README claims

Deliverables:

1. Implement every UI state in spec §13.
2. Poll active jobs with capped backoff; stop on terminal/unmount/offline.
3. Display source attribution, observation/expiry, confidence explanation, and review
   controls.
4. Keep evidence tenant-private; anonymous/public builder DTOs remain unchanged.
5. Replace contradictory “no scraping”/source wording with precise public-data language.
6. Update privacy/terms/crawler page before production activation; bump consent version if
   counsel/product determines the purpose change is material.

Checkpoint: component tests plus authenticated browser smoke for member/admin/restricted
states; public/anonymous endpoints contain no enrichment fields.

## Phase 7 — Verification, canary, and activation

### Static and automated gates

Run:

```bash
pnpm type-check
pnpm lint
pnpm test
pnpm security:boundaries
pnpm test:migration-integrity
pnpm test:rls:local
pnpm build
```

Run the migration/restore commands required by `security-and-multitenancy` against a
disposable database. Do not use production as a verifier.

### Runtime gates

1. Start the local app, Postgres, and Redis; run one GitHub fixture job from the UI.
2. Capture job transitions, accepted evidence, and structured redacted logs.
3. Prove host allowlisting with the fake server plus network/DNS observation.
4. Run two workers concurrently and crash one after lease acquisition.
5. Activate restriction during a running job and prove no evidence survives.
6. Advance fixture timestamps and prove raw/accepted/rejected retention.
7. Set `ENRICHMENT_ENABLED=false`, restart, and prove enqueue/worker network calls stop.

### Production rollout

1. Deploy schema/code with the feature disabled.
2. Apply migration and validate table/index/RLS state with production runtime identities.
3. Publish approved legal/crawler copy and source register.
4. Enable only `github` for platform admins, manual requests only, batch size 2.
5. Observe 24 hours; require zero policy/auth/challenge retries, zero cross-tenant errors,
   and zero retention backlog.
6. Expand to internal organization members for six more days.
7. After seven clean days, enable eligible customer manual refresh. Scheduled refresh
   remains disabled until separately approved.

## Rollback

1. Set `ENRICHMENT_ENABLED=false` and redeploy; reads/rights remain operational.
2. Remove the enrichment cron entry.
3. If one adapter is faulty, remove it from `ENRICHMENT_ALLOWED_CONNECTORS`; do not disable
   unrelated adapters.
4. Leave additive tables in place during rollback so exports, subject requests, and audit
   obligations continue to work.
5. Purge payloads only through the retention/privacy workflow. Do not drop tables or erase
   evidence ad hoc.
6. A later forward migration may remove dormant schema after the retention window.

## Definition of done

All spec acceptance criteria pass with recorded command/runtime evidence; production is
disabled-by-default; source and legal approvals are documented; and the canary completes
without a critical privacy, isolation, or policy event.
