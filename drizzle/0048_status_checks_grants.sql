-- Custom SQL migration file, put your code below! --

-- status-and-trust plan, Phase 1 "Uptime history": `status_checks` is a system-operational
-- table with no owning subject (a periodic snapshot, not tenant/user data) — no RLS is
-- possible or needed here, same reasoning as `session_signals`/`abuse_signals` in
-- 0044_abuse_usage_integrity_rls_grants.sql. Access is controlled entirely by GRANT.
--
-- Unlike those two tables, `status_checks` needs PUBLIC read access: the unauthenticated
-- `/api/status` route computes 30-day uptime from it, and it's read via `builderhunt_app`
-- (the plain web-runtime role) — same public-read pattern already used for
-- `incidents`/`changelog`/`roadmap_items` (0002_database_roles.sql).
--
-- `builderhunt_worker` gets INSERT *and* DELETE, deliberately deviating from the
-- "never DELETE" convention documented for `abuse_signals` (which must retain an
-- append-only investigation trail). `status_checks` has no such requirement — pruning rows
-- older than 90 days is the designed, intended behavior of its own snapshot worker, not a
-- cross-user/cross-tenant delete of someone else's data.
GRANT SELECT ON TABLE status_checks TO builderhunt_app, builderhunt_readonly;
GRANT SELECT, INSERT, DELETE ON TABLE status_checks TO builderhunt_worker;
GRANT SELECT ON TABLE status_checks TO builderhunt_platform;