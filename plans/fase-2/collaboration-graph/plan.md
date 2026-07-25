# Co-Shipping Collaboration Graph (plan)

> **Status**: `pending`
> **Depends on**: [`security-and-multitenancy`](../../security-and-multitenancy/spec.md) (global-public data classification for a cross-tenant identity graph); [`production-infrastructure`](../../production-infrastructure/spec.md) (cron authentication and monitoring for a new long-running worker). Enhanced by [`look-alike-sourcing`](../look-alike-sourcing/spec.md) and [`team-synergy`](../../team-synergy/spec.md) (neither is required).
> **Blocks**: nothing
> **Reality check**: Builds on `src/shared/lib/db/schema.ts` (`builderIdentities`, deterministic `sha256(source \0 sourceId)` id), `drizzle/0017_enrichment_rls_policies.sql`'s `is_builder_processing_restricted(text)`, `src/lib/discovery/worker.ts` (global-table worker + cursor pattern), `src/routes/api/admin/alerts/run-worker.ts` (cron auth). Requires a **new** GitHub fetch path — `src/lib/sources/github.ts` fetches only `/search/users` and `/search/repositories`.

## Phases (dependency order — shippable after each)

### Phase 1 — Edge + cursor schema, data classification, grants

Add `builderCollaborationEdges` and `collaborationGraphState` to `schema.ts` (spec §1), including the
`a_id < b_id` CHECK, the `(a, b, source)` unique index, and both single-endpoint strength indexes, plus
the one additive nullable `builder_identities.discovered_by` provenance column (spec §Cross-plan
touchpoint). `pnpm db:generate` for the tables, then a **separate** grants migration minted with
`drizzle-kit generate --custom` — not a hand-created `.sql`, because
`scripts/db/verify-migration-integrity.mjs` L12–15/27–30 requires a matching `_journal.json` entry, a
`NNNN_snapshot.json`, and a regenerated `migration-hashes.json` (`0045` shipped without a snapshot and
turned that test red). Grants mirror `drizzle/0025_public_tables_app_grants.sql`: no RLS (global
public, no owning tenant), `SELECT/INSERT/UPDATE/DELETE` for `builderhunt_app`, `SELECT` for
`builderhunt_worker`, `SELECT/DELETE` for `builderhunt_platform` (the restriction cascade runs as
`platformDb`). Add the five `COLLABORATION_*` env vars to `env.ts` + `.env.example`, all defaulting to
off/conservative. Update `docs/architecture/data-classification.md`. Verification order is
`db:migrate` → `test:rls:local` → `test:api-isolation:local`, never a permission assertion before the
migration. App behaviour unchanged (two dead tables, one unread column).

### Phase 2 — Pure strength and layout libraries

`src/lib/collaboration/strength.ts` (`sizeDamping`, `artifactWeight`, `computeRawWeight`,
`computeNormalizedStrength`, `mergeObservations`, `canonicalPair`, `edgeId`,
`COLLABORATION_HALF_LIFE_DAYS = 180`) and `src/lib/collaboration/layout.ts` (`layoutEgoGraph`), both
with sibling `*.test.ts`. Reuses the `0.5 ** (age / halfLife)` mechanic from
`src/shared/lib/abuse/risk.ts`. No I/O, no DB, no network — this is where the formula is proven
before anything writes a row.

### Phase 3 — GitHub public-metadata crawl adapter

`src/lib/collaboration/github-crawl.ts`: `listAnchorRepos(username, token)` (public events + owned
repos, deduped, non-fork, most-recent first), `listRepoContributors(fullName, token)`,
`isLikelyBotLogin()`, and a `RateLimitSnapshot` parsed from `x-ratelimit-remaining`/`-reset` on every
response. Injectable `fetch` so tests run against recorded fixtures with zero network. Nothing calls
it yet.

### Phase 4 — Worker, cursor, restriction cascade

`src/shared/lib/repositories/collaboration-graph.ts` (upsert edge, **insert-only** discovered identity,
node totals, renormalize, delete-for-identity — all `publicDb`) and `src/lib/collaboration/worker.ts`
(`runCollaborationWorker()`, spec §3). New `POST /api/admin/collaboration-graph/run-worker` cloning
`src/routes/api/admin/alerts/run-worker.ts` exactly (`tryCronPrincipal ?? requirePlatformAdminPrincipal`,
`auditPlatformAdminAction`). Extend `cascadeBuilderProcessingRestriction()` in
`src/lib/enrichment/worker.ts` with the edge purge. Add the crontab line to the operations doc.
Edges now accumulate; still no UI.

### Phase 5 — Read API + entitlement gate

`COLLABORATION_GRAPH_LIMITS` in `billing-shared.ts`, `listEgoGraph()` in the repository (single query,
`a_id = $ego OR b_id = $ego`, both-endpoint restriction filter, DTO allowlist),
`src/lib/collaboration/enumeration.ts` (per-seat daily distinct-subject cap, spec §Enumeration — the
control for the fact that identity ids are offline-derivable and therefore not capabilities), and
`GET /api/builders/$builderId/collaboration`. Free tier gets `{ locked: true, neighborCount }`.
Extend `scripts/db/verify-api-isolation-local.mjs` with the restricted-identity, free-tier,
ID-enumeration and identity-non-degradation cases.

### Phase 6 — Ego-graph UI (SVG + table equivalent + a11y)

`src/modules/builder-profile/components/CollaborationGraphCard.tsx`: hand-written SVG from
`layoutEgoGraph`, always-present `<table>` equivalent, "Graph / Table" toggle, min-strength/window/
source filters applied client-side, cap notice, locked state, hidden-on-503. Mounted in
`BuilderProfilePage.tsx` below `PersonaCard`. Reduced-motion, focus order, and non-colour strength
encoding are part of this phase, not a follow-up.

### Phase 7 — True co-authorship source + subject transparency + observability

GraphQL `github_commit` edges (`src/lib/collaboration/github-coauthors.ts`, `rateLimit { cost
remaining resetAt }` requested in every query and logged), `COLLABORATION_COAUTHOR_REPOS_PER_RUN`
budget inside the same worker run, `GET /api/me/builder/$builderId/collaboration` (verified-claimant
subject read), and the quota/coverage counters surfaced on the admin metrics page.

## Risks

| Risk                                                                        | Likelihood | Impact   | Mitigation                                                                                                                                            |
| --------------------------------------------------------------------------- | ---------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| New GitHub fetch path starves interactive federated search of quota         | Medium     | High     | Separate buckets (`/search/*` vs core REST); `COLLABORATION_RATE_LIMIT_RESERVE=500` hard stop; per-run cap of ~56 core requests (≈4.5% of hourly budget) |
| Privacy/legal objection to a relationship graph over named individuals       | Medium     | Critical | Public repo metadata only, no emails/messages, 4-place restriction cascade, subject read endpoint, `COLLABORATION_ENABLED=false` by default, UI states what an edge means |
| Missing `GRANT` makes every write silently fail (the `0025` failure mode)    | Medium     | High     | Grants migration is its own Phase-1 task; `pnpm test:api-isolation:local` asserts a worker write and an ego read as the real non-owner roles            |
| A Pro seat bulk-extracts the whole graph via offline-derivable identity ids  | High       | High     | Per-seat daily distinct-subject cap (200, Redis set, breadth-charged) on top of 60 req/min; `429 enumeration_cap` logged + on admin metrics; asserted in the isolation script |
| Crawler zeroes `followers_count`/`language` on known identities             | High if reusing `trackOrganizationBuilder`'s upsert | High | Discovered-identity write is `onConflictDoNothing` only; isolation check asserts an existing identity is byte-identical after a crawl                    |
| Grants-only migration breaks `test:migration-integrity` (no snapshot)       | High       | Medium   | Mint it with `drizzle-kit generate --custom` and regenerate `migration-hashes.json --write`; this is exactly how `0045` went red                        |
| Hub/bot accounts dominate every graph                                       | High       | Medium   | `sizeDamping` + Salton degree normalization + `isLikelyBotLogin()` + `COLLABORATION_MAX_PARTICIPANTS=50` repo skip, all unit-tested                     |
| `(A,B)` and `(B,A)` duplicate edges                                         | Certain    | Medium   | `canonicalPair()` in JS before insert, plus the `a_id < b_id` CHECK as a loud backstop                                                                  |
| Quadratic pair explosion on a 500-contributor repo                          | Medium     | High     | Repo skipped above 50 participants; anchor-only pairing available as a further clamp if pair counts still grow                                          |
| `strength` staleness after a partial run                                    | Certain    | Low      | `computedAt` per edge; touched-identity renormalization each run; full renormalization pass when the cursor wraps                                       |
| Ego query sequential-scans (`a_id = $ego OR b_id = $ego`)                    | Medium     | Medium   | Two single-endpoint `(id, strength)` indexes; `EXPLAIN` asserted in the Phase-5 verification with a seeded 100k-edge table                              |
| GraphQL point cost mis-estimated (Phase 7)                                   | Medium     | Low      | Every query requests `rateLimit { cost remaining resetAt }`; the run halts on the reserve threshold, so a wrong estimate throttles rather than breaks   |
| Graph view fails the `audit-accessibility` release gate                     | Medium     | Medium   | Table equivalent is always in the DOM (not a fallback), SVG `aria-hidden`, keyboard node order = strength order, no motion under `prefers-reduced-motion` |

## Rollback

- **Phases 1–4 are invisible to users.** Stop the cron / set `COLLABORATION_ENABLED=false`; the
  worker no-ops. Both new tables are purely additive with no inbound FKs, so
  `DROP TABLE builder_collaboration_edges, collaboration_graph_state` is a clean revert. On
  `builder_identities`, the only changes are the nullable `discovered_by` column (leave it — dropping a
  column is a contract step, and every non-crawler row is `NULL` anyway) and insert-only rows, which
  are identifiable by `discovered_by = 'collaboration_crawl'` and removable with a single
  `DELETE … WHERE discovered_by = 'collaboration_crawl'` once the edge table is gone. No existing
  identity row was ever updated, so nothing needs restoring.
- **Phase 5** — remove the route, or set `COLLABORATION_GRAPH_LIMITS` to `{ free: 0, pro: 0, team: 0 }`
  so every tier is locked while the data stays.
- **Phase 6** — the card is a leaf component; removing its one mount in `BuilderProfilePage.tsx`
  restores today's profile exactly. Nothing else imports it.
- **Phase 7** — delete only `source = 'github_commit'` rows and set
  `COLLABORATION_COAUTHOR_REPOS_PER_RUN=0`; `github_repo` edges are unaffected.
- **Privacy incident path** (the one rollback that must be fast):
  `DELETE FROM builder_collaboration_edges` + `COLLABORATION_ENABLED=false` removes the entire
  feature's data in one statement, because it is one global table with no tenant copies.
