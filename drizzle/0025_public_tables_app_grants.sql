-- `builder_embeddings` (0013_polite_night_thrasher.sql, plan: semantic-search)
-- and `discovery_state` (plan: proactive-discovery) are global, non-tenant
-- tables with no organization_id — correctly no RLS, same pattern as
-- `builder_identities` (see drizzle/0011_builder_claim_policies.sql). But
-- unlike `builder_identities`, neither ever received a grant for
-- `builderhunt_app` in any migration, even though every function that
-- touches them (src/shared/lib/repositories/public-builder-embeddings.ts,
-- src/shared/lib/repositories/discovery-state.ts, src/lib/discovery/worker.ts)
-- goes through `publicDb`, which is `env.DATABASE_URL` — the app role in
-- production. The semantic-search write-through indexing pipeline (called
-- from every search and track-builder request) and the entire
-- proactive-discovery worker have been completely broken against the real
-- least-privilege runtime role since these features shipped — every write
-- silently fails and is swallowed by a try/catch. Found the same way as
-- drizzle/0024_sourcing_sprints_grants.sql: a systematic diff of every
-- schema.ts table against every GRANT statement across all migrations,
-- cross-referenced against which DB client each table's call sites actually
-- use, while extending the security-and-multitenancy route-isolation task.
GRANT SELECT, INSERT, UPDATE ON TABLE builder_embeddings TO builderhunt_app;
GRANT SELECT, INSERT, UPDATE ON TABLE discovery_state TO builderhunt_app;
