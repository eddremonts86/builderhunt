-- Phase 3 "Device/ASN sign-up velocity + linked-account clustering"
-- (plans/abuse-and-usage-integrity/tasks.md) needs a background read model that clusters
-- accounts sharing a device hash, which requires builderhunt_worker to see device hashes ACROSS
-- users. 0044 only granted user_devices to builderhunt_app, scoped to its own `app.user_id` (a
-- synchronous, per-user request-path write) — builderhunt_worker had no grant on this table at all.
--
-- This is a deliberate, narrow broadening: SELECT only, never INSERT/UPDATE/DELETE (those verbs
-- stay exclusively with builderhunt_app, unchanged from 0044). Unlike account_risk's worker policy
-- (which stays user_id-scoped because a risk-scoring sweep processes one user's row per
-- transaction — security-policy.md's per-subject-batch discipline), clustering is inherently a
-- cross-user read: there is no single user_id to scope it by, so the policy's USING clause is
-- unconditionally true for this role/verb pair only.

CREATE POLICY user_devices_worker_select ON user_devices
  FOR SELECT TO builderhunt_worker
  USING (true);
--> statement-breakpoint

GRANT SELECT ON TABLE user_devices TO builderhunt_worker;
