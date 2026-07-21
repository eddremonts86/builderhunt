# Policy-Compliant Public Profile Enrichment — Product and Technical Specification

> **Status:** `code-complete-dark` (Phases 0-6 implemented 2026-07-20; production activation,
> the 7-day canary, RLS fixture tests, and legal-copy sign-off are explicitly NOT done —
> `ENRICHMENT_ENABLED=false` everywhere. See plans/stealth-scraping/task.md for exact gaps.)
> **Legacy directory name:** `stealth-scraping` is retained only to preserve existing links.
> The implementation and product copy must use **Public Profile Enrichment**. It must not
> claim stealth, anti-bot evasion, CAPTCHA solving, identity masking, or guaranteed access.
> **Depends on:** `security-and-multitenancy` (tenant context, worker role, RLS),
> `legal-and-compliance` (access/export/deletion), and the normalized
> `builder_identities` + `organization_builders` model.
> **Reuses:** existing source connectors, `DATABASE_WORKER_URL`, structured logging,
> rate limiting, the admin HTTP-cron pattern, and the builder profile surface.

## 1. Decision summary

The previous design is rejected. It proposed browser fingerprint evasion, WARP/Tor,
automatic CAPTCHA solving, Google dorks, and unauthorized extraction from LinkedIn, X,
and Facebook. That architecture is brittle, contradicts BuilderHunt's public product
positioning, adds four unnecessary services, and conflicts with current provider terms.

The replacement is a self-hosted, deterministic enrichment pipeline that:

1. refreshes public professional evidence only through an official API, a source-specific
   authorized crawler, or a URL submitted by the profile owner/operator;
2. identifies BuilderHunt honestly and respects source policy, robots directives, rate
   limits, retry hints, and access challenges;
3. never bypasses authentication, paywalls, CAPTCHAs, rate limits, or technical controls;
4. stores minimal, source-attributed evidence in the requesting organization only;
5. links identities only when explainable confidence rules pass;
6. supports review, correction, restriction, export, expiry, and erasure.

This preserves the business outcome—better public context around tracked builders—without
making the product depend on circumvention.

## 2. Product goal

Allow an authenticated organization member to refresh a tracked builder and obtain a
small, explainable set of current public facts:

- canonical public profile URL;
- display name and public username;
- public headline or bio;
- public organization/role when explicitly exposed by an allowed source;
- coarse public location;
- public topics and recent activity summary;
- source, observation time, expiry time, and match explanation.

The feature must improve recruiter confidence without presenting inferred facts as
verified truth or exposing contact details.

## 3. Non-goals and hard prohibitions

- No collection of email addresses, phone numbers, direct messages, private profiles,
  authentication-gated pages, relationship graphs, or sensitive-category data.
- No search by email, credential reuse, account automation, session-cookie import,
  CAPTCHA solving, browser fingerprint spoofing, IP rotation, WARP/Tor, residential
  proxying, or response replay.
- No Google/Bing dorking and no scraping search result pages.
- No Patchright, Playwright, Selenium, noDriver, TRAWL, ByParr, FlareSolverr, or equivalent.
- No LinkedIn, X, Facebook, or Instagram automated retrieval without documented written
  permission or an official API contract that permits the exact use.
- No automatic outreach, automated employment decisions, protected-attribute inference,
  or ranking based on enriched fields.
- No global sharing of organization-reviewed links or match decisions.
- No promise that every requested profile can be enriched.

## 4. Source policy gate

Every connector must have a compile-time `SourcePolicy`. Missing policy means disabled.
Runtime allowlisting can further restrict a connector but can never override a blocked
compile-time policy.

```ts
export type AcquisitionMode =
  | "official_api"
  | "authorized_crawl"
  | "user_submitted";

export interface SourcePolicy {
  id: string;
  acquisitionMode: AcquisitionMode;
  status: "enabled" | "blocked" | "approval_required";
  permissionReference: string;
  lawfulBasisReference: string;
  reviewExpiresAt: string;
  allowedHosts: readonly string[];
  allowedFields: readonly EnrichmentField[];
  robotsRequired: boolean;
  maxRequestsPerMinute: number;
  rawRetentionDays: number;
  acceptedRetentionDays: number;
}
```

Initial matrix:

| Source                       | Automated mode                                  | Initial status                                 | Implementation rule                                                                                             |
| ---------------------------- | ----------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Existing BuilderHunt sources | Existing public/official endpoints              | Enabled one by one after policy fixture passes | Add exact-profile adapters only where the current source endpoint supports them; otherwise return `unsupported` |
| Builder/profile owner URL    | User-submitted                                  | Enabled                                        | Store and validate the URL; do not fetch a blocked host                                                         |
| Organization/project website | Authorized crawl                                | Approval required per host                     | Require allowlist, terms review record, robots allow, honest user agent, HTML size/type limits                  |
| LinkedIn                     | Official API or written crawl permission only   | Blocked                                        | URL may be stored as user-submitted evidence; no automated fetch                                                |
| X                            | Official API or written permission only         | Blocked                                        | URL may be stored as user-submitted evidence; no automated fetch                                                |
| Facebook/Instagram           | Official API or express written permission only | Blocked                                        | URL may be stored as user-submitted evidence; no automated fetch                                                |

Provider policy evidence verified on 2026-07-20:

- LinkedIn prohibits automated crawling without express permission and prohibits masking
  identity or circumventing controls: <https://www.linkedin.com/legal/crawling-terms>
- X prohibits scraping without prior written consent and working around technical limits:
  <https://x.com/en/tos>
- Meta requires express written permission for automated collection and an identifying
  user agent/IP: <https://www.facebook.com/legal/automated_data_collection_terms>
- GDPR principles require lawfulness, transparency, minimization, storage limitation,
  accuracy, and accountability:
  <https://commission.europa.eu/law/law-topic/data-protection/information-business-and-organisations/principles-gdpr_en>

These references are operational inputs, not legal advice. Product/legal approval is
required before changing a source from `blocked` or `approval_required` to `enabled`.

## 5. User stories

### 5.1 Manual refresh

An authorized organization member opens a tracked builder, chooses **Refresh public
evidence**, sees which connectors will run, submits the request, and receives a job ID.
The profile card updates asynchronously with accepted evidence or a clear partial/no-data
state.

### 5.2 Review an uncertain match

When confidence is 0.70–0.89, no fact is presented as accepted. An organization admin
sees the candidate URL, source, positive signals, contradictions, and observation time,
then accepts or rejects it. Decisions remain tenant-local and auditable.

### 5.3 Submit a known profile URL

An organization member or verified profile owner submits a public profile URL. The system
normalizes and stores it as `user_submitted` evidence. Automated retrieval occurs only if
that host has a separately enabled policy.

### 5.4 Scheduled refresh

Eligible plans may enqueue stale accepted evidence. Scheduling uses the same job table and
worker; it never broadens the connector allowlist. The first implementation ships manual
refresh. Scheduled refresh is enabled only after the 7-day canary passes.

### 5.5 Data subject control

A verified builder can view source provenance, correct/reject a linked profile, and
request restriction or deletion. A global restriction prevents future jobs for that
builder identity while preserving the minimum audit record required to honor the request.

## 6. Data classification and retention

| Data                       | Scope        | Classification         | Retention                                                                          |
| -------------------------- | ------------ | ---------------------- | ---------------------------------------------------------------------------------- |
| Job control fields         | Organization | Operational            | 90 days after terminal state                                                       |
| Candidate evidence payload | Organization | Personal/public-source | 30 days unless accepted                                                            |
| Accepted evidence          | Organization | Personal/public-source | 180 days, then stale and revalidate/delete                                         |
| Rejected evidence          | Organization | Personal/public-source | Payload deleted after 7 days; hash/reason retained 90 days                         |
| Source request metadata    | Platform     | Operational            | 30 days; never store response bodies, cookies, tokens, email, or query PII in logs |
| Subject restriction        | Platform     | Restricted             | Until withdrawn, plus minimal audit timestamp                                      |

Account and organization export/deletion flows must include these new tenant records.
Subject restriction/deletion must work even when the subject has no BuilderHunt account;
verified claims are the preferred identity proof, with privacy-support review as fallback.

## 7. Domain model

### 7.1 `enrichment_jobs` (organization-scoped)

```ts
{
  id: text primary key,
  organizationId: text not null,
  builderIdentityId: text not null,
  requestedByUserId: text,
  trigger: 'manual' | 'scheduled',
  status: 'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled',
  requestedConnectors: string[],
  submittedUrls: string[],
  attemptCount: integer default 0,
  availableAt: timestamptz,
  leaseToken: text nullable,
  leaseExpiresAt: timestamptz nullable,
  lastErrorCode: text nullable,
  startedAt: timestamptz nullable,
  finishedAt: timestamptz nullable,
  createdAt: timestamptz,
  updatedAt: timestamptz
}
```

Constraints/indexes:

- FK `(organization_id, builder_identity_id)` must resolve through the organization's
  tracked builder membership; do not allow arbitrary global identities.
- Partial unique index on `(organization_id, builder_identity_id)` for `queued|running`.
- Worker scan index on `(status, available_at, lease_expires_at)`.
- Checks for status, trigger, non-negative attempts, and terminal timestamps.
- `submitted_urls` is capped at ten normalized HTTPS URLs, is never logged, and is cleared
  as part of the terminal job update after candidates have been persisted.

### 7.2 `enrichment_evidence` (organization-scoped)

```ts
export interface EnrichmentEvidencePayload {
  profileUrl: string
  username?: string
  displayName?: string
  headline?: string
  organization?: string
  role?: string
  location?: string
  bio?: string
  topics: string[]
  recentActivitySummary?: string
}

{
  id: uuid primary key,
  organizationId: text not null,
  jobId: text not null,
  builderIdentityId: text not null,
  connector: text not null,
  acquisitionMode: text not null,
  sourceUrl: text not null,
  sourceRecordId: text nullable,
  contentHash: text not null,
  payload: jsonb<EnrichmentEvidencePayload> not null,
  confidenceBps: integer not null,
  resolverVersion: integer not null,
  scoreComponents: jsonb<Record<string, number>> not null,
  matchSignals: jsonb<string[]> not null,
  contradictions: jsonb<string[]> not null,
  resolution: 'accepted' | 'review' | 'rejected',
  observedAt: timestamptz,
  expiresAt: timestamptz,
  reviewedByUserId: text nullable,
  reviewedAt: timestamptz nullable,
  createdAt: timestamptz
}
```

Constraints/indexes:

- `confidence_bps between 0 and 10000`.
- Unique `(organization_id, builder_identity_id, connector, content_hash)`.
- Index `(organization_id, builder_identity_id, resolution, observed_at desc)`.
- Payload is validated before persistence and contains only policy-allowed fields.

### 7.3 `builder_processing_restrictions` (platform-scoped)

One row per `builderIdentityId`: reason (`subject_request|legal|safety`), status
(`active|withdrawn`), actor/reference, created/withdrawn timestamps. The app role can read
only the effective boolean through a reviewed repository function; writes require verified
subject or platform-admin workflow.

## 8. Connector contract

```ts
export interface EnrichmentTarget {
  builderIdentityId: string;
  source: string;
  sourceId: string;
  username: string;
  displayName?: string | null;
  profileUrl: string;
  knownOrganization?: string | null;
  knownLocation?: string | null;
  submittedUrls: string[];
}

export type ConnectorResult =
  | { kind: "evidence"; candidates: EnrichmentCandidate[] }
  | { kind: "no_data" | "unsupported" | "blocked" }
  | {
      kind: "retry";
      code: "rate_limited" | "upstream_unavailable";
      retryAt: Date;
    }
  | {
      kind: "stop";
      code:
        | "auth_required"
        | "robots_denied"
        | "challenge_detected"
        | "policy_denied";
    };

export interface EnrichmentConnector {
  id: string;
  policy: SourcePolicy;
  supports(target: EnrichmentTarget): boolean;
  collect(
    target: EnrichmentTarget,
    signal: AbortSignal,
  ): Promise<ConnectorResult>;
}
```

Connector invariants:

- DNS rebinding/SSRF defense: HTTPS only, exact allowed hostname, no credentials in URL,
  resolved public IP only, at most three redirects, and revalidate every redirect.
- 10-second request timeout, 2 MiB response limit, accepted content types only.
- Respect `Retry-After`; never retry `401`, `403`, `robots_denied`, or challenges.
- No automatic retries inside adapters. The worker owns retry policy.
- Per-host limiter is shared through Redis when available and fails closed for authorized
  crawl adapters if Redis is unavailable. Official API adapters may use their documented
  local limit only when a single process is guaranteed.
- Never persist cookies, authorization headers, raw HTML, or full upstream responses.

## 9. Entity resolution

Resolution is deterministic, versioned, explainable, and tested. It does not use an LLM.

Normalization:

- Unicode NFKC, trim, lowercase, collapse whitespace;
- usernames: remove a single leading `@`, never fuzzy-match short usernames;
- URLs: HTTPS, lowercase host, remove tracking parameters and fragments;
- organizations: normalize legal suffixes only through a fixed dictionary;
- locations: compare normalized country/region only; never geocode exact addresses.

Signals (maximum 10,000 basis points):

- verified owner-submitted cross-link: 10,000;
- exact stable source ID: 10,000;
- exact username plus reciprocal link: 9,500;
- exact username: 4,000;
- exact normalized full name: 2,500;
- organization agreement: 2,000;
- coarse location agreement: 1,000;
- topic/activity overlap: up to 1,000.

Contradictions:

- conflicting stable source ID or verified owner rejection: force reject;
- materially different name plus different organization: cap at 6,900;
- missing data contributes zero; it is never treated as agreement.

Decision:

- `>= 9000` **and** at least two independent positive signals: `accepted`;
- `7000–8999`: `review`;
- `< 7000`: `rejected`.

Operator-submitted URLs are not intrinsically trusted: they remain `review` unless the
normal resolver reaches the acceptance threshold. A URL submitted by the verified profile
owner supplies the verified-owner signal and may be accepted automatically.

Every record stores `resolverVersion`, score components, and contradictions. A future
resolver change does not silently rewrite previous decisions; it runs through a versioned
backfill/review task.

## 10. API contract

All organization routes require `requireTenantPrincipal`, verify the builder is tracked in
the active organization, and use `withTenantContext` repositories.

### `POST /api/builders/:builderIdentityId/evidence-refresh`

Body:

```json
{ "connectors": ["github"], "submittedUrls": ["https://example.com/profile"] }
```

- Zod: connectors 1–10 unique IDs; URLs 0–10; body <= 16 KiB.
- Intersect requested connectors with compile-time policy and runtime allowlist.
- Return `202 { jobId, status: "queued", acceptedConnectors, blockedConnectors }`.
- Existing active job returns `200` with that job (idempotent).
- Restricted identity returns `409 { error: "processing_restricted" }`.
- Rate limit: 10 requests/user/hour and one active job/org/builder.

### `GET /api/builders/:builderIdentityId/evidence`

Returns latest job summary and non-expired accepted/review evidence for the active
organization. Never returns another organization's review state.

### `PATCH /api/builders/:builderIdentityId/evidence/:evidenceId`

Organization admin/owner only. Body `{ resolution: "accepted" | "rejected" }`.
Records reviewer and timestamp. Cannot override a subject restriction.

### `POST /api/admin/enrichment/run-worker`

Admin-authenticated HTTP-cron endpoint with no caller-selected organization, builder, or
connector. Claims up to `ENRICHMENT_BATCH_SIZE` due jobs and returns aggregate counts only.

### Subject restriction endpoint

`POST /api/me/builder/:builderIdentityId/restrict-processing` for a verified claimant.
Platform-admin/privacy-support fallback must be a separately audited workflow. Activating
restriction cancels queued jobs and deletes organization evidence payloads in bounded
batches while retaining only minimal suppression/audit data.

`GET /api/me/builder/:builderIdentityId/evidence-provenance` lets a verified claimant see
the source URL, field categories, observation date, and current retention state aggregated
across organizations. It never exposes organization, recruiter, job, reviewer, notes, or
match-score metadata. A correction/dispute action uses the restriction endpoint first;
the verified claimed profile remains the authoritative correction surface.

## 11. Worker semantics

1. Select due jobs with `FOR UPDATE SKIP LOCKED` through the worker role.
2. Atomically set `running`, increment attempts, and assign a random lease token with a
   five-minute expiry.
3. Recheck source policy and subject restriction after the lease is acquired.
4. Load the tenant's tracked target inside `withWorkerOrganization`.
5. Execute connectors sequentially per job; jobs may run with bounded concurrency of two.
6. Validate, minimize, hash, resolve, and persist each evidence candidate.
7. Mark `succeeded` when at least one candidate is accepted/review, `partial` when some
   connectors failed but evidence exists, or `failed` otherwise.
8. Retry only `rate_limited`/`upstream_unavailable`, maximum three attempts, with
   deterministic exponential delays of 5 minutes, 30 minutes, and 2 hours plus jitter.
9. A crashed worker leaves an expiring lease; the next run can reclaim it.
10. Emit structured counts and stable error codes, never personal payloads or URLs.

Double execution is safe because active-job and content-hash uniqueness absorb duplicates.

## 12. Configuration

Add to `src/shared/lib/env.ts` and both env example files:

```text
ENRICHMENT_ENABLED=false
ENRICHMENT_ALLOWED_CONNECTORS=github
ENRICHMENT_BATCH_SIZE=10
ENRICHMENT_MAX_ATTEMPTS=3
ENRICHMENT_LEASE_SECONDS=300
ENRICHMENT_RAW_RETENTION_DAYS=30
ENRICHMENT_ACCEPTED_RETENTION_DAYS=180
ENRICHMENT_USER_AGENT=BuilderHuntBot/1.0 (+https://builderhunt.dev/crawler)
```

Production validation when enabled:

- allowlist is non-empty and contains only compile-time enabled connectors;
- user agent includes an HTTPS information/contact URL;
- retention is within policy bounds;
- `DATABASE_WORKER_URL` is distinct;
- authorized-crawl connectors require shared Redis and an approved host policy.

`ENRICHMENT_ENABLED=false` is the global kill switch. It prevents new jobs and makes the
worker return a no-op report; reads and subject rights remain available.

## 13. UI behavior

Add `PublicEvidenceCard` to `BuilderProfilePage` near the existing `PersonaCard`:

- states: unavailable, idle, queued/running, accepted, review required, partial, failed,
  stale, and processing restricted;
- show source links, observed/expiry dates, confidence label, and match signals;
- never show a percentage without its evidence explanation;
- refresh button is disabled while a job is active;
- review controls are visible only to organization admin/owner;
- distinguish **source-reported**, **organization-confirmed**, and **builder-verified**;
- no enriched field is exported or displayed publicly by default.

## 14. Security and privacy requirements

- RLS and composite tenant foreign keys on both organization tables.
- Worker role gets only the commands required for job/evidence processing.
- App/API tests prove own/other/random ID isolation for every route and review action.
- Input URLs undergo SSRF protection before any network call.
- Logs use stable IDs/counts only; extend redaction for `profileUrl`, `sourceUrl`,
  `submittedUrls`, evidence payload, names, and locations.
- HTML parsers, if a host is later approved, operate on bounded untrusted input and never
  execute scripts.
- Source-derived text is not sent to an LLM in this plan.
- Existing account/organization export and deletion must include or erase tenant evidence.
- Update privacy policy, terms, crawler information page, and product claims before
  production activation. Legal copy must identify categories, purposes, basis, sources,
  retention, rights, and contact path.
- The source register must contain an approved legitimate-interest assessment or other
  lawful-basis reference and a review expiry for each enabled connector. An empty or
  expired reference fails closed in production.

## 15. Observability and service-level objectives

Structured events:

- `enrichment_job_enqueued`
- `enrichment_worker_run`
- `enrichment_connector_result`
- `enrichment_review_decision`
- `enrichment_retention_run`
- `enrichment_subject_restriction`

Metrics contain connector ID, result code, duration bucket, attempt, and count only.

Initial SLOs after the canary:

- 95% of manual jobs reach a terminal state within 10 minutes;
- zero cross-tenant reads/writes in the isolation suite;
- zero requests to blocked/unlisted hosts;
- zero automatic retries after policy/auth/challenge denial;
- 100% of terminal records receive an expiry timestamp;
- retention backlog returns to zero within 24 hours;
- worker duplicate execution creates zero duplicate evidence rows.

Data yield is a product metric, not an availability SLO. `no_data` is a successful,
expected connector outcome.

## 16. Acceptance criteria

The feature is implementation-complete only when:

1. migration applies to a fresh database and upgrades a populated local database;
2. exact app/worker-role RLS tests pass, including missing and stale tenant context;
3. policy tests prove blocked connectors cannot be invoked by request or env override;
4. connector contract tests cover success, no data, 429, timeout, 401/403, robots deny,
   challenge page, oversized response, redirect to disallowed host, and invalid payload;
5. resolver golden tests cover thresholds, contradictions, Unicode, short usernames, and
   deterministic score/version output;
6. overlapping workers and expired leases are integration-tested against Postgres;
7. API isolation, rate limit, idempotency, review authorization, and restriction pass;
8. retention, export, erasure, and log-redaction tests pass;
9. UI states pass component tests and authenticated browser smoke tests;
10. runtime network evidence proves only allowlisted hosts were contacted;
11. the kill switch is exercised in runtime;
12. production remains disabled until legal copy and the source-policy approval record are
    complete.

## 17. Explicitly deferred

- Scheduled refresh activation (after manual canary).
- Additional official API contracts.
- Approved crawling of organization websites.
- Cross-source graph resolution.
- Public display of accepted evidence.
- Any AI-generated interpretation of evidence.
