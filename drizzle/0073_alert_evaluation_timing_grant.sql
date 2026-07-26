-- Custom SQL migration file, put your code below! --

-- calendar-scheduling-interview-intelligence (Phase 4, "Persist honest alert evaluation timing"):
-- column-scoped UPDATE grants for the three timing columns added in 0072.
--
-- Column-scoped, deliberately, following 0010 and 0056. The worker can write only the timing
-- columns it owns; it still cannot touch `enabled`, `keywords`, `trigger_conditions`, `frequency`,
-- or `user_id`. That distinction is what stops a compromised worker from disabling every alert in
-- the system or rewriting what they match on, so `GRANT UPDATE ON TABLE alerts` would have been the
-- easy fix and the wrong one.
--
-- Discovered the way these always are: the new write failed with
-- `42501 permission denied for table alerts` against the real local database, while every test
-- passed because the disposable test DB runs as owner.
GRANT UPDATE (next_evaluation_at) ON TABLE alerts TO builderhunt_worker;
GRANT UPDATE (consecutive_failures) ON TABLE alerts TO builderhunt_worker;
GRANT UPDATE (last_evaluation_error_code) ON TABLE alerts TO builderhunt_worker;
