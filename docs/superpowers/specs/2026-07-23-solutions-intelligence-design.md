# Solutions Intelligence Design

> **Status**: approved for planning
> **Date**: 2026-07-23
> **Scope**: product and architecture design only; no implementation

## Summary

BuilderHunt will add a premium `Solutions` module that interprets a user's digital-work problem and
recommends up to three comparable ways to solve it:

1. a human specialist;
2. an AI system assembled from agents, models, and tools;
3. a hybrid workflow that assigns explicit responsibilities to humans and AI.

The module is advisory. It discovers, composes, compares, and explains options, but does not hire a
person, install a tool, connect an account, or execute a workflow. The user remains the decision
maker.

The system must not precompute every possible combination. It stores atomic capabilities,
constraints, compatibility relationships, and evidence, then composes solution graphs for each
brief. PostgreSQL full-text search and pgvector provide candidate retrieval; deterministic rules
enforce hard constraints; an LLM interprets the brief and explains only evidence-backed results.

## Product boundary

### In scope

- Digital work, initially emphasizing software and AI work plus translation, transcription,
  research, data, content, design, and automation.
- Real BuilderHunt technical professionals.
- External public professional profiles from approved sources.
- Generic specialist roles when no trustworthy profile is available.
- AI agents, model endpoints, MCP servers/tools, conventional SaaS tools, and compatible
  combinations.
- Public source ingestion through official APIs, feeds, licensed datasets, user submissions, and
  compliant crawling or scraping.
- Cost, time, quality, privacy, supervision, volume, and evidence comparisons.

### Out of scope for the first release

- Physical or location-dependent work.
- Medical, legal, financial, safety-critical, or other high-risk regulated advice or execution.
- Hiring, payment, procurement, installation, OAuth connection, or workflow execution.
- Autonomous action on external systems.
- Scraping behind authentication, CAPTCHA, technical access controls, or a source prohibition.
- Claims that cannot be tied to evidence and an observation date.

## User experience

`Solutions` is a separate dashboard module, not a new tab inside the existing builder search. It
shares identity, retrieval, AI, billing, security, and enrichment infrastructure with the rest of
BuilderHunt.

### Brief flow

1. The user describes the outcome in natural language.
2. The system shows a structured interpretation: deliverable, domain, inputs, scale, languages,
   budget, deadline, quality bar, privacy, risk, and acceptable supervision.
3. It asks at most one clarifying question when ambiguity would materially change the viable routes.
4. The user can correct the interpretation and choose a ranking preference:
   `recommended`, `maximum quality`, or `lower cost/time`.
5. Before any server-side AI or live-source call, the UI shows the exact maximum credit charge and
   obtains explicit confirmation.
6. The system returns up to one Human, AI, and Hybrid route when each is viable. An invalid lane is
   shown as unavailable with a concise reason; it is never padded with a weak recommendation.

The conversation is ephemeral. BuilderHunt stores a structured brief only after an explicit save
action and never stores the full chat automatically.

### Result contract

Every solution card contains:

- route type and concise outcome;
- why it fits the interpreted brief;
- ordered execution steps;
- components and the role assigned to each;
- requirement coverage and known limitations;
- estimated cost and elapsed-time ranges with assumptions;
- privacy, license, permission, and operational risks;
- required human review points;
- evidence, provenance, freshness, and uncertainty;
- links to inspect or contact the recommended components.

The default ranking is contextual rather than universally human-first or AI-first. Quality, budget,
time, privacy, volume, and supervision preferences determine the order. The UI makes those reasons
visible and lets the user choose another ranking lens.

## Commercial and credit contract

`Solutions` is a premium feature:

- `Free` users see a locked explanation and example output, but cannot run live interpretation,
  retrieval, enrichment, or generation.
- `Pro`, `Pro Max`, and `Team` require both the feature entitlement and sufficient organization
  credits.
- Credits are organization-owned and pooled according to the canonical billing plan.
- The feature depends on
  [`stripe-billing-platform`](../../../plans/implemented/phase-1/30-stripe-billing-platform/spec.md) and must not create a
  balance table, grant system, Stripe integration, or parallel ledger.

Initial versioned rate card:

| Operation                                                  |      Credits | Notes                                                                                        |
| ---------------------------------------------------------- | -----------: | -------------------------------------------------------------------------------------------- |
| `solutions.generate.v1`                                    |           10 | Full brief interpretation, retrieval, approved live enrichment, composition, and explanation |
| `solutions.regenerate.v1`                                  |            3 | A user-requested rerun that calls an AI or external provider again                           |
| View, compare, filter, reorder, or save an existing result |            0 | No provider-backed recomputation                                                             |
| Clarifying question inside an active generation            | 0 additional | Covered by the existing reservation; abandonment releases it                                 |

The server shows the exact maximum charge before confirmation, checks entitlement, and reserves
credits before any provider-backed operation. The user reviews and may correct the interpreted brief
while that reservation remains open; abandoning the run releases it. A usable result settles the
operation's fixed units. A provider or orchestration failure that produces no usable result releases
the complete reservation. Retries reuse the same idempotency key. A partial result may settle only
when it meets the minimum result contract and is clearly labeled; otherwise it releases.

The fixed product price protects predictability. Provider tokens, requests, latency, and estimated
currency cost are still recorded for internal reconciliation. Before public launch, a benchmark
must demonstrate that the rate card meets the billing plan's target unit economics; a changed price
requires a new immutable rate-card version.

## Architecture

### 1. Brief interpreter

The interpreter produces a strict `SolutionBrief` rather than an open-ended prompt:

- desired outcome and deliverable;
- domain and task capabilities;
- input and output formats;
- scale, languages, deadline, and budget;
- required quality and acceptable error;
- data sensitivity and residency;
- required integrations and environment;
- human-review and autonomy limits;
- explicit hard constraints and soft preferences.

Schema validation and deterministic normalization run after the LLM. Unsupported or ambiguous
fields remain unknown; the model cannot silently invent them.

### 2. Capability catalog

The catalog stores atomic components, not generated combinations:

- canonical humans and generic human roles;
- AI agents and agent services;
- foundation or specialist models and provider endpoints;
- MCP servers and tools;
- conventional software and service APIs.

Each component has structured capabilities, input/output modalities, languages, deployment model,
commercial terms, privacy and residency properties, authentication needs, limits, lifecycle state,
and timestamped evidence.

Claims use four evidence levels:

1. `claimed`: stated by the publisher or profile owner;
2. `observed`: found in public artifacts or machine-readable metadata;
3. `verified`: tested or independently validated by BuilderHunt;
4. `production_evidence`: supported by bounded, privacy-safe outcome evidence.

### 3. Compatibility graph

Versioned typed edges describe relationships such as:

- `can_perform`;
- `requires`;
- `accepts_output_from`;
- `integrates_with`;
- `hosted_by`;
- `reviewed_by`;
- `incompatible_with`;
- `substitutes_for`.

An edge stores direction, constraints, evidence, confidence, discovery method, validity interval,
and last verification time. Compatibility is never inferred solely because two descriptions are
semantically similar.

### 4. Retrieval and composition

Candidate generation combines:

- PostgreSQL full-text retrieval for exact capability, language, format, and integration terms;
- pgvector retrieval for semantic intent;
- structured filtering for hard constraints;
- reciprocal-rank fusion for lexical and vector candidates;
- an optional reranker only after offline evaluation proves material improvement.

The composer constructs bounded solution graphs from compatible candidates:

1. cover mandatory capabilities;
2. reject privacy, permission, format, budget, and compatibility violations;
3. calculate evidence completeness, freshness, estimated cost/time, and supervision burden;
4. diversify valid candidates into Human, AI, and Hybrid lanes;
5. ask the LLM to explain the surviving graph using only cited facts.

The LLM does not decide compatibility, entitlement, credit authorization, source legality, or tenant
access.

### 5. Freshness and live search

The durable catalog is the primary retrieval source. Live web or provider search is an enrichment
and freshness mechanism, not the system of record.

Every source is registered with:

- access method: API, feed, licensed dataset, user submission, crawl, or external-link-only;
- owner, terms and robots review, legal basis, geography, and allowed fields;
- authentication and rate limits;
- retention, refresh cadence, deletion path, and kill switch;
- data quality and current operational status.

Scraping is a valid ingestion option only for public pages that pass contractual, robots, privacy,
and security review. The fetcher must use an honest user agent, SSRF protection, bounded responses,
rate limits, provenance, content hashing, and source-specific stop controls. It never bypasses
authentication, CAPTCHA, or access restrictions.

## Canonical human identity

Search ingestion should strengthen the existing human graph instead of remaining ephemeral, but
source records must not be copied directly into one flattened person row.

### Target model

- `HumanProfile`: canonical public person with stable BuilderHunt identity and consolidated
  attributes.
- `HumanSourceAccount`: source-specific account, evolving the current `builder_identities`.
- `HumanProfileSourceLink`: explicit link between a person and a source account, including method,
  confidence, supporting evidence, reviewer, and dates.
- `HumanSourceSnapshot`: versioned source observation, evolving `builder_source_snapshots`.
- `organization_builders`: organization-private tracking that points progressively to the canonical
  person.

Approved search ingestion can create or update public source accounts and snapshots before an
organization tracks a person. Consolidation into `HumanProfile` preserves field-level provenance
and refresh dates. Embeddings are generated from the consolidated searchable projection but retain
references to source evidence.

Identity linking confidence, from strongest to weakest:

1. verified profile claim;
2. explicit published cross-links;
3. deterministic corroborating identifiers;
4. probabilistic match shown for review.

Username equality alone never auto-merges people. Conflicting source facts remain separate until
resolved, and all merges must be reversible and auditable.

## Storage and tenancy

The catalog of approved public facts is global-public through narrow public repositories.
Organization briefs, saved solution runs, credit records, notes, and user decisions are
tenant-private and require the canonical tenant transaction context and RLS. Worker cursors,
ingestion runs, evaluation aggregates, and redacted provider telemetry are system-operational.

Suggested new domain entities:

- `solution_components`;
- `solution_component_versions`;
- `solution_capabilities`;
- `solution_component_capabilities`;
- `solution_compatibility_edges`;
- `solution_evidence`;
- `solution_source_registry`;
- `solution_briefs`;
- `solution_runs`;
- `solution_run_routes`;
- `solution_run_components`;
- `solution_feedback`.

The exact physical schema must be added through the then-current migration journal. Public catalog
tables cannot contain tenant notes or authorization state.

## Failure behavior

- One source failing returns other valid candidates and a source-status warning.
- A stale component remains visible only within its source policy and is explicitly marked stale.
- An incomplete route is not recommended as complete.
- If the LLM is disabled or invalid, deterministic retrieval can return candidates but must not
  manufacture a narrative.
- If no real human profile is trustworthy, the Human lane may recommend a generic specialist role.
- If credits are insufficient, no provider request starts and the UI links to the platform-owned
  billing action available to the user's organization role.
- If credit settlement is uncertain, the run is not retried with a new key; reconciliation resolves
  the original operation.

## Security and trust controls

- Treat source text and tool descriptions as untrusted data, never as instructions.
- Strip active content and isolate fetched content from system prompts.
- Validate all LLM input/output schemas and all evidence references.
- Enforce allowlisted outbound network policy and SSRF protections.
- Minimize public personal data, honor source deletion/restriction, and preserve provenance.
- Never expose tenant briefs, saved runs, credit state, or feedback across organizations.
- Record model, prompt, retrieval set, component versions, evidence IDs, source dates, rate-card
  version, reservation ID, and final settlement for reproducibility.

## Evaluation and acceptance

Build an initial human-reviewed gold set of 60 briefs:

- 20 software and AI;
- 20 translation, transcription, and content;
- 20 research, data, and automation.

Release gates:

- at least 85% of briefs have one viable route in the top three;
- at least 95% hard-constraint compliance;
- 100% of recommended components include source and observation date;
- 100% of compatibility assertions have evidence or explicit uncertainty;
- zero tenant-data or credit-state leaks;
- warm p95 response time no greater than 8 seconds;
- a single source outage still returns valid partial results;
- zero provider-backed operations begin without entitlement and a successful credit reservation;
- duplicate requests settle at most once;
- prompt-injection, poisoned catalog, stale evidence, identity collision, and adversarial brief tests
  pass.

Offline ranking metrics must be segmented by route type and domain so a strong AI catalog cannot
hide weak human or hybrid recall. Production feedback records user choice and reason without
claiming that a click proves solution quality.

## Rollout

1. Internal catalog and offline evaluation only.
2. Staff-only deterministic retrieval and composition.
3. Closed beta with operator-granted credits and approved sources.
4. Paid beta after billing sandbox certification, source review, and rate-card cost benchmark.
5. General availability only after quality, tenancy, reconciliation, and incident-response gates
   pass.

Feature flags independently control catalog ingestion, public scraping, live enrichment, LLM
interpretation, external human profiles, and paid generation. Disabling `Solutions` never removes
saved briefs or results and never affects ordinary builder search.

## Research basis

The design follows machine-readable capability and discovery patterns from the Model Context
Protocol registry and Agent2Agent Agent Cards; model metadata practices from Hugging Face and
OpenRouter; hybrid retrieval guidance from pgvector and current retrieval platforms; and
provenance, injection, and risk controls from NIST, OWASP, and public-data guidance. The executable
plan must maintain a dated source register rather than treating this research snapshot as permanent
provider truth.

Primary references reviewed:

- [Official MCP Registry](https://modelcontextprotocol.io/registry/about)
- [Agent2Agent protocol specification](https://a2a-protocol.org/latest/specification/)
- [Hugging Face Model Cards](https://huggingface.co/docs/hub/model-cards)
- [OpenRouter Models API](https://openrouter.ai/docs/api/api-reference/models/get-models)
- [pgvector hybrid search guidance](https://github.com/pgvector/pgvector/blob/master/README.md#hybrid-search)
- [Anthropic: Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents)
- [Anthropic: Trustworthy Agents in Practice](https://www.anthropic.com/research/trustworthy-agents)
- [NIST AI Risk Management Framework](https://www.nist.gov/itl/ai-risk-management-framework)
- [OWASP Top 10 for LLM Applications](https://genai.owasp.org/llm-top-10/)
- [EDPB public consultation: Guidelines 03/2026 on web scraping in the context of generative
  AI](https://www.edpb.europa.eu/public-consultations_ga)
