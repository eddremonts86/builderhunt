-- Custom SQL migration file, put your code below! --

-- devpost-integration plan: `devpost_profiles` and `devpost_ingestion_state`
-- are global, non-tenant tables with no organization_id — correctly no RLS,
-- same pattern as `builder_embeddings`/`discovery_state`
-- (drizzle/0025_public_tables_app_grants.sql). Both are written via
-- `publicDb` (env.DATABASE_URL — the `builderhunt_app` role in production),
-- so the grant has to exist here or every worker write silently fails
-- (swallowed by the per-item try/catch), same lesson as 0025's own finding.
GRANT SELECT, INSERT, UPDATE ON TABLE devpost_profiles TO builderhunt_app;
GRANT SELECT, INSERT, UPDATE ON TABLE devpost_ingestion_state TO builderhunt_app;
