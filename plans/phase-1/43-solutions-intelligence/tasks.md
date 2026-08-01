# Tasks: Solutions Intelligence

> **Status**: `in progress`
> **Implementation authorized**: yes — maintainer decision, 2026-08-01. Supersedes the earlier
> "no; checklist for a future implementation task" header.
> **Depends on**: [`spec.md`](./spec.md) and [`plan.md`](./plan.md)

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

- [ ] **Certify prerequisite plans**
  - Files: `plans/phase-1/01-security-and-multitenancy/tasks.md`, `plans/phase-1/21-ai-expansion/tasks.md`,
    `plans/phase-1/30-stripe-billing-platform/tasks.md`, `plans/phase-1/42-stealth-scraping/implementation_plan.md`
  - Do: Record the exact completed tenant/RLS, AI task, credit ledger, billing sandbox, source
    policy, worker, and network-security gates consumed by Solutions. Do not duplicate those
    foundations.
  - Verify: production-equivalent evidence shows tenant isolation, synchronous non-negative credit
    authorization, provider kill switches, and safe public fetching.

- [ ] **Create the synthetic gold set, its CRUD, and the baseline report**
  - Files: `tests/fixtures/solutions/gold-set.json` (new),
    `scripts/evaluate-solutions.ts` (new), `docs/operations/solutions-evaluation.md` (new),
    gold-set admin CRUD routes/UI (new)
  - Do: Seed 60 de-identified briefs and judgments for valid lanes, hard constraints, capability
    coverage, unacceptable components, and ranking. Every seeded record carries
    `authorship: 'synthetic'`. Ship the CRUD so humans can add, edit and replace briefs and
    judgments during MVP/beta, stamped `authorship: 'human'`. Measure lexical/vector retrieval,
    latency, and provider cost separately by domain and lane.
  - Verify: the evaluator is deterministic for fixed fixtures, reports confidence intervals and
    segmented metrics, fails on malformed or leaked personal data, and reports synthetic and human
    judgment scores as **separate** figures — a synthetic-only run must never print an unqualified
    quality number, because the generator and the grader share assumptions.

- [x] **Approve the initial source and domain register** — moved, not done
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

- [ ] **Evaluate an optional reranker**
  - Files: `scripts/evaluate-solutions.ts`, `docs/operations/solutions-evaluation.md`
  - Do: Compare no-reranker against approved candidates using segmented quality, latency, provider
    cost, and failure behavior. Adopt only a material predeclared gain.
  - Verify: the signed report either selects a versioned reranker with rollback criteria or records
    that deterministic fusion remains canonical.

## Phase 6 — Credits

- [ ] **Register Solutions rate cards with billing**
  - Files: billing platform rate-card registry, `src/shared/lib/solutions/config.ts`,
    `docs/operations/solutions-cost-certification.md` (new)
  - Do: Register fixed immutable operations, maximum duration, reservation expiry, provider-usage
    mapping, and refund/release rules. Do not add Stripe products or credit tables.
  - Verify: cost fixtures prove the selected rate covers certified provider scenarios and historical
    runs resolve their original rate-card version after a future change.

- [ ] **Add entitlement and reservation orchestration**
  - Files: `src/modules/solutions/server/*` (new), Solutions API routes
  - Do: Require tenant principal, paid entitlement, displayed maximum charge, explicit confirmation,
    and reservation before interpretation or other provider access; keep clarification inside the
    reservation; settle one usable result; release abandonment or unusable failure; reuse
    idempotency on retry; expose billing-owned balance/action DTOs.
  - Verify: tests cover Free, suspended, insufficient credits, owner/member actions, concurrent
    duplicate, timeout-before/after-provider, usable partial, unusable partial, and reconciliation.

## Phase 7 — AI boundaries

- [ ] **Register brief interpretation**
  - Files: `src/shared/lib/ai/tasks.ts`, `src/lib/solutions/ai/interpret.ts` (new)
  - Do: Add a strict bounded task with prompt/version metadata, one-question materiality policy,
    schema validation, injection isolation, and deterministic unknown handling.
  - Verify: ambiguous, multilingual, malicious, regulated, oversized, disabled-provider, timeout,
    and invalid-output fixtures preserve constraints and charge nothing before confirmation.

- [ ] **Register grounded route explanation**
  - Files: `src/shared/lib/ai/tasks.ts`, `src/lib/solutions/ai/explain.ts` (new)
  - Do: Supply only the composed graph and evidence snippets; require resolvable citations and
    prohibit new component, price, compatibility, or performance claims.
  - Verify: unsupported citations, source instructions, stale facts, prompt injection, and malformed
    outputs fail closed to deterministic route facts with correct credit handling.

## Phase 8 — Product completion

- [ ] **Connect the end-to-end generation flow**
  - Files: Solutions routes, server orchestration, `src/modules/solutions/*`
  - Do: Implement interpret, correct, clarify, confirm charge, generate, stream progress/status,
    cancel, compare, reorder, and stable retry without persisting chat.
  - Verify: browser tests prove no provider access before confirmation, exact visible charge,
    partial-source status, cancellation release, and accessible focus/announcement behavior.

- [ ] **Persist explicit briefs, runs, and feedback**
  - Files: `src/shared/lib/db/schema.ts`, the next generated Drizzle migration,
    `src/shared/lib/repositories/solutions.ts` (new)
  - Do: Add tenant-private saved briefs, immutable run/routes/components, and bounded feedback.
    Store trace/evidence/version/credit references but no transient chat or secret source payload.
  - Verify: tenant A/B RLS, explicit-save-only, retention/export/deletion, immutable run, and public
    DTO tests pass.

- [ ] **Render complete evidence-backed routes**
  - Files: `src/modules/solutions/components/*` (new)
  - Do: Show fit, steps, roles, coverage, limitations, estimates, risks, review points, provenance,
    freshness, uncertainty, safe outbound links, unavailable lane reasons, and generic human roles.
  - Verify: visual/accessibility tests cover all route/evidence/freshness states and never imply
    BuilderHunt verified a merely claimed capability.

## Phase 9 — Certification and rollout

- [ ] **Pass security, privacy, and adversarial certification**
  - Files: `docs/operations/solutions-security-review.md` (new), security test suites
  - Do: Test prompt injection, poisoned source content, SSRF, malicious links, stale evidence,
    identity collision, tenant crossover, privilege changes, credit races, and source deletion.
  - Verify: no critical/high finding remains and every incident class has a kill switch and runbook.

- [ ] **Pass quality, performance, and cost gates**
  - Files: `docs/operations/solutions-evaluation.md`,
    `docs/operations/solutions-cost-certification.md`
  - Do: Execute the 60-brief suite, warm/cold load tests, source-outage drills, provider variance,
    and billing reconciliation against the exact release configuration.
  - Verify: every acceptance threshold in `spec.md` passes with dated artifacts.

- [ ] **Roll out through independent flags**
  - Files: feature flag configuration, `docs/operations/solutions-rollout.md` (new)
  - Do: Enable staff-only, closed beta with operator grants, paid beta, then general availability.
    Define abort thresholds, on-call owners, rollback, source disablement, and credit correction
    escalation.
  - Verify: each stage observes a full monitoring window; rollback disables new operations while
    preserving saved data and historical settlements; ordinary builder search remains healthy.
