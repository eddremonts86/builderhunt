-- Custom SQL migration file, put your code below! --

-- audit-trust plan: profile_removal_requests / profile_suppressions are system-operational,
-- no-owning-subject tables (a removal request/suppression is keyed by external
-- source/sourceId, not a BuilderHunt tenant or user) — same "no RLS possible or needed, access
-- controlled entirely by GRANT" reasoning as conversion_events (0062) and status_checks (0048).
--
-- `builderhunt_app` (DATABASE_URL, the plain web-runtime role) handles the full public request
-- lifecycle: INSERT a new request, SELECT to check an existing pending request (rate-limit /
-- idempotency), UPDATE to flip status pending -> verified/rejected, INSERT the resulting
-- suppression on verify. It does NOT get DELETE — expiring stale pending requests is a
-- scheduled worker concern, not something a live request handler does.
GRANT INSERT, SELECT, UPDATE ON TABLE profile_removal_requests TO builderhunt_app;
GRANT INSERT, SELECT ON TABLE profile_suppressions TO builderhunt_app;

-- `builderhunt_worker` runs the expiry sweep (mark pending requests past expires_at as
-- 'expired') and needs suppression visibility to evict stale search-cache entries.
GRANT SELECT, UPDATE ON TABLE profile_removal_requests TO builderhunt_worker;
GRANT SELECT ON TABLE profile_suppressions TO builderhunt_worker;

-- `builderhunt_platform` (admin surface) gets read access for an operator to review pending/
-- rejected requests and audited revocation of a suppression (revoked_at is set, never a hard
-- delete of the row, per spec.md's "deleting it is an audited admin/legal action").
GRANT SELECT ON TABLE profile_removal_requests TO builderhunt_platform;
GRANT SELECT, UPDATE ON TABLE profile_suppressions TO builderhunt_platform;
