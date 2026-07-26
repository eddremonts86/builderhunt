-- Custom SQL migration file, put your code below! --

-- RLS and runtime-role grants for the 11 calendar/scheduling tables added in 0065
-- (plans/phase-1/calendar-scheduling-interview-intelligence/tasks.md Phase 2, "Add strict
-- private-user RLS policies"). Separate migration from 0065's CREATE TABLEs, matching this
-- codebase's established split (0027/0028, 0043/0044).
--
-- These tables are STRICTER than the ordinary org-scoped pattern used by billing and sprints.
-- spec.md §Authorization: "Calendar records are owned by one user inside one organization",
-- "organization admins receive no implicit [candidate-data] access", and participants receive
-- "read-only event/interview access". So the policies compose two conditions, not one:
--
--   organization_id = nullif(current_setting('app.organization_id', true), '')
--   AND (owner_user_id = nullif(current_setting('app.user_id', true), '') OR <participant read>)
--
-- The org filter alone would let any member of the organization — including an admin who is not
-- on the event — read another user's private calendar, which this plan explicitly forbids. Note
-- there is deliberately NO `app.organization_role = 'admin'` escape hatch anywhere below: an
-- admin sees a calendar row only by being its owner or an access-granted participant, exactly
-- like everyone else. Missing or spoofed context compares unequal to every row, so the default
-- is deny (same reasoning as 0008_tenant_rls.sql).
--
-- The public candidate capability never receives a database role at all: the public scheduling
-- routes run under `builderhunt_app` with the invitation resolved server-side from its hashed
-- capability, so the candidate's reach is bounded by the route's own predicate, not by RLS.

-- ---------------------------------------------------------------------------
-- 1. Enable and force RLS on every new tenant table
-- ---------------------------------------------------------------------------

ALTER TABLE user_calendars ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_calendars FORCE ROW LEVEL SECURITY;
ALTER TABLE calendar_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_events FORCE ROW LEVEL SECURITY;
ALTER TABLE calendar_event_occurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_event_occurrences FORCE ROW LEVEL SECURITY;
ALTER TABLE event_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_participants FORCE ROW LEVEL SECURITY;
ALTER TABLE calendar_event_reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_event_reminders FORCE ROW LEVEL SECURITY;
ALTER TABLE calendar_notification_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_notification_deliveries FORCE ROW LEVEL SECURITY;
ALTER TABLE availability_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE availability_rules FORCE ROW LEVEL SECURITY;
ALTER TABLE availability_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE availability_overrides FORCE ROW LEVEL SECURITY;
ALTER TABLE scheduling_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling_invitations FORCE ROW LEVEL SECURITY;
ALTER TABLE candidate_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidate_submissions FORCE ROW LEVEL SECURITY;
ALTER TABLE candidate_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidate_links FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 2. builderhunt_app policies — owner full access, participant read-only
-- ---------------------------------------------------------------------------

-- user_calendars, availability_rules, availability_overrides: owner-only, no participant concept.
CREATE POLICY user_calendars_app_all ON user_calendars
  FOR ALL TO builderhunt_app
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND owner_user_id = nullif(current_setting('app.user_id', true), '')
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND owner_user_id = nullif(current_setting('app.user_id', true), '')
  );

CREATE POLICY availability_rules_app_all ON availability_rules
  FOR ALL TO builderhunt_app
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND owner_user_id = nullif(current_setting('app.user_id', true), '')
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND owner_user_id = nullif(current_setting('app.user_id', true), '')
  );

CREATE POLICY availability_overrides_app_all ON availability_overrides
  FOR ALL TO builderhunt_app
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND owner_user_id = nullif(current_setting('app.user_id', true), '')
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND owner_user_id = nullif(current_setting('app.user_id', true), '')
  );

-- calendar_events: the owner may do anything; an internal participant with `access_granted`
-- gets SELECT only. Split into separate policies because Postgres ORs permissive policies of the
-- same command — a single FOR ALL policy carrying the participant clause would also let a
-- participant UPDATE/DELETE the owner's event.
CREATE POLICY calendar_events_app_owner_all ON calendar_events
  FOR ALL TO builderhunt_app
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND owner_user_id = nullif(current_setting('app.user_id', true), '')
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND owner_user_id = nullif(current_setting('app.user_id', true), '')
  );

CREATE POLICY calendar_events_app_participant_select ON calendar_events
  FOR SELECT TO builderhunt_app
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1 FROM event_participants p
      WHERE p.organization_id = calendar_events.organization_id
        AND p.event_id = calendar_events.id
        AND p.access_granted
        AND p.user_id = nullif(current_setting('app.user_id', true), '')
    )
  );

-- Child rows of an event inherit the same owner/participant split via their parent.
CREATE POLICY calendar_event_occurrences_app_owner_all ON calendar_event_occurrences
  FOR ALL TO builderhunt_app
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1 FROM calendar_events e
      WHERE e.organization_id = calendar_event_occurrences.organization_id
        AND e.id = calendar_event_occurrences.event_id
        AND e.owner_user_id = nullif(current_setting('app.user_id', true), '')
    )
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1 FROM calendar_events e
      WHERE e.organization_id = calendar_event_occurrences.organization_id
        AND e.id = calendar_event_occurrences.event_id
        AND e.owner_user_id = nullif(current_setting('app.user_id', true), '')
    )
  );

CREATE POLICY calendar_event_occurrences_app_participant_select ON calendar_event_occurrences
  FOR SELECT TO builderhunt_app
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1 FROM event_participants p
      WHERE p.organization_id = calendar_event_occurrences.organization_id
        AND p.event_id = calendar_event_occurrences.event_id
        AND p.access_granted
        AND p.user_id = nullif(current_setting('app.user_id', true), '')
    )
  );

-- Reads only this table's own columns. `event_owner_user_id` is a denormalized copy of the
-- event's owner, held honest by the composite FK against
-- `calendar_events(organization_id, id, owner_user_id)`. Joining back to `calendar_events` here
-- instead would deadlock the policy graph: the `calendar_events` participant-read policy below
-- consults THIS table, so a mutual reference makes Postgres abort every query with
-- "infinite recursion detected in policy for relation calendar_events".
CREATE POLICY event_participants_app_owner_all ON event_participants
  FOR ALL TO builderhunt_app
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND event_owner_user_id = nullif(current_setting('app.user_id', true), '')
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND event_owner_user_id = nullif(current_setting('app.user_id', true), '')
  );

-- A participant may see (and RSVP to) their own participant row, never the other attendees'.
CREATE POLICY event_participants_app_self_select ON event_participants
  FOR SELECT TO builderhunt_app
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND user_id = nullif(current_setting('app.user_id', true), '')
  );

CREATE POLICY event_participants_app_self_update ON event_participants
  FOR UPDATE TO builderhunt_app
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND user_id = nullif(current_setting('app.user_id', true), '')
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND user_id = nullif(current_setting('app.user_id', true), '')
  );

CREATE POLICY calendar_event_reminders_app_owner_all ON calendar_event_reminders
  FOR ALL TO builderhunt_app
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1 FROM calendar_events e
      WHERE e.organization_id = calendar_event_reminders.organization_id
        AND e.id = calendar_event_reminders.event_id
        AND e.owner_user_id = nullif(current_setting('app.user_id', true), '')
    )
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1 FROM calendar_events e
      WHERE e.organization_id = calendar_event_reminders.organization_id
        AND e.id = calendar_event_reminders.event_id
        AND e.owner_user_id = nullif(current_setting('app.user_id', true), '')
    )
  );

-- Notification deliveries are addressed to a specific recipient — a user reads and marks read
-- only their own, never the whole event's delivery log.
CREATE POLICY calendar_notification_deliveries_app_self_select ON calendar_notification_deliveries
  FOR SELECT TO builderhunt_app
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND recipient_user_id = nullif(current_setting('app.user_id', true), '')
  );

CREATE POLICY calendar_notification_deliveries_app_self_update ON calendar_notification_deliveries
  FOR UPDATE TO builderhunt_app
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND recipient_user_id = nullif(current_setting('app.user_id', true), '')
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND recipient_user_id = nullif(current_setting('app.user_id', true), '')
  );

-- scheduling_invitations and the candidate data hanging off them: organizer-owner only.
-- spec.md is explicit that "organization admins receive no implicit access" to candidate data.
CREATE POLICY scheduling_invitations_app_owner_all ON scheduling_invitations
  FOR ALL TO builderhunt_app
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND owner_user_id = nullif(current_setting('app.user_id', true), '')
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND owner_user_id = nullif(current_setting('app.user_id', true), '')
  );

CREATE POLICY candidate_submissions_app_owner_all ON candidate_submissions
  FOR ALL TO builderhunt_app
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1 FROM scheduling_invitations i
      WHERE i.organization_id = candidate_submissions.organization_id
        AND i.id = candidate_submissions.invitation_id
        AND i.owner_user_id = nullif(current_setting('app.user_id', true), '')
    )
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1 FROM scheduling_invitations i
      WHERE i.organization_id = candidate_submissions.organization_id
        AND i.id = candidate_submissions.invitation_id
        AND i.owner_user_id = nullif(current_setting('app.user_id', true), '')
    )
  );

CREATE POLICY candidate_links_app_owner_all ON candidate_links
  FOR ALL TO builderhunt_app
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1 FROM candidate_submissions s
      JOIN scheduling_invitations i
        ON i.organization_id = s.organization_id AND i.id = s.invitation_id
      WHERE s.organization_id = candidate_links.organization_id
        AND s.id = candidate_links.submission_id
        AND i.owner_user_id = nullif(current_setting('app.user_id', true), '')
    )
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1 FROM candidate_submissions s
      JOIN scheduling_invitations i
        ON i.organization_id = s.organization_id AND i.id = s.invitation_id
      WHERE s.organization_id = candidate_links.organization_id
        AND s.id = candidate_links.submission_id
        AND i.owner_user_id = nullif(current_setting('app.user_id', true), '')
    )
  );

-- ---------------------------------------------------------------------------
-- 3. builderhunt_worker policies — org-scoped, no user filter
-- ---------------------------------------------------------------------------
-- The worker materializes occurrences, fires reminders, records deliveries, and runs retention
-- sweeps. It has no session user, so it is org-scoped only, entered via the established
-- `withWorkerOrganization` cross-org loop (see repositories/profile-removal.ts). It gets no
-- policy at all on availability/invitation/candidate tables — nothing in the worker's job list
-- touches candidate data, and the absence of a policy is itself the denial.

CREATE POLICY calendar_events_worker_select ON calendar_events
  FOR SELECT TO builderhunt_worker
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY calendar_event_occurrences_worker_all ON calendar_event_occurrences
  FOR ALL TO builderhunt_worker
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''))
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY event_participants_worker_select ON event_participants
  FOR SELECT TO builderhunt_worker
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY calendar_event_reminders_worker_all ON calendar_event_reminders
  FOR ALL TO builderhunt_worker
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''))
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY calendar_notification_deliveries_worker_all ON calendar_notification_deliveries
  FOR ALL TO builderhunt_worker
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''))
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));

-- Retention sweeps: the worker expires stale invitations and deletes candidate data past its
-- retention window. Read + the specific mutation it needs, never a blanket FOR ALL.
CREATE POLICY scheduling_invitations_worker_select ON scheduling_invitations
  FOR SELECT TO builderhunt_worker
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY scheduling_invitations_worker_update ON scheduling_invitations
  FOR UPDATE TO builderhunt_worker
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''))
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY candidate_submissions_worker_select ON candidate_submissions
  FOR SELECT TO builderhunt_worker
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY candidate_submissions_worker_delete ON candidate_submissions
  FOR DELETE TO builderhunt_worker
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY candidate_links_worker_select ON candidate_links
  FOR SELECT TO builderhunt_worker
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY candidate_links_worker_update ON candidate_links
  FOR UPDATE TO builderhunt_worker
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''))
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY candidate_links_worker_delete ON candidate_links
  FOR DELETE TO builderhunt_worker
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));

-- ---------------------------------------------------------------------------
-- 4. Table grants
-- ---------------------------------------------------------------------------
-- Grants are the outer bound; the policies above are the inner one. A role needs both.
-- `builderhunt_platform` gets nothing here: spec.md's authorization table says candidate and
-- private-calendar data has no operator read path, and there is no admin console for it.
-- `builderhunt_auth` gets nothing — it owns only Better Auth adapter tables.

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE user_calendars TO builderhunt_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE calendar_events TO builderhunt_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE calendar_event_occurrences TO builderhunt_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE event_participants TO builderhunt_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE calendar_event_reminders TO builderhunt_app;
GRANT SELECT, UPDATE ON TABLE calendar_notification_deliveries TO builderhunt_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE availability_rules TO builderhunt_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE availability_overrides TO builderhunt_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE scheduling_invitations TO builderhunt_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE candidate_submissions TO builderhunt_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE candidate_links TO builderhunt_app;

GRANT SELECT ON TABLE calendar_events TO builderhunt_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE calendar_event_occurrences TO builderhunt_worker;
GRANT SELECT ON TABLE event_participants TO builderhunt_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE calendar_event_reminders TO builderhunt_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE calendar_notification_deliveries TO builderhunt_worker;
GRANT SELECT, UPDATE ON TABLE scheduling_invitations TO builderhunt_worker;
GRANT SELECT, DELETE ON TABLE candidate_submissions TO builderhunt_worker;
GRANT SELECT, UPDATE, DELETE ON TABLE candidate_links TO builderhunt_worker;
