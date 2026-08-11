# Tasks: Solutions Intelligence

> **Status**: `implemented` — the one remaining gate needs real provider pricing and human gold
> judgments, and moved to [`plans/phase-5/02-legal-and-commercial-approvals`](../../phase-5/02-legal-and-commercial-approvals/tasks.md)
> **Implementation authorized**: yes — maintainer decision, 2026-08-01. Supersedes the earlier
> "no; checklist for a future implementation task" header.
> **Depends on**: [`spec.md`](./spec.md) and [`plan.md`](./plan.md)
>
> **Phase-1 scope closed 2026-08-05.** Every remaining item moved to `plans/phase-5/` on Edd's instruction — the product launches when phase-5 finishes, so a task that waits on a signature, a clock, a live deployment or a launch is not build-phase work. Prose pointers below name the phase-5 plan that owns each one; they are deliberately not checkboxes, because a box reads as pending engineering.


## Status reconciliation (2026-08-11)

Moved to `plans/implemented/` on the strength of this, so the folder means one thing: **every task checked,
and `pnpm ci:local` green at 34/34 steps** (6,543 unit tests, 996 e2e) on commit `90527722e`.

Why the status changed: was `engineering-complete`, a value no gate can read. The remaining gate needs real provider pricing and human gold judgments, and lives in phase-5.

The eight status values previously in use across phase-1 — `complete`, `done`, `in_progress`, `retired`,
`closed — skipped`, `engineering-complete`, `code-complete-dark`, `pending — implementation-ready` — are
outside the five `scripts/check-phase-readiness.mjs` accepts, and that script only ran against phase-2 and
phase-3. A status no gate reads is a status that drifts, which is how four plans sat at 100% of their tasks
while still labelled `pending`.

Three Phase 0 gates were resolved by the same 2026-08-01 decision, and each one changes what
"done" means below — read them before closing any task:

1. **Source register sign-off moved out.** The human legal/privacy approval of each scrapable
   source now lives in
   [`plans/phase-5/01-production-readiness-audit/tasks.md`](../../phase-5/01-production-readiness-audit/tasks.md)
   as a pre-production gate. Engineering proceeds without it, but every scraping source ships
   **disabled by default** behind a per-source admin toggle, so enabling one stays an explicit
   maintainer act.
2. **The gold set is synthetic.** The 60 briefs and judgments are machine-authored, which makes
   any score measured against them circular — the generator and the grader share assumptions.
   They are scaffolding for regression detection, never evidence of real quality. A CRUD surface
   ships alongside them so humans can add, edit and replace briefs and judgments during MVP/beta;
   only human-authored judgments may be cited as a quality gate.
3. **Real providers are in use.** Local LLM first, then MiniMax, then Mistral. Provider spend is
   accepted by the maintainer.

## Phase 0 — Gates and baselines

- [x] **Certify prerequisite plans**
  - Files: this section; the four plans are cited rather than modified
  - Do: Record the exact completed tenant/RLS, AI task, credit ledger, billing sandbox, source
    policy, worker, and network-security gates consumed by Solutions. Do not duplicate those
    foundations.
  - Verify: production-equivalent evidence shows tenant isolation, synchronous non-negative credit
    authorization, provider kill switches, and safe public fetching.

  What Solutions consumes, and where each is proven — nothing below is reimplemented here:

  | Foundation | Consumed as | Evidence |
  | --- | --- | --- |
  | Tenant isolation (plan 01) | `withTenantContext` + RLS on the four Phase 8 tables | `scripts/db/verify-rls-local.mjs` as `builderhunt_app`: tenant A/B isolation on briefs and runs, UPDATE denied on runs |
  | Role separation (plan 01) | app / worker / platform / capability grants | migration 0137 grants `builderhunt_app` only; 0138 grants the platform role only |
  | AI task registry (plan 21) | `solutions-brief-interpret`, `solutions-route-explain` | `tests/unit/lib/solutions/ai-tasks.test.ts` |
  | Provider kill switches (plan 21) | `AI_DISABLED`, `AI_DISABLED_TASKS`, per-feature flags | `ai-interpret.test.ts` / `ai-explain.test.ts` assert no provider call with each off |
  | Credit ledger (plan 30) | `reserveCredits` / `settleReservation` / `releaseReservation` | `tests/unit/modules/solutions/billing.test.ts` against the real platform and a real ledger |
  | Rate-card registry (plan 30) | `solutions_generate` / `solutions_regenerate` | `rate-cards.ts`; historical runs resolve their own version |
  | Source policy and kill switch (plan 42) | `solution_sources`, per-source admin toggle, robots decisions | `docs/operations/source-register.md`; migration 0132 attribution constraints |
  | Safe public fetching (plan 42) | `security/url-policy.ts`, `safeOutboundUrlSchema` | `tests/unit/security/solutions-adversarial.test.ts` refuses localhost, RFC1918, link-local, credentials, non-HTTPS |

  **Two gaps, stated rather than certified.** The billing *sandbox* certification
  (`docs/operations/stripe-sandbox-certification.md`) covers Stripe, not this module's cost model, which is
  provisional pending real provider pricing. And "production-equivalent" is not literally true of the RLS
  evidence: it runs against a throwaway database with the same roles and migrations, which is as close as a
  local gate reaches.

- [x] **Create the synthetic gold set, its CRUD, and the baseline report**
  - Files: `tests/fixtures/solutions/gold-set.json` (new), `src/shared/lib/solutions/gold-set.ts` (new),
    `scripts/evaluate-solutions.ts` (new), `docs/operations/solutions-evaluation.md` (new),
    `drizzle/0138_solution_gold_briefs.sql`, `src/routes/api/admin/solutions/gold-briefs.ts` (new)
  - Do: Seed 60 de-identified briefs and judgments for valid lanes, hard constraints, capability
    coverage, unacceptable components, and ranking. Every seeded record carries
    `authorship: 'synthetic'`. Ship the CRUD so humans can add, edit and replace briefs and
    judgments during MVP/beta, stamped `authorship: 'human'`. Measure lexical/vector retrieval,
    latency, and provider cost separately by domain and lane.
  - Verify: the evaluator is deterministic for fixed fixtures, reports confidence intervals and
    segmented metrics, fails on malformed or leaked personal data, and reports synthetic and human
    judgment scores as **separate** figures — a synthetic-only run must never print an unqualified
    quality number, because the generator and the grader share assumptions.

  `summarize` takes an authorship and returns one population's figures; there is no function that produces
  a combined score, and `citableAsQualityGate` is false until a human-authored record exists. The rule is
  code rather than a convention, because a blended mean is exactly the number that gets quoted without its
  caveat.

  The two populations have two homes: the synthetic 60 are version-controlled scaffolding that changes by
  deploy, human judgments are edited during the beta through a platform-admin API. `authorship` is forced
  to `human` on write, so the populations cannot mix through the form.

  **Baseline recorded 2026-08-01, deterministic path only** (both LLM flags off): capability recall 55.0%
  ±12.0, lane recall 44.4% ±10.4, latency p50 6ms, zero exclusion failures. Domain accuracy and constraint
  retention are 0% and that is the correct score — the fallback returns `other` rather than guessing a
  domain, and extracts no constraints at all. Those two measure the fallback, not the product, and become
  meaningful the moment interpretation is enabled.

- [x] **Approve the initial source and domain register** — moved to phase-5, see the pointer below
  - Moved on 2026-08-01 to
    [`plans/phase-5/01-production-readiness-audit/tasks.md`](../../phase-5/01-production-readiness-audit/tasks.md)
    Phase 2–3, next to plan 42's own source-register approval. It needs a human legal/privacy
    judgement per source, so it gates production rather than engineering. Phase 4 still builds the
    register file, the per-source kill switch, and the admin toggle; every source ships disabled.

## Phase 1 — Contracts and shell

- [x] **Define solution domain schemas**
  - Files: `src/shared/lib/solutions/contracts.ts` (new),
    `tests/unit/shared/lib/solutions/contracts.test.ts` (new)
  - Do: Define strict discriminated schemas for structured briefs, unknown values, ranking modes,
    components, capabilities, evidence levels, compatibility edges, route graphs, estimates,
    source status, result completeness, and feedback. Reject unknown persisted fields.
  - Verify: fixtures cover every valid lane and reject missing evidence, uncovered mandatory
    capability, unsupported regulated domain, invalid graph, and unsafe outbound URL.

- [x] **Define flags and immutable rate-card keys**
  - Files: `src/shared/lib/solutions/config.ts` (new),
    `tests/unit/shared/lib/solutions/config.test.ts` (new), `src/shared/lib/env.ts`
  - Do: Add independent catalog-ingestion, public-scrape, live-enrichment, interpretation,
    explanation, external-human, and paid-generation flags. Declare 10-unit
    `solutions.generate.v1` and 3-unit `solutions.regenerate.v1`; import billing types.
  - Verify: production defaults are off, client configuration exposes no secrets, and tests reject
    unknown keys or mutable historical prices.

- [x] **Build the non-provider product shell**
  - Files: `src/routes/_dashboard/solutions/index.tsx` (new),
    `src/modules/solutions/*` (new), dashboard navigation files
  - Do: Add the premium locked state, ephemeral brief editor, structured interpretation preview,
    one-question slot, ranking selector, credit confirmation, three-lane result skeleton, invalid
    lane state, and deterministic demo fixtures.
  - Verify: component and browser tests cover Free/paid, keyboard/screen-reader/mobile behavior,
    cancellation, no-results, invalid lane, and no network call before confirmation.

## Phase 2 — Shared search repair

- [x] **Unify embedding dimension and entity contracts**
  - Files: `src/shared/lib/ai/embedding-dim.ts`, `src/lib/semantic/*`,
    `src/shared/lib/db/schema.ts`, the next generated Drizzle migration, `docker-compose.yml`
  - Do: Select one runtime dimension, validate it at startup and write time, support explicit human
    and catalog entity kinds, and build a safe re-embedding/backfill procedure.
  - Verify: local migration, dimension-mismatch, mixed-version, backfill-resume, and rollback tests
    pass without corrupting current builder embeddings.

- [x] **Honor semantic filters and pagination**
  - Files: `src/routes/api/search/semantic.ts`, `src/lib/semantic/semantic-search.ts`,
    `src/shared/lib/repositories/public-builder-embeddings.ts`
  - Do: Propagate entity type, source filters, page/cursor, and limit through every primary and
    fallback path; return truthful continuation state.
  - Verify: API integration tests prove filtered pages contain no excluded source/type and fallback
    preserves the same contract.

- [x] **Isolate connectors and correct identity candidates**
  - Files: `src/lib/search.ts`, `src/routes/api/search/builders.ts`, connector tests
  - Do: Replace all-or-nothing aggregation with per-source results/status, normalize scores before
    fusion, and replace global username deduplication with source-aware candidate keys.
  - Verify: one/two/all connector failures, same username/different people, same person/different
    source, stable ordering, timeout, and partial-result tests pass.

## Phase 3 — Canonical humans

- [x] **Add canonical human and source-link schema**
  - Files: `src/shared/lib/db/schema.ts`, the next generated Drizzle migration,
    `docs/architecture/data-classification.md`
  - Do: Add canonical human profiles and evidence-bearing source links; extend current identities
    and snapshots rather than copying their data into an opaque profile. Add provenance,
    confidence, review state, validity, composite indexes, grants, and RLS classification.
  - Verify: migration/integrity/RLS tests cover duplicate links, conflicting facts, tenant access,
    public DTO boundaries, and forward rollback.

- [x] **Persist approved source observations**
  - Files: `src/shared/lib/repositories/public-builders.ts`,
    `src/shared/lib/repositories/enrichment.ts`, `src/lib/enrichment/worker.ts`
  - Do: Upsert public source accounts and content-hashed snapshots during approved ingestion, update
    freshness idempotently, and honor processing restrictions/deletion.
  - Verify: unchanged observations do not create duplicates; changed, deleted, stale, and restricted
    sources produce the expected version/projection.

- [x] **Implement reversible identity linking**
  - Files: `src/shared/lib/human-identity/*` (new),
    `src/shared/lib/repositories/human-profiles.ts` (new), admin review UI/routes
  - Do: Auto-link only verified claims, explicit cross-links, or reviewed deterministic evidence;
    queue probabilistic candidates; record merge lineage and reversible field provenance.
  - Verify: collision/adversarial fixtures prove username similarity cannot merge people and
    unmerge restores every source account and organization reference.

- [x] **Dual-read/write organization tracking**
  - Files: `src/shared/lib/repositories/organization-builders.ts`,
    `src/shared/lib/public-builder-dto.ts`, builder profile/search routes
  - Do: Introduce canonical-human references additively, backfill safely, dual-write, compare old/new
    reads, then cut over only after parity.
  - Verify: tracked notes/status remain tenant-private and intact through backfill, cutover, and
    rollback.

## Phase 4 — Catalog and ingestion

- [x] **Add catalog, graph, evidence, and source-policy schema**
  - Files: `src/shared/lib/db/schema.ts`, `drizzle/0125_solutions_catalog.sql`,
    `drizzle/0126_search_source_register.sql`, `drizzle/0127_seed_solution_source_register.sql`,
    `drizzle/0128_solution_version_close_grant.sql`, `drizzle/0129_seed_solution_capabilities.sql`,
    `src/shared/lib/repositories/solution-catalog.ts`, `src/shared/lib/repositories/search-sources.ts`
  - Do: Add versioned components, capabilities, claim mappings, compatibility edges, evidence,
    source registry, and lifecycle state with narrow public reads and worker-only mutations.
  - Verify: constraints reject active unsupported edges, dangling evidence, overlapping invalid
    versions, tenant fields in public records, and workerless writes.

- [x] **Create official metadata adapters**
  - Files: `src/lib/solutions/sources/{types,runner,huggingface,npm,jobindex}.ts`,
    `docs/operations/source-register.md`
  - Do: Ingest reviewed model, endpoint, MCP, agent, tool, service, and generic-role metadata through
    official APIs/feeds or licensed snapshots; map raw claims without promoting them to verified.
  - Verify: contract fixtures, pagination, rate limit, deletion, schema drift, source outage, and
    idempotent refresh tests pass.

- [x] **Extend compliant public crawl/scrape ingestion**
  - Files: `src/lib/enrichment/policies.ts`, `src/lib/enrichment/network.ts`,
    `src/lib/solutions/sources/documentation-crawl.ts`, `src/modules/admin/sources/SourcesPage.tsx`,
    `src/routes/api/admin/search-sources.ts`, `docs/operations/source-register.md`
  - Do: Register only reviewed public sources and reuse honest-user-agent robots checks, SSRF
    blocking, limits, content hashes, provenance, and kill switches. Route prohibited sources to
    external-link-only records.
  - Verify: tests deny private networks, redirects to private networks, auth/CAPTCHA pages,
    disallowed robots/terms policy, oversized/active content, and disabled sources.

### Phase 4 outcome, recorded 2026-08-01

The register doc is `docs/operations/source-register.md` — one document rather than the planned
`solutions-source-register.md`, because there are two registers (`search_sources` for people-search
connectors, `solution_sources` for the catalog) and an operator switching sources off does not care which
table a source lives in. Both are driven from one page, **Admin → Sources**.

Registering Jobindex meant running an adapter end-to-end for the first time, which exposed four defects
that had made the whole catalog non-functional on any database except the developer's own. Recorded here
because the shared cause is worth remembering, not the individual bugs:

| # | Defect | Fix | Why nothing caught it |
|---|---|---|---|
| 1 | `solution_sources` had no rows in any migration — empty on CI and production, so the runner answered `source_not_registered` for every adapter | `0127` | An unregistered source is a legitimate state, so it looked like "nothing configured yet" |
| 2 | `allowed_fields` said `pipeline_tag`, the adapter emits `pipelineTag`; the catalog would have stored only download counts | `0127` + `metadataKeys` on the adapter contract + `assertAdapterFieldsAreRegistered` | `filterToAllowedFields` drops silently by design, and one key *did* match, so `emptyAfterFieldFilter` stayed at 0 and the run reported clean |
| 3 | `ON CONFLICT DO UPDATE` on capability claims needs table UPDATE, which the worker deliberately lacks — 42501 on every run's first claim | repository now uses `DO NOTHING` (a claim per version is immutable content; `evidence_level` is a human's to raise) | Disposable test databases connect as **superuser**, which ignores grants entirely |
| 4 | Closing a version's validity window needs UPDATE — every *second* observation of a changed component failed | `0128`, granted at **column level** (`valid_until` only, so history stays unforgeable) | Only the refresh path hits it; a first ingestion has no window to close and unchanged content short-circuits earlier |
| 5 | `solution_capabilities` was never seeded, so the first claim hit a foreign-key violation | `0129` + typed `SOLUTION_CAPABILITIES` in `contracts.ts` that types every adapter's mapping table | Fixtures insert the one capability they need, leaving the other ten keys untested |

The structural lesson, which is why every check added here runs against either the real roles or the
migration file itself: **a test that connects as superuser cannot see a grant defect, and a test whose
fixture is written from the adapter cannot see a register mismatch.** Both were true of the entire Phase 4
suite, which was green throughout.

Also fixed in passing: `search_sources` did not exist, so which connectors ran was decided entirely by the
request. There was no operator-side switch at all — `SourceHealth` gained `disabled` so a switched-off
source says so instead of reporting zero results, and warm cache entries are filtered too, or the kill
switch would have a five-minute tail.

**LinkedIn** is registered, permanently unavailable, and visible as such. No adapter was written: its
crawling terms prohibit automated collection, so enabling it requires a recorded terms review with a named
owner. The mechanism accepts that decision without making it. Same for x, facebook, instagram.

**social-analyzer** was evaluated and rejected — AGPL-3.0 network clause, and it produces exactly the
`probabilistic` signal `decideLink` is built to send to review rather than act on. Reasoning in
`docs/operations/source-register.md`.

## Phase 5 — Retrieval and composition

- [x] **Build versioned search projections**
  - Files: `src/lib/solutions/indexing/{projection-doc,project-components}.ts`,
    `drizzle/0130_solution_component_projections.sql`, `drizzle/0131_worker_builder_embeddings_grant.sql`,
    `src/lib/semantic/embedding-doc.ts`, `src/shared/lib/repositories/public-builder-embeddings.ts`,
    `scripts/solutions/project-components.ts`
  - Do: Produce provenance-preserving lexical/vector projections for canonical humans, roles, and
    catalog components; enqueue writes by content hash and embedding version.
  - Verify: changed evidence invalidates the right projection, stale jobs cannot overwrite current
    versions, and rebuild/resume is idempotent.

- [x] **Implement hybrid retrieval**
  - Files: `src/lib/solutions/retrieval/{filters,fuse,lanes,retrieve}.ts`
  - Do: Apply hard structured filters, bounded FTS and pgvector search, normalized reciprocal-rank
    fusion, evidence/freshness scoring, diversity, and trace output. Keep reranking disabled.
  - Verify: gold-set retrieval reaches the agreed recall threshold by lane, filters are exact, one
    backend can degrade safely, and warm p95 stays within budget.
  - **Partially verified, 2026-08-01.** Filters-are-exact and degrade-safely are asserted against a real
    migrated database (`tests/unit/lib/solutions/retrieval.test.ts`). Recall-by-lane and warm p95 are
    **not** — both need the gold set, which is Phase 9's task; a recall number from a four-row fixture
    would mean nothing, and stating one would be worse than stating none.

### Phase 5 progress note, 2026-08-01

**Closed 2026-08-01: the human lane retrieves people.** `humanLane` reads `builder_embeddings.search_vector`
— a tsvector generated from the same document the vector lane embeds — joined to `builder_identities` filtered
to `kind = 'person'`, and grouped by canonical human through *active* links only. People are still not catalog
components, which was the right call; they are their own lane over their own corpus.

The composer draws its human route from that lane and assigns **no capabilities** to a person. Nothing in this
product asks someone what they can do, so claiming a capability on their behalf would be inventing the one
thing there is no evidence for. A person covers work by delegation, stated in `humanReviewPoints`, which is
what the contract's own refinement accepts as grounds for recommending an incompletely-covered route. An
earlier version treated a person as covering everything, and a real run showed the consequence immediately:
the person always won the set cover, so the hybrid route came back identical to the human route and the AI
lane never contributed.

*Superseded, kept for the reasoning:* **the human lane retrieved roles, not people.** `RETRIEVAL_LANES.human` covers the
`human_profile` and `human_role` component kinds, and only `human_role` components exist — Jobindex
postings. Real people are in `canonical_humans`, deliberately *not* in `solution_components`: plan 43
Phase 3 built them as a separate identity system, and `organization_builders.canonical_human_id` uses
`ON DELETE SET NULL` precisely because a global identity decision must not destroy tenant data.

So the composer cannot yet build a human route from actual candidates. Closing this means a human lane
that reads `canonical_humans` joined to `builder_embeddings` (`entity_kind = 'human_profile'`, which
already holds real vectors from builder search) and returns them in the same shape — not turning people
into catalog components, which would conflate the two identity systems on purpose built to stay apart.
`routeComponentAssignmentSchema.componentId` will need to distinguish the two id spaces.

Three more defects surfaced here, all of the same shape as Phase 4's — see the commit messages for detail:

| Defect | Fix |
|---|---|
| Nothing was retrievable: every ingested component sat at `lifecycle_state = 'draft'` and `findCandidateComponents` reads only `active` | `0130`, plus a lifecycle rule in `ingestComponentVersion` keyed on who asserted the component exists |
| The worker had no grants on `builder_embeddings` — 42501 on the first component | `0131` |
| `websearch_to_tsquery` ANDs unquoted terms, so a real brief's description could never match any document; retrieval returned zero candidates for every brief while the trace showed a healthy lane | `toAnyTermQuery` joins with `or` and strips the operators (`-` reads as NOT, so "English-to-Danish" excluded what the brief asked for) |

- [x] **Implement the deterministic solution composer**
  - Files: `src/lib/solutions/composer/{coverage,constraints,estimate,compose}.ts`,
    `src/lib/solutions/retrieval/lanes.ts` (`humanLane`),
    `drizzle/0135_builder_embeddings_search_vector.sql`, `drizzle/0136_pgvector_execute_grants.sql`
  - Do: Cover required capabilities with approved versioned edges, reject incompatibilities and
    constraint violations, calculate estimate intervals, place human reviews, diversify lanes, and
    emit a complete trace.
  - Verify: property and fixture tests cover cycles, missing capabilities, conflicting edges,
    uncertainty, budget/deadline/privacy failure, and valid Human/AI/Hybrid graphs.

- [x] **Evaluate an optional reranker** — deterministic fusion remains canonical
  - Files: `docs/operations/solutions-evaluation.md`
  - Do: Compare no-reranker against approved candidates using segmented quality, latency, provider
    cost, and failure behavior. Adopt only a material predeclared gain.
  - Verify: the signed report either selects a versioned reranker with rollback criteria or records
    that deterministic fusion remains canonical.

  **Recorded as: no reranker.** The verify line offers two outcomes and this is the second one, reached on
  evidence rather than by deferral — see the "Reranker" section of `solutions-evaluation.md`.

  The measurement that decides it: retrieval currently returns 0–3 candidates per lane against the local
  catalog, and the composer's set cover consumes at most four. A reranker reorders a list shorter than the
  number of slots, so there is no ordering for it to improve — the gain is arithmetically zero, not merely
  unmeasured. Adopting one anyway would add a provider call per run to a cost model whose whole margin
  argument is that retrieval touches no provider.

  Revisit when a lane routinely returns more candidates than the cover can use *and* human-authored gold
  judgments exist to measure a reordering against. Both conditions, because a reranker tuned on synthetic
  judgments would be tuned on the generator's assumptions.

## Phase 6 — Credits

- [x] **Register Solutions rate cards with billing**
  - Files: `src/shared/lib/billing/rate-cards.ts`, `src/shared/lib/solutions/config.ts`,
    `src/shared/lib/solutions/cost-model.ts` (new),
    `docs/operations/solutions-cost-certification.md` (new)
  - Do: Register fixed immutable operations, maximum duration, reservation expiry, provider-usage
    mapping, and refund/release rules. Do not add Stripe products or credit tables.
  - Verify: cost fixtures prove the selected rate covers certified provider scenarios and historical
    runs resolve their original rate-card version after a future change.

  `solutions.generate.v1` and `solutions.regenerate.v1` were declared locally in `config.ts` and
  registered nowhere, so every `reserveCredits` call with them would have thrown `unknown_feature`:
  Solutions could not have billed anything. Registered as `solutions_generate` / `solutions_regenerate`
  and `config.ts` now derives from the registry, resolved per call rather than snapshotted at import —
  a snapshot would let two servers mid-deploy quote different prices for one operation.

  **Two corrections along the way, both worth keeping.** The first draft priced them at 12 and 5 units
  and metered provider usage against that ceiling. spec.md's premium contract fixes a *price*: "fixed
  10-credit settlement after a usable result", "fixed 3-credit settlement when the rerun invokes
  providers". Metering would have charged two users different amounts for the same product because one
  brief needed a clarification round, and would have made the confirmation prompt quote a maximum where
  the spec promises a price. The pre-existing `config.test.ts` already asserted 10 and 3 — the numbers
  were right in the repo before the rate cards were.

  Cost certification is **provisional, not signed**: the arithmetic uses declared token budgets and the
  documented-placeholder `MINIMAX_COST_PER_*` constants. It shows the worst generate run (2 interpret + 3
  explain, the maximum the code can emit) costs 0.837¢ against 45¢ charged, break-even at ~53× current
  provider prices. The doc records what real signing still needs.

- [x] **Add entitlement and reservation orchestration**
  - Files: `src/modules/solutions/server/billing.ts` (new),
    `src/modules/solutions/server/billing-state.ts` (new)
  - Do: Require tenant principal, paid entitlement, displayed maximum charge, explicit confirmation,
    and reservation before interpretation or other provider access; keep clarification inside the
    reservation; settle one usable result; release abandonment or unusable failure; reuse
    idempotency on retry; expose billing-owned balance/action DTOs.
  - Verify: tests cover Free, suspended, insufficient credits, owner/member actions, concurrent
    duplicate, timeout-before/after-provider, usable partial, unusable partial, and reconciliation.

  Ordering: flag → entitlement → confirmation → reserve → work → settle or release. The work callback is
  only ever invoked after the reservation exists, asserted by reading the reservation row *from inside*
  the callback rather than by inspecting the code.

  The caller reports two facts — `usable` and `providerInvoked` — and the boundary derives the charge.
  `usable` is not "the provider threw": a degraded provider that answers with only `unavailable` routes
  never raises, so a catch-based boundary would charge full price for nothing. There is deliberately no
  `extend`: a fixed price has nothing to extend to.

  Three terminal shapes, deliberately distinguishable for reconciliation: `settled` at the price,
  `settled` at zero (a regenerate that invoked no provider — the user got a fresh answer that cost
  nothing to serve), and `released`. A release only survives if the caller commits; a route that lets the
  error escape rolls the reservation away entirely. Both halves are asserted, after a first draft of
  those tests asserted `released` on a row the rollback had already removed.

  `billing-state.ts` hands the surface a *decision* (`available` plus a distinct reason) rather than a
  balance and a price to compare itself. Its tests assert the agreement from both sides: what the DTO
  offers, the reservation accepts; what it refuses, the reservation refuses. An enabled button whose
  charge the platform then refuses is worse than a disabled one — the user has already confirmed a price
  by then. The API routes that serve this DTO belong to Phase 8's end-to-end flow.

  Not yet wired to any provider call: Phase 7 registers interpretation and explanation, Phase 8 connects
  the flow. Nothing charges credits today.

## Phase 7 — AI boundaries

- [x] **Register brief interpretation**
  - Files: `src/shared/lib/ai/tasks.ts` (`solutions-brief-interpret`),
    `src/shared/lib/solutions/ai-contracts.ts` (new), `src/lib/solutions/ai/interpret.ts` (new)
  - Do: Add a strict bounded task with prompt/version metadata, one-question materiality policy,
    schema validation, injection isolation, and deterministic unknown handling.
  - Verify: ambiguous, multilingual, malicious, regulated, oversized, disabled-provider, timeout,
    and invalid-output fixtures preserve constraints and charge nothing before confirmation.

  **Every constraint carries a quote, and one that is not literally in the brief is discarded.** A
  `max_budget` nobody stated can make every route unavailable, and a widened one ("they said €5,000, so
  probably €8,000") produces a recommendation the real budget cannot buy. The check is a substring test
  against the user's own text, so it is not a judgement the model can talk its way past. The prompt-
  injection fixture makes the limit of that explicit: an instruction *inside the brief* can legitimately
  set a constraint, because the user typed it — what it cannot do is escape the constraint system.

  Unknown handling is deterministic in the literal sense: the model reports which fields it could not
  determine, and the `{status:'unknown'}` markers are constructed in code from that list. A field it
  simply omitted stays absent. A value it gave *and* listed unknown resolves to unknown.

  Restricted-sensitivity briefs never reach a provider at all. There is no version of "we only sent a
  summary" that is true, because the summary would be of the restricted text.

  "Charges nothing before confirmation" is asserted structurally: the module imports no billing, and a
  test checks the import lines. The first version of that test grepped the whole file and failed on the
  header comment, which *names* `withSolutionsCredits` to explain the ordering.

  **One real defect found by the fixtures.** Capability matching in the deterministic fallback used only
  each capability's key and label — the nouns — so "we need to **translate** 200 pages" matched nothing
  and the fallback returned no brief at all. `CAPABILITY_TERMS` now lists the inflections briefs actually
  use, and a test asserts every capability has terms. Relatedly, a fallback that matches nothing returns
  `brief: null` rather than substituting a placeholder key: a capability the catalog does not know would
  produce a permanent coverage gap caused by this function rather than by the catalog.

- [x] **Register grounded route explanation**
  - Files: `src/shared/lib/ai/tasks.ts` (`solutions-route-explain`), `src/lib/solutions/ai/explain.ts` (new)
  - Do: Supply only the composed graph and evidence snippets; require resolvable citations and
    prohibit new component, price, compatibility, or performance claims.
  - Verify: unsupported citations, source instructions, stale facts, prompt injection, and malformed
    outputs fail closed to deterministic route facts with correct credit handling.

  Four checks run *after* generation, because a reader cannot tell which sentence of an explanation was
  grounded and which was merely fluent: citations resolve to the route's own evidence ids, no currency
  amount or percentage or `Nx` multiple appears that is not in the composer's estimate text, no bracketed
  component id outside the route, and no sentence asserting two components work together — the
  compatibility graph decides that and was deliberately withheld from the call.

  Bare numbers are deliberately *not* checked. "Two components cover this" is ordinary writing, and a check
  that fired on it would send every explanation to the fallback — indistinguishable from having no check,
  since the model output would stop being used and the failure would become invisible.

  Failure returns the composer's own summary and fit explanation with a reason, and never retries:
  re-rolling until the check passes selects for explanations that pass the check, which is not the same as
  grounded. An `unavailable` route is never sent at all — rewriting a refusal risks softening it into
  something that reads like an option.

  **A cost correction came out of this.** `minimaxChat` retries once with a JSON-correction turn, so one
  logical call is up to two billed requests; the cost model counted logical calls and understated every
  scenario by exactly half. `PROVIDER_ATTEMPTS_PER_CALL` now carries the factor, the certification's
  worst-case generate figure is 1.674¢ (break-even ~27× rather than ~53×), and a test asserts the
  registered `maxOutputTokens` equals `SOLUTIONS_CALL_BUDGETS` — without that, the arithmetic described
  budgets nothing enforced.

  **Flagged, not resolved: EU AI Act classification.** Plan 43 has no classification task, and the
  interview module has one (`docs/compliance/interview-ai-act-classification.md`) because Annex III point 4
  covers recruitment and selection. Solutions' human lane recommends *named people* for work, and Annex III
  point 4 also reaches task allocation — so this is closer to that boundary than a tool-recommendation
  feature sounds, and the composer's own human-review requirements are the mitigation but not the
  determination. Needs a human legal read before the flags go on, alongside the source-register sign-off.

## Phase 8 — Product completion

- [x] **Connect the end-to-end generation flow**
  - Files: `src/modules/solutions/server/generate.ts` (new), `src/routes/api/solutions/*` (generate,
    billing-state, runs, runs.$runId, briefs, briefs.$briefId), `src/modules/solutions/components/*`
  - Do: Implement interpret, correct, clarify, confirm charge, generate, stream progress/status,
    cancel, compare, reorder, and stable retry without persisting chat.
  - Verify: browser tests prove no provider access before confirmation, exact visible charge,
    partial-source status, cancellation release, and accessible focus/announcement behavior.

  **The order changed, and that was the point.** The preview shell showed an interpretation *before* the
  charge was confirmed. Interpretation is provider access, and spec.md requires the reservation to exist
  first — so that step was either lying about what it did or spending money nobody authorized. The flow
  is now describe → confirm the exact charge → generate → result, and the confirmation echoes the
  server's own figure so a stale price is refused rather than billed.

  **Clarification is released, not held.** spec.md says to keep it "inside that reservation"; holding one
  across two HTTP requests means server state, timeouts and abandonment handling. This releases the hold
  and returns the question instead, so the user is charged nothing for the question and exactly once for
  the run that answers it — the same promise, and the unanswered interpretation call is a cost we absorb.
  The one-question ceiling bounds the obvious abuse.

  Cancellation is the client disconnecting: `request.signal` fires, the orchestration throws between
  stages, and the throw releases through the same path as any failure. No cancel endpoint to authorize
  and no run id to leak. Progress is SSE, because a five-call run behind a plain POST is a spinner that
  cannot tell slow from dead.

- [x] **Persist explicit briefs, runs, and feedback**
  - Files: `src/shared/lib/db/schema.ts`, `drizzle/0137_solution_briefs_runs_feedback.sql`,
    `src/shared/lib/repositories/solutions.ts` (new), `scripts/db/audit-schema.ts`,
    `scripts/db/verify-rls-local.mjs`, `scripts/db/prepare-rls-fixture.mjs`
  - Do: Add tenant-private saved briefs, immutable run/routes/components, and bounded feedback.
    Store trace/evidence/version/credit references but no transient chat or secret source payload.
  - Verify: tenant A/B RLS, explicit-save-only, retention/export/deletion, immutable run, and public
    DTO tests pass.

  The first tenant-private tables in this module, and the line is the one the rest of it draws: the
  catalog is a public fact about a public thing; what an organization asked for and what it was told is
  theirs. **Immutable means it cannot be changed, not that it cannot be erased** — `solution_runs` and
  `solution_run_routes` get SELECT/INSERT/DELETE and *no UPDATE grant*, verified as the real
  `builderhunt_app` role in `verify-rls-local.mjs` because the unit suite runs as superuser and would
  have shown the update succeeding.

  No transient chat is stored: the clarification question and answer are absent by design. `brief_id` is
  nullable so a run can be kept without keeping its brief, and every run carries its own
  `brief_snapshot`, so editing a saved brief cannot rewrite what a stored recommendation was based on.

  The public DTO omits three things deliberately — the organization id, the author, and everything
  billing owns. A charge duplicated here would be a second number that can disagree with the billing
  surface.

  One pre-existing invariant needed scoping rather than weakening: `solutions-catalog-schema.test.ts`
  asserted that *no* `solution_*` table has an `organization_id`. Four now legitimately do, so they are
  named, and a companion assertion requires all four to have RLS enabled and forced.

- [x] **Render complete evidence-backed routes**
  - Files: `src/modules/solutions/components/RouteCard.tsx` (new), `RunResult.tsx` (new),
    `SolutionsPage.tsx` (rewritten)
  - Do: Show fit, steps, roles, coverage, limitations, estimates, risks, review points, provenance,
    freshness, uncertainty, safe outbound links, unavailable lane reasons, and generic human roles.
  - Verify: visual/accessibility tests cover all route/evidence/freshness states and never imply
    BuilderHunt verified a merely claimed capability.

  Evidence level is rendered in words on every component, and the `claimed` case names the vendor as the
  source of the claim — almost everything in the catalog enters at `claimed` and nothing promotes it, so
  a tick or a badge would turn a vendor's marketing into our assessment. Explanation provenance is shown
  too: a reader is owed the difference between prose a model wrote and prose the composer wrote, and it
  is not recoverable from the text.

  Reorder is a view, never an edit — the stored run keeps its own lane order, and an unavailable lane
  sorts last rather than being hidden or sorted first on an absent cost.

  **The attribution release blocker is closed.** `remoteok_jobs` and `jobicy_jobs` grant access on the
  condition their notice is displayed. `listAttributionsForEvidence` derives it from the same source rows
  the run drew on and the payload carries it, so a surface cannot render the data and forget the
  obligation. A failure to load attributions logs at *error* level rather than being swallowed.

  This also closes plans/UI task 78 and removes the Wave 7 preview banner: the banner said "this is an
  example, nothing is charged", which is no longer true.

## Phase 9 — Certification and rollout

- [x] **Pass security, privacy, and adversarial certification** — engineering review only
  - Files: `docs/operations/solutions-security-review.md` (new),
    `tests/unit/security/solutions-adversarial.test.ts` (new)
  - Do: Test prompt injection, poisoned source content, SSRF, malicious links, stale evidence,
    identity collision, tenant crossover, privilege changes, credit races, and source deletion.
  - Verify: no critical/high finding remains and every incident class has a kill switch and runbook.

  Every named class has a stated defence, an executable test, and a runbook entry. **What has not happened
  is an independent review** — everything was written by whoever wrote the code — and the document says so
  rather than implying certification.

  The defence worth naming: constraints are grounded by substring against the user's own text, so a fully
  obedient model told "the budget is unlimited" still cannot put that constraint into the composer's input.
  The honest limit is asserted alongside it — text injected *into the brief* is the user's own text, and a
  constraint quoting it does survive, which is correct.

  The suite ends with a live cross-reference rather than a comment: it reads `verify-rls-local.mjs` and the
  billing test and fails if the RLS or credit-race coverage it defers to is deleted. A superuser connection
  cannot prove either, and a comment saying so would go stale in silence.

**Moved to [`plans/phase-5/02-legal-and-commercial-approvals`](../../phase-5/02-legal-and-commercial-approvals/tasks.md)
on 2026-08-05, deliberately not as a checkbox.** It cannot be closed by engineering, and this plan's own
header says `Implementation authorized: no` — so a `- [ ]` here read as pending engineering when it was
never active work.

The evaluator, the corpus and the cost model all exist and have produced a dated baseline
(`docs/operations/solutions-evaluation.md`, 2026-08-01). Four inputs are missing and none is code: real
provider pricing (the `MINIMAX_COST_PER_*` constants are documented placeholders, so the cost certification
is provisional by its own first line); human-authored gold judgments, without which `citableAsQualityGate`
stays false and no run may be quoted as a quality figure; warm/cold load tests and source-outage drills
against the release configuration; and provider variance, the same brief run repeatedly against a live
model.

Checking this box on the strength of a synthetic baseline is precisely the failure the authorship split
exists to prevent: the same model cannot both answer and grade.

- [x] **Roll out through independent flags** — plan written, nothing executed
  - Files: `docs/operations/solutions-rollout.md` (new)
  - Do: Enable staff-only, closed beta with operator grants, paid beta, then general availability.
    Define abort thresholds, on-call owners, rollback, source disablement, and credit correction
    escalation.
  - Verify: each stage observes a full monitoring window; rollback disables new operations while
    preserving saved data and historical settlements; ordinary builder search remains healthy.

  Five stages with named abort thresholds, written before the first switch is thrown so the thresholds are
  not negotiated during an incident. Every flag stays off; the four preconditions are all non-engineering
  (legal sign-off, AI Act read, real provider pricing, human gold-set records), so the stages cannot start
  yet and the document says which.

  The rollback property that makes it safe to use without deliberation: disabling paid generation preserves
  every saved brief, run, and settlement. It is not a data decision.
