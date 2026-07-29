# Solutions Intelligence

> **Status**: `pending`
> **Depends on**: [`security-and-multitenancy`](../01-security-and-multitenancy/spec.md),
> [`ai-expansion`](../21-ai-expansion/spec.md),
> [`stripe-billing-platform`](../30-stripe-billing-platform/spec.md), and
> [`stealth-scraping`](../42-stealth-scraping/spec.md)
> **Blocks**: nothing
> **Reality check**: BuilderHunt has multi-source builder search, partial public identity
> normalization, pgvector embeddings, AI task infrastructure, and a compliant enrichment
> foundation. It has no Solutions module, capability catalog, compatibility graph, solution
> composer, canonical cross-source human profile, or implemented credit ledger. Ordinary search
> still keeps most results ephemeral, and several semantic-search contracts are incomplete. This
> specification plans new work only.

## Source design

The approved source design is
[`docs/superpowers/specs/2026-07-23-solutions-intelligence-design.md`](../../../docs/superpowers/specs/2026-07-23-solutions-intelligence-design.md).
This specification, `plan.md`, and `tasks.md` are the delivery contract.

## Goal

Create a premium advisory module that converts a structured digital-work brief into up to three
evidence-backed Human, AI, and Hybrid solution routes. It must compare real professionals, generic
specialist roles, agents, models, MCP tools, and conventional software without executing or
procuring them.

## Product rules

- Use a separate `Solutions` dashboard route and navigation entry.
- Ask at most one material clarification question.
- Show the exact maximum charge before reservation and let the user correct the interpreted brief
  before settlement.
- Rank contextually and support `recommended`, `maximum_quality`, and `lower_cost_time`.
- Never recommend an invalid lane merely to fill three slots.
- Save only an explicitly confirmed structured brief, not the transient chat.
- Preserve evidence, uncertainty, freshness, and human-review requirements in every route.
- Keep hiring, payment, OAuth, installation, and execution out of scope.
- Exclude physical work and high-risk regulated services in v1.

## Premium contract

- Entitlement: `solutions-intelligence`, available to active `pro`, `pro_max`, and `team`
  organizations only.
- `solutions.generate.v1`: fixed 10-credit settlement after a usable result.
- `solutions.regenerate.v1`: fixed 3-credit settlement when the rerun invokes providers.
- Local view, filter, compare, reorder, and save operations cost zero.
- Free accounts receive no live provider-backed result.
- Consume only the billing platform's entitlement and reserve/settle/release/refund interfaces.
- Show the maximum charge before confirmation; reserve before interpretation or other provider
  access; keep clarification inside that reservation; release on abandonment or when no usable
  result is produced; use stable idempotency across retry.
- Public launch is blocked until the billing platform is certified and a provider-cost benchmark
  validates the rate card.

## Domain contracts

### Brief

`SolutionBrief` contains deliverable, capabilities, formats, scale, languages, budget, deadline,
quality, privacy/residency, integrations, supervision, autonomy ceiling, hard constraints, soft
preferences, and ranking mode. Unknown is distinct from absent.

### Catalog

Component kinds are `human_profile`, `human_role`, `agent`, `model`, `model_endpoint`, `mcp_server`,
`tool`, and `service`. Versioned component metadata and evidence are immutable observations;
canonical projections may change.

Capability claims are `claimed`, `observed`, `verified`, or `production_evidence`.

### Compatibility

Typed directed edges are versioned, evidenced, constrained, and expirable. Semantic similarity can
propose an edge for review but cannot activate it.

### Solution run

A run references the immutable structured brief, ranking policy, retrieval query, component
versions, evidence IDs, route graphs, estimates, model/prompt versions, source statuses, credit
reservation and settlement, and user-visible warnings. A route cannot be `recommended` unless every
mandatory requirement is covered or explicitly delegated to an identified human review step.

## Canonical human model

Evolve `builder_identities` into source-account records and connect them to a stable canonical human
profile through an evidence-bearing link. Reuse `builder_source_snapshots` as source observations
and progressively repoint organization tracking to canonical humans. Search ingestion may persist
approved public source accounts and snapshots before tracking, but it must not auto-merge on
username or erase conflicting facts.

The cutover must be additive and dual-read/dual-write until backfill, collision review, rollback,
and public DTO compatibility are proven.

## Retrieval and composition

Use filtered PostgreSQL full-text search plus pgvector and reciprocal-rank fusion. Normalize
candidate scores before fusion, enforce hard filters before composition, and keep source/page/filter
contracts intact. Add a reranker only if the gold set demonstrates a material segmented gain.

The deterministic composer covers capabilities, traverses only approved compatibility edges,
calculates estimates and evidence coverage, rejects violations, and diversifies valid routes. The
LLM interprets the brief and explains the resulting graph; it does not authorize, fetch arbitrary
URLs, establish identity, determine legal source access, or override constraints.

## Source acquisition

All lawful and technically appropriate channels are valid: official APIs, feeds, licensed
datasets, user submissions, public crawl/scrape, and external-link-only discovery. Every source
requires a registry entry and kill switch. Scraping is allowed only after terms, robots, privacy,
field, geography, retention, rate, and security review; no access-control bypass is permitted.

Extend the current enrichment registry, network protections, normalization, hashing, provenance,
and worker patterns instead of creating a second crawler.

## Dependencies and prerequisite repairs

Before solution ranking is trusted:

- complete the canonical tenant/RLS gates;
- implement and certify the billing credit platform;
- align embedding dimensions across runtime, schema, migration, and local infrastructure;
- fix semantic source/page/filter propagation and truthful pagination;
- replace global username deduplication with source-aware identity candidates;
- isolate connector failures so one source cannot fail the whole search;
- normalize lexical/vector score fusion;
- add person and non-person semantic entity contracts.

These are prerequisites or shared-foundation extensions, not authorization to rewrite unrelated
features.

## Acceptance

- The 60-brief gold set reaches the source design's quality and hard-constraint thresholds.
- Every recommendation is reproducible from component versions and evidence.
- A source failure degrades independently.
- Human identity collision and reversible-merge tests pass.
- Tenant A cannot access tenant B's brief, run, feedback, or credit state.
- No provider call starts without premium entitlement and reservation.
- Duplicate and failed operations never double-charge.
- Warm p95 is no more than 8 seconds under the certified catalog size.
- Disabling every new feature flag preserves existing builder search and saved solution data.
