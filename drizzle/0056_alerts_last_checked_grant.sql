-- Custom SQL migration file, put your code below! --

-- smart-alerts plan (Phase 1): the worker's `builderhunt_worker` role has a
-- column-scoped UPDATE grant on `alerts` (0010_worker_alert_policies.sql,
-- `last_triggered_at` only) — `last_checked_at` (added in 0055) needs its own
-- grant, or every `markWorkerAlertChecked` write fails with "permission
-- denied for table alerts" even though the row-level RLS policy allows it.
GRANT UPDATE (last_checked_at) ON TABLE alerts TO builderhunt_worker;
