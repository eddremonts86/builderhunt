-- Custom SQL migration file, put your code below! --

-- audit-conversion plan: `conversion_events` is a system-operational, no-owning-subject
-- table (an anonymous funnel event, not tenant/user data) — same "no RLS possible or
-- needed, access controlled entirely by GRANT" reasoning as `status_checks`
-- (0048_status_checks_grants.sql) and `abuse_signals`/`session_signals`
-- (0044_abuse_usage_integrity_rls_grants.sql).
--
-- `builderhunt_app` (the plain web-runtime role `DATABASE_URL` connects as) gets
-- INSERT-only: the ingestion route at api/analytics/conversion.ts writes events from
-- unauthenticated landing/explore/signup pages and never needs to read them back —
-- aggregate reporting is admin-only, via `builderhunt_platform` below.
--
-- `builderhunt_worker` gets SELECT + DELETE for the 30-day retention cron
-- (conversion-retention.ts) — same append-only-except-scheduled-pruning pattern as
-- `status_checks`, not `abuse_signals`' permanent-retention rule (raw funnel events have
-- no investigation-trail requirement once aggregated).
GRANT INSERT ON TABLE conversion_events TO builderhunt_app;
GRANT SELECT, DELETE ON TABLE conversion_events TO builderhunt_worker;
GRANT SELECT ON TABLE conversion_events TO builderhunt_platform;
