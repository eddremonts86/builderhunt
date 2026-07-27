-- Custom SQL migration file, put your code below! --

-- A dedicated cluster role for the public capability flow.
--
-- Found by running the candidate portal against a real database: the booking path failed with
-- `permission denied for table candidate_submissions`, because the public routes were running as
-- `builderhunt_worker` and 0069 grants that role SELECT/DELETE there and SELECT only on
-- `calendar_events`.
--
-- The tempting fix -- widen `builderhunt_worker` -- is wrong twice over. It would undo a deliberate
-- decision in 0069 that background jobs may read events but never create or modify them, and it
-- would grant the recurrence materializer and the reminder sweep write access to candidate
-- submissions and consent, which they have no business touching. spec.md asks for the opposite:
-- "Capability writes go through a narrowly privileged server command, never anonymous SQL grants."
--
-- So this role exists to be exactly the accountless candidate's reach, and nothing more:
--
--   * It can write only what a candidate does: their own submission, their links, their consent
--     decisions, the interview event and its participants and reminders.
--   * It can read only what the portal shows or the slot generator needs: the invitation, the
--     availability policy, and busy ranges.
--   * It has NO DELETE anywhere. A candidate cancels by moving an event to `cancelled` and withdraws
--     consent by stamping a timestamp; nothing in this flow removes a row. Retention deletion is the
--     platform's job, on its own schedule, under its own role.
--   * It cannot see `organizations`, `auth_users`, `builders`, billing, or anything else. An SQL
--     injection in a public scheduling handler reaches this role's grants and stops.
--
-- Like every other role here it is created without a password (0002): deployment automation
-- provisions and rotates the LOGIN credential out of band. Until `DATABASE_CAPABILITY_URL` is set,
-- the application falls back to the worker URL and the public flow fails closed with a permission
-- error rather than silently running with wider privileges.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'builderhunt_capability') THEN
    CREATE ROLE builderhunt_capability LOGIN;
  END IF;
END
$$;
--> statement-breakpoint

ALTER ROLE builderhunt_capability LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO builderhunt_capability;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Policies. Org-scoped only, like the worker policies in 0069: a capability
-- has no session user, and `withCapabilityContext` pins exactly one tenant per
-- transaction before any of this is reachable.
-- ---------------------------------------------------------------------------

-- The invitation itself: read it, and move its status (opened, booked, declined).
CREATE POLICY scheduling_invitations_capability_select ON scheduling_invitations
  FOR SELECT TO builderhunt_capability
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY scheduling_invitations_capability_update ON scheduling_invitations
  FOR UPDATE TO builderhunt_capability
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''))
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));

-- The candidate's own details.
CREATE POLICY candidate_submissions_capability_all ON candidate_submissions
  FOR ALL TO builderhunt_capability
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''))
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY candidate_links_capability_all ON candidate_links
  FOR ALL TO builderhunt_capability
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''))
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));

-- Consent. The grant below is what makes this append-only for this role too: INSERT plus UPDATE on
-- `withdrawn_at` alone, exactly as 0075 does for the app and worker roles.
CREATE POLICY privacy_consents_capability_select ON privacy_consents
  FOR SELECT TO builderhunt_capability
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY privacy_consents_capability_insert ON privacy_consents
  FOR INSERT TO builderhunt_capability
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY privacy_consents_capability_update ON privacy_consents
  FOR UPDATE TO builderhunt_capability
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''))
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));

-- The interview event and everything hanging off it.
CREATE POLICY calendar_events_capability_select ON calendar_events
  FOR SELECT TO builderhunt_capability
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY calendar_events_capability_insert ON calendar_events
  FOR INSERT TO builderhunt_capability
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY calendar_events_capability_update ON calendar_events
  FOR UPDATE TO builderhunt_capability
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''))
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY event_participants_capability_select ON event_participants
  FOR SELECT TO builderhunt_capability
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY event_participants_capability_insert ON event_participants
  FOR INSERT TO builderhunt_capability
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY calendar_event_reminders_capability_select ON calendar_event_reminders
  FOR SELECT TO builderhunt_capability
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY calendar_event_reminders_capability_insert ON calendar_event_reminders
  FOR INSERT TO builderhunt_capability
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY calendar_event_reminders_capability_update ON calendar_event_reminders
  FOR UPDATE TO builderhunt_capability
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''))
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));

-- Read-only: the organizer's calendar and availability, which the slot generator needs and the
-- candidate never sees directly.
CREATE POLICY user_calendars_capability_select ON user_calendars
  FOR SELECT TO builderhunt_capability
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY availability_policies_capability_select ON availability_policies
  FOR SELECT TO builderhunt_capability
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY availability_rules_capability_select ON availability_rules
  FOR SELECT TO builderhunt_capability
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY availability_overrides_capability_select ON availability_overrides
  FOR SELECT TO builderhunt_capability
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY calendar_event_occurrences_capability_select ON calendar_event_occurrences
  FOR SELECT TO builderhunt_capability
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Grants. No DELETE on anything, and consent UPDATE is column-scoped.
-- ---------------------------------------------------------------------------

GRANT SELECT, UPDATE ON TABLE scheduling_invitations TO builderhunt_capability;
GRANT SELECT, INSERT, UPDATE ON TABLE candidate_submissions TO builderhunt_capability;
GRANT SELECT, INSERT, UPDATE ON TABLE candidate_links TO builderhunt_capability;
GRANT SELECT, INSERT ON TABLE privacy_consents TO builderhunt_capability;
GRANT UPDATE (withdrawn_at) ON TABLE privacy_consents TO builderhunt_capability;
GRANT SELECT, INSERT, UPDATE ON TABLE calendar_events TO builderhunt_capability;
GRANT SELECT, INSERT ON TABLE event_participants TO builderhunt_capability;
GRANT SELECT, INSERT, UPDATE ON TABLE calendar_event_reminders TO builderhunt_capability;
GRANT SELECT ON TABLE user_calendars TO builderhunt_capability;
GRANT SELECT ON TABLE availability_policies TO builderhunt_capability;
GRANT SELECT ON TABLE availability_rules TO builderhunt_capability;
GRANT SELECT ON TABLE availability_overrides TO builderhunt_capability;
GRANT SELECT ON TABLE calendar_event_occurrences TO builderhunt_capability;
--> statement-breakpoint

-- The tenant resolver moves to this role, and leaves the worker.
--
-- The worker never needed it: background sweeps iterate organizations they already know. Leaving the
-- grant behind would mean two roles could resolve a capability hash to a tenant, which is one more
-- than the number that should be able to.
GRANT EXECUTE ON FUNCTION scheduling_resolve_capability(text) TO builderhunt_capability;
REVOKE EXECUTE ON FUNCTION scheduling_resolve_capability(text) FROM builderhunt_worker;
