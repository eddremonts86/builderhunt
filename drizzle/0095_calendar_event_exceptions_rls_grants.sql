-- RLS and grants for `calendar_event_exceptions` (added in 0094).
--
-- The policy shape copies `calendar_event_occurrences` from 0069 exactly, because the two tables
-- answer to the same authority: an exception is a statement about one of the owner's events, and it
-- is visible to whoever may see the occurrence it suppresses. Diverging here would mean a colleague
-- could see a gap in a series with no way to learn it was deliberate.
--
-- ## Owner writes, granted participant reads
--
-- Removing one occurrence of someone else's series is an edit, and `calendar:mutate` is the owner's
-- alone. A granted participant needs the SELECT so the calendar they are shown matches the calendar
-- the owner sees — without it, a participant's client would re-expand the rule and paint a meeting
-- that no longer exists.
--
-- ## The worker needs full access, and that is not a shortcut
--
-- `runRecurrenceWorker` reads these rows to build `exceptionInstants` while running under
-- `builderhunt_worker`, outside any user's tenant context. It never writes them — only the service
-- does, on an owner's request — but the read is what makes the exception durable across
-- rematerialization, so a missing grant here silently restores every removed occurrence.

ALTER TABLE calendar_event_exceptions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE calendar_event_exceptions FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY calendar_event_exceptions_app_owner_all ON calendar_event_exceptions
  FOR ALL TO builderhunt_app
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1 FROM calendar_events e
      WHERE e.organization_id = calendar_event_exceptions.organization_id
        AND e.id = calendar_event_exceptions.event_id
        AND e.owner_user_id = nullif(current_setting('app.user_id', true), '')
    )
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1 FROM calendar_events e
      WHERE e.organization_id = calendar_event_exceptions.organization_id
        AND e.id = calendar_event_exceptions.event_id
        AND e.owner_user_id = nullif(current_setting('app.user_id', true), '')
    )
  );--> statement-breakpoint

CREATE POLICY calendar_event_exceptions_app_participant_select ON calendar_event_exceptions
  FOR SELECT TO builderhunt_app
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1 FROM event_participants p
      WHERE p.organization_id = calendar_event_exceptions.organization_id
        AND p.event_id = calendar_event_exceptions.event_id
        AND p.user_id = nullif(current_setting('app.user_id', true), '')
        AND p.access_granted = true
    )
  );--> statement-breakpoint

CREATE POLICY calendar_event_exceptions_worker_all ON calendar_event_exceptions
  FOR ALL TO builderhunt_worker USING (true) WITH CHECK (true);--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE calendar_event_exceptions TO builderhunt_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE calendar_event_exceptions TO builderhunt_worker;
