# Public Profile Enrichment — Source Approval Register

> Companion to [`src/lib/enrichment/policies.ts`](../../src/lib/enrichment/policies.ts)
> (the compile-time enforcement point) and
> [`plans/implemented/phase-1/42-stealth-scraping/spec.md`](../../plans/implemented/phase-1/42-stealth-scraping/spec.md) §4.
> Every connector registered in `policies.ts` must have exactly one entry below.
> An entry with status `blocked` has no approval date and no lawful-basis reference.

## github

- **Acquisition mode**: `official_api` (GitHub REST API)
- **Status**: `enabled`
- **Owner**: Platform team
- **Permission reference**: GitHub REST API terms of service — public read-only endpoints,
  existing `GITHUB_TOKEN`. No scraping of `github.com` HTML pages.
- **Lawful basis**: legitimate interest (recruiter reviewing a candidate's already-public,
  self-published developer profile the builder chose to expose via a public API).
- **Approved fields**: profileUrl, username, displayName, headline (bio), organization,
  location, topics (public repo topics).
- **Allowed hosts**: `github.com`, `api.github.com`
- **Robots directive required**: no (official API, not HTML crawling)
- **Rate limit**: 20 requests/minute (well under GitHub's authenticated 5000/hour budget)
- **Retention**: raw candidate 30 days, accepted evidence 180 days
- **Review date**: 2026-07-20
- **Expiry**: 2027-07-20 (must be re-reviewed before this date; policies.ts fails closed
  automatically once expired)
- **Kill-switch owner**: Platform team — `ENRICHMENT_ALLOWED_CONNECTORS` env var

## user-submitted

- **Acquisition mode**: `user_submitted`
- **Status**: `enabled`
- **Owner**: Platform team
- **Permission reference**: the organization member or the verified profile owner submits
  the URL themselves; no automated fetch occurs for this connector.
- **Lawful basis**: consent (submitter-provided) / legitimate interest for org-submitted URLs.
- **Approved fields**: profileUrl only (stored as attributed evidence; no scraping).
- **Allowed hosts**: none — this connector never makes an outbound request.
- **Robots directive required**: n/a
- **Rate limit**: n/a
- **Retention**: raw candidate 30 days, accepted evidence 180 days
- **Review date**: 2026-07-20
- **Expiry**: 2027-07-20
- **Kill-switch owner**: Platform team

## linkedin

- **Acquisition mode**: `official_api` (not integrated)
- **Status**: `blocked`
- **Permission reference**: <https://www.linkedin.com/legal/crawling-terms> — prohibits
  automated crawling without express permission. No permission on file.
- **Lawful basis**: none — blocked.
- **Approved fields**: none. A LinkedIn URL may still be stored as a `user-submitted` link;
  it is never fetched.
- **Review date**: 2026-07-20 (re-review only if legal/product secures an API contract or
  written crawl permission)

## x

- **Acquisition mode**: `official_api` (not integrated)
- **Status**: `blocked`
- **Permission reference**: <https://x.com/en/tos> — prohibits scraping without prior
  written consent. No permission on file.
- **Lawful basis**: none — blocked.
- **Approved fields**: none.
- **Review date**: 2026-07-20

## facebook / instagram

- **Acquisition mode**: `official_api` (not integrated)
- **Status**: `blocked`
- **Permission reference**: <https://www.facebook.com/legal/automated_data_collection_terms>
  — requires express written permission. No permission on file.
- **Lawful basis**: none — blocked.
- **Approved fields**: none.
- **Review date**: 2026-07-20

## sourcehut (git.sr.ht / meta.sr.ht)

- **Acquisition mode**: `official_api` (retired 2026-08-04 — `drizzle/0143_retire_sourcehut_source.sql`)
- **Status**: `retired`. `search_sources` now holds `enabled = false, connector_implemented = false`, and the
  connector is deleted. The table's `CHECK ("enabled" = false OR "connector_implemented" = true)` means the
  source cannot be switched back on until a connector exists again, and `setSearchSourceEnabled` answers
  `no_connector` rather than a constraint error if anyone tries. The row is kept rather than deleted so this
  register still has something to point at; reversing it is one migration flipping both booleans.
- **Permission reference**: <https://git.sr.ht/robots.txt> (identical at meta.sr.ht), read
  2026-08-04. The file opens with a prose policy, not just directives:

  > Allowed: search engine indexers, archival services. **Disallowed: marketing or SEO
  > crawlers; anything used to feed a machine learning model**; bots which are too aggressive.

- **Lawful basis**: none. BuilderHunt indexes profiles into `builder_embeddings` (pgvector) and
  feeds AI ranking and explanation — it *is* the "used to feed a machine learning model" case the
  policy names. That excludes the use regardless of authentication, so a `SOURCEHUT_TOKEN` would not
  change the answer.
- **Approved fields**: none.
- **Also checked, 2026-08-04**: the unauthenticated surface was probed directly rather than assumed.
  `https://git.sr.ht/~user` answers 200 with a bare list of repository names, and is not in the
  machine-readable `Disallow` list. Everything that carries actual signal **is**: `/*/*/log/*`
  (including the per-repo `log/rss.xml` feed that returns 200), plus `blame`, `commit`, `tree`,
  `item`, `*/raw`, and any URL with a query string. So the only crawlable surface is a list of
  repository names with no activity, no dates and no profile fields — and the purpose policy excludes
  even that.
- **Review date**: 2026-08-04

## hashnode

- **Acquisition mode**: `official_api` (retired 2026-08-04 — `drizzle/0144_retire_hashnode_source.sql`)
- **Status**: `retired`. `search_sources` holds `enabled = false, connector_implemented = false` and the
  connector is deleted, same mechanism as `sourcehut` above.
- **Permission reference**: <https://hashnode.com/announcements/graphql-api> — "GraphQL API is moving to a paid
  offering."
- **Lawful basis**: none needed; nothing is fetched. Re-verified live 2026-08-04:
  `POST https://gql.hashnode.com` answers `301` to that announcement, and the older `api.hashnode.com` answers
  `404` (in July it still redirected).
- **Approved fields**: none.
- **Why it went unnoticed**: `HASHNODE_API_KEY` was documented as *optional*, so a source returning `[]` with no
  key looked identical to a source returning `[]` because the API had closed. Worth remembering when adding any
  future source whose key is optional.
- **Review date**: 2026-08-04

## Runtime adversarial matrix — run 2026-08-05

Evidence for `plans/implemented/phase-1/42-stealth-scraping/task.md` Phase 7, "Run runtime adversarial matrix".
Reproduce with `pnpm test:enrichment-matrix:local`
([`scripts/ops/run-enrichment-matrix-local.sh`](../../scripts/ops/run-enrichment-matrix-local.sh) →
[`scripts/ops/verify-enrichment-adversarial-local.mjs`](../../scripts/ops/verify-enrichment-adversarial-local.mjs)).
**Result: 20/20 checks across all twelve cases, exit 0.** The count grew with the run: 17/17 on the
first pass, then a regression assertion added for each defect the exercise found and the maintainer then
had fixed. Every one of those assertions failed before its fix and passes after — see Findings.

**Environment.** A disposable `builderhunt_security_test_*` Postgres 18 database with the full
migration chain applied, connected through per-run login roles inheriting `builderhunt_app`, `_auth`,
`_worker` and `_platform` — so grants and RLS are enforced, not bypassed by an owner connection.
`ENRICHMENT_ENABLED=true`, `ENRICHMENT_ALLOWED_CONNECTORS=github`. Not production, and not the
development database.

**What was real and what was simulated**, stated because the distinction is the evidence's value:

- Real: schema, roles, RLS, route handlers, worker loop, source-policy register, allowlist resolution,
  resolver, retention SQL, restriction cascade, and the kill switch (a genuinely separate OS process
  with the flag off).
- Simulated: the **transport**, for the fault cases only. `globalThis.fetch` was replaced by a
  recorder that logs every outbound request and answers the case's scripted status. No upstream can
  be asked to return a challenge, a 429 and a hang on demand.
- Real network, once: case 01b performed an actual HTTPS GET to `api.github.com` through the same
  `safeFetch` envelope. Requests by transport across the run: **10 scripted, 1 real**.

**Contacted-host list — the complete set of HTTP requests the process made**, from first import to
exit: `api.github.com/users/{adv-scripted, octocat, adv-blocked, adv-challenge, adv-ratelimited,
adv-timeout, adv-crash, adv-restricted}`, plus three scripted `robots.txt` reads
(`api.github.com`, `github.com`, `raw.githubusercontent.com`) in case 03. **Zero requests to
`linkedin.*`, `x.com`, `twitter.*`, `facebook.*` or `instagram.*`**, asserted over the whole run and
not per case. Note the recorder counts HTTP requests: the SSRF guard still resolves an allowlisted
host's DNS before a scripted response is returned.

| # | Case | Outcome | Job / run id | First log event |
|---|------|---------|--------------|-----------------|
| 01a | allowlisted host succeeds (scripted) | 202 enqueue → job `succeeded`, one **`accepted`** evidence row at 10 000 bps (`exact_stable_source_id`, `exact_username`, `exact_full_name`, `location_agreement`) carrying the 180-day accepted-retention window | `babd20da695e40dc559d4835`, `job_runs:36912576-9d07-4ef6-940a-f8768494858d` (`succeeded`, processed 1) | `enrichment_worker_run@2026-08-05T16:09:02.650Z` |
| 01b | allowlisted host succeeds (real network) | real GET to `api.github.com/users/octocat`; response passed the envelope and persisted one evidence row, `accepted` at 10 000 bps — the stable-id signal firing against the live API, not a stub. The case pins the transport, not the verdict | `8472a688a26018cd4ca5c3c3` | `enrichment_worker_run@2026-08-05T16:09:02.693Z` |
| 02 | blocked host | `linkedin` dropped into `blockedConnectors`; the pasted LinkedIn URL stored as `user_submitted` evidence resolved **`review` at 0 bps and visible through the tenant read**; direct `safeFetch` refused `host_not_allowed` **without opening a socket**; zero blocked-host requests | `92a5cd9282b31e33515bbbcd` | `enrichment_worker_run@2026-08-05T16:09:02.956Z` |
| 03 | robots.txt denial | `Disallow` → `disallowed`; longest-match `Allow` → `allowed`; 4xx → `no_robots_file` (RFC 9309 §2.3.1.3); 5xx → `unavailable` | n/a (library-level) | n/a |
| 04 | challenge / auth wall | 403 → connector `stop`; job `failed` with `all_connectors_failed`, one attempt, zero evidence, no retry scheduled | `560ce0eeb0bf77dc208eda9b` | `enrichment_worker_run@2026-08-05T16:09:03.011Z` |
| 05 | 429 | requeued to `queued`, `last_error_code=rate_limited`, `available_at` +120s from the upstream `Retry-After`, lease released | `0462d2f747a87cc8dd378080` | `enrichment_worker_run@2026-08-05T16:09:03.039Z` |
| 06 | timeout | hung upstream aborted after **~10 030 ms**; requeued with `upstream_unavailable` | `3ad55cc635163d60fdd70793` | `enrichment_worker_run@2026-08-05T16:09:03.068Z` |
| 07 | two overlapping jobs | first 202, second **200 with the same jobId**; exactly one job row | `346c51339efb9550c12c4580` | n/a (no connector ran) |
| 08 | worker crash + reclaim | job left `running` with a live lease; next run reclaimed 1 lease and drove it to `succeeded` at attempt 2 with one evidence row | `6d6d611eed441ef7f79a5d5a` | `enrichment_worker_run@2026-08-05T16:09:13.137Z` |
| 09 | restriction mid-flight | restriction 200 → 1 job cancelled, 1 evidence row purged cross-org; a job enqueued *after* the restriction was cancelled with `processing_restricted` having contacted **0 hosts**; refresh route answers 409; and the run closed `job_runs` as **`succeeded`**, counting the stop as `cancelled: 1, failed: 0` | `f6cd4a820ef1b62137aa285b`, `adv-job-post-restriction` | `enrichment_subject_restriction@2026-08-05T16:09Z` |
| 10 | retention expiry | pass 1: 3 expired rows deleted, live `accepted` row kept, 200-day-old job **kept** (see finding 1); pass 2 after that row expired: row deleted and job retired. Tenant API showed exactly the 1 live row | `adv-job-retention` | `enrichment_retention_run@2026-08-05T16:09:13.235Z` |
| 11 | export and delete | subject provenance 200 with 1 entry, **field names only, no payload values**; the tenant read returned its row through the app role; an app-role `delete` on `enrichment_evidence` **refused `42501`** by the grant (see finding 2); deleting the organization row cascaded its enrichment jobs and evidence to zero; and untracking a single builder that holds evidence now returns `true` with its rows gone, where it used to raise 23503 (see finding 7) | n/a | n/a |
| 12 | kill switch | separate process with `ENRICHMENT_ENABLED=false`: worker returned `disabled`, claimed 0, enqueue route answered 503 `enrichment_disabled`, **0 requests made**, and the queued job was still `queued` afterwards | `adv-job-killswitch` | n/a |

### Findings

1. **Fixed in this run — the retention pass could take the whole worker down.**
   `enrichment_evidence_organization_job_fk` (drizzle/0016) is `ON DELETE NO ACTION`, accepted evidence
   is retained 180 days, and jobs were retired at 90 — so the job sweep raised `23503` for every
   successful job in that window, and because the sweep runs inside `runEnrichmentWorker` the
   exception failed the *entire* run: HTTP 500, `job_runs` closed `failed`, and the evidence half of
   retention stopped too. First reproduced by case 10 on this run. Fixed by only retiring jobs nothing
   references (`src/shared/lib/repositories/enrichment-worker.ts`), deliberately **not** by cascading
   the FK — that would delete accepted evidence at 90 days and silently shorten the retention promised
   above. Regression pinned in `tests/unit/shared/lib/repositories/enrichment-worker.test.ts`.
   No production data was affected: `ENRICHMENT_ENABLED` was `false` and no evidence row has ever
   existed there.
2. **Resolved 2026-08-05 by decision — the organization-level delete/export helpers were removed.**
   `deleteOrganizationEnrichmentData` and `listEnrichmentEvidenceForExport` had **no caller anywhere in
   `src/`**, and both took the app-role transaction: `builderhunt_app` holds `SELECT, UPDATE` on
   `enrichment_evidence` and `SELECT, INSERT` on `enrichment_jobs` (drizzle/0017), so the delete was
   refused `42501` when this matrix first called it. A helper that cannot execute is worse than an
   absent one — it reads as proof that the deletion path exists. Both deleted, with the reasoning left
   in place of the code in `src/shared/lib/repositories/enrichment.ts`.

   The grant itself is now pinned directly by case 11: an app-role `delete from enrichment_evidence`
   must keep failing `42501`. The paths that do work and are exercised in the same case: deleting the
   organization row cascades its jobs and evidence away, and the subject's own
   `restrict-processing` / `evidence-provenance` routes purge and export their data across every
   organization. **If a per-organization purge is ever wanted without deleting the organization, it
   needs a worker-role write path — not a wider grant on the app role.**
3. **Fixed 2026-08-05 — nothing was ever auto-accepted.** `runEnrichmentWorker` called
   `resolveEnrichmentCandidate` without `candidateSourceRecordId`, so `exact_stable_source_id`
   (10 000 bps, the signal whose entire purpose is to auto-accept an exact ID match from the source's
   own API) never scored. Case 01a showed the candidate's `source_record_id` equal to the target's
   `source_id` and the row still resolving to `review` at 7 500: every candidate queued for human
   review, however well it matched. The worker now passes it. Case 01a asserts the accept path,
   including that an accepted row carries the **180-day** window and not the 30-day raw one, and case
   01b shows the same signal firing against the live GitHub API. The connector fetches by the tracked
   identity's own username through the official API, so the id it returns is the strongest evidence
   available rather than an inference.
4. **Fixed 2026-08-05 — an operator-submitted URL is now visible.** A LinkedIn URL a recruiter pasted
   resolved to `rejected` at 0 bps, and the tenant read returns only `accepted`/`review`: the row was
   written, never shown to the person who typed it, and deleted after seven days. The resolver gained an
   `isOperatorSubmitted` input that floors the **resolution** at `review` while awarding **no
   confidence** — an attributed link awaiting a human's decision, which is what it is. No
   `RESOLVER_VERSION` bump: the input defaults false, so every previously-scored candidate resolves
   bit-identically. A forced reject (conflicting stable id, verified-owner rejection) still wins, and
   case 02 asserts visibility through the real route the UI calls, not the table.
5. **Fixed 2026-08-05 — a privacy cancellation is no longer counted as a worker failure.** A job
   cancelled with `processing_restricted` incremented `result.failed`, which the run-worker route maps
   to `job_runs.state = 'failed'` — so the most correct thing this worker does closed the run as a
   failure and would have tripped any alert on failed runs. `EnrichmentWorkerResult` gained a
   `cancelled` counter; case 09 now asserts `cancelled: 1, failed: 0` and `job_runs.state = 'succeeded'`
   for a run whose only work was honouring a restriction.
6. **Fixed 2026-08-05 — untracking a builder with enrichment data answered 500.** The same foreign-key
   family as finding 1, through a user-facing door. `DELETE /api/builders/:id` deletes only the
   `organization_builders` row, and with `ON DELETE NO ACTION` on
   `enrichment_evidence_organization_builder_fk` and `enrichment_jobs_organization_builder_fk` (0016)
   that raised `23503` for any builder the organization had enriched — so "stop following this person"
   failed for exactly the people the product had enriched, and the evidence row survived the attempt.
   Deleting a whole organization was never affected: both cascades from `organizations` fire in one
   statement, and a NO ACTION check runs at end-of-statement.

   `drizzle/0150_enrichment_untrack_cascade.sql` cascades both. That is the right answer on its own
   terms and not merely the convenient one: the lawful basis recorded above is a recruiter's legitimate
   interest in a candidate they track, and it ends when the tracking ends — so an organization's copy of
   the evidence going with the untrack is what this register already promises. The third FK on this pair
   of tables, evidence → job, deliberately stays NO ACTION for the reason in finding 1. Verified on the
   applied migration: `confdeltype` is `c`, `c`, `a` respectively. Regression pinned at the constraint
   level in `tests/unit/shared/lib/repositories/enrichment-worker.test.ts`, because what would regress is
   the FK's ON DELETE action and that binds the table owner too, unlike a grant or a policy.
7. **Noted — the structured logger mints no event id.** `log.ts` writes `ts` + `event` per line and
   nothing that identifies one emission. The task asked for a "log event ID" per case; this register
   records `event@ts`, which is unique in a log stream, rather than inventing an id the code does not
   produce.

### Scope limits of this run

- No enabled connector is in `authorized_crawl` mode (github is `official_api`, user-submitted makes
  no request), so robots.txt is a library guarantee with no active caller at this configuration.
  Case 03 asserts that too, rather than implying robots is gating live traffic.
- The lease expiry in case 08 was advanced by SQL instead of waiting five minutes. Only the clock was
  simulated; the reclaim path is the real one.
- This is a functional matrix, not a load or canary test. The seven-day dark canary and its approval
  remain in [`plans/phase-5/01-production-readiness-audit`](../../plans/phase-5/01-production-readiness-audit/tasks.md).

## Other existing BuilderHunt sources (reddit, hn, devto, npm, huggingface, gitlab,
## codeberg, lobsters, stackoverflow)

Not yet registered in `policies.ts` — per spec §4, "missing policy means disabled."

**Clarified 2026-08-05 on the maintainer's instruction: the review gates *enabling* a connector, not
*building* one.** The earlier wording — "each needs its own source-policy review before it can be added" —
was read as a gate on the engineering, which left nine sources with no adapter at all. The order is now the
other way round: build the exact-profile adapter, register the source with `status: 'approval_required'` so
`resolveExecutableConnectorIds` keeps it disabled no matter what the runtime allowlist says, and let the
review decide whether it ever flips to `enabled`. Having the adapter and switching it off is strictly better
than not having it — a disabled adapter costs nothing and a missing one costs a rebuild.

The review question itself is unchanged, and it is a real one: does the source's existing federated-search
endpoint support fetching **one known profile by ID**, without broad search? A source that only supports
broad search does not get an adapter, because the adapter would then be the thing this whole plan exists to
avoid.

**The four hard-blocked platforms are a different category and do not move.** `linkedin`, `x`, `facebook`
and `instagram` are in `HARD_BLOCKED_CONNECTOR_IDS` (`src/lib/enrichment/policies.ts:28`) because their
terms prohibit automated collection without written permission that is not on file — that is not a phase
gate waiting on a review, and no flag makes it lawful. A URL for one of them can still be stored as
`user-submitted` evidence and is never fetched, which is the shape the spec §5.3 already allows and case 02
of the adversarial matrix verifies.
