-- Custom SQL migration file, put your code below! --

-- calendar-scheduling-interview-intelligence plan: `operational_schedules` and `job_runs` are
-- system-operational tables with no owning tenant (a job identity is stable and platform-owned,
-- not owned by any one organization), so they carry no `organization_id` and get no RLS — access
-- is controlled entirely by GRANT, the same reasoning as `status_checks` (0048),
-- `conversion_events` (0062), and the profile-removal tables (0064).
--
-- spec.md §Calendar projection contract: the calendar feed shows these as read-only
-- `job_projection`/`job_run` DTOs that "are not copied into `calendar_events` and cannot be
-- dragged or edited." The web-runtime role therefore gets SELECT and nothing else — a request
-- handler must never be able to create, reschedule, or rewrite the history of a platform job,
-- even by accident. `job_runs.error_code` is a redacted short code precisely because this role
-- can read it and project it to a user.
GRANT SELECT ON TABLE operational_schedules TO builderhunt_app;
GRANT SELECT ON TABLE job_runs TO builderhunt_app;

-- `builderhunt_worker` is the only role that executes jobs: it claims a due schedule (UPDATE
-- next_run_at), opens a run row, and closes it with counters/duration/error code. It does not get
-- DELETE — run history is append-only evidence, trimmed by a retention sweep under the platform
-- role rather than by the worker mid-run.
GRANT SELECT, UPDATE ON TABLE operational_schedules TO builderhunt_worker;
GRANT SELECT, INSERT, UPDATE ON TABLE job_runs TO builderhunt_worker;

-- `builderhunt_platform` (operator surface) registers/enables/disables schedules and trims aged
-- run history.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE operational_schedules TO builderhunt_platform;
GRANT SELECT, DELETE ON TABLE job_runs TO builderhunt_platform;
