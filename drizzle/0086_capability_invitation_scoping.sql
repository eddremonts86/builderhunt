-- Scope every capability policy to one invitation instead of a whole organization.
--
-- Until now each of these read `app.organization_id` and nothing else. A capability secret is
-- issued to one candidate for one invitation, but the row-level predicate it ran under admitted
-- every row the organization owned. Holding one valid scheduling link therefore allowed reading:
--
--   * `scheduling_invitations`  — every other invitation, i.e. who else is being interviewed,
--                                 for which role, with the organizer's role context;
--   * `candidate_submissions`   — other candidates' names, emails and notes;
--   * `candidate_links`         — the portfolios and profiles they submitted;
--   * `privacy_consents`        — other people's consent decisions;
--   * `calendar_events` and participants — other interviews' times and attendees;
--   * `availability_*`, `user_calendars` — every organizer's working hours, not just the one
--                                 the candidate is booking with.
--
-- Nothing was known to be exploited: the repository layer filters by invitation, so the
-- application never asked the wider question. That is exactly the problem — the boundary was
-- upheld by every call site remembering to, with no backstop if one forgot. `withCapabilityContext`
-- now pins `app.invitation_id` and `app.capability_owner_user_id`, and the predicates below use
-- them.
--
-- Two anchors rather than one: candidate-owned data hangs off the invitation, while the organizer's
-- availability and calendars are keyed by user and are legitimately readable by a candidate who
-- needs to pick a slot. Scoping those to the invitation's owner is the tightest correct predicate,
-- not to the invitation itself.
--
-- `nullif(current_setting(..., true), '')` yields NULL when unset, and `col = NULL` is NULL, so a
-- connection that forgets to pin these sees nothing. Fail-closed by construction.

-- ── The invitation itself ────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS scheduling_invitations_capability_select ON scheduling_invitations;--> statement-breakpoint
CREATE POLICY scheduling_invitations_capability_select ON scheduling_invitations
  FOR SELECT TO builderhunt_capability
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND id::text = nullif(current_setting('app.invitation_id', true), '')
  );--> statement-breakpoint

DROP POLICY IF EXISTS scheduling_invitations_capability_update ON scheduling_invitations;--> statement-breakpoint
CREATE POLICY scheduling_invitations_capability_update ON scheduling_invitations
  FOR UPDATE TO builderhunt_capability
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND id::text = nullif(current_setting('app.invitation_id', true), '')
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND id::text = nullif(current_setting('app.invitation_id', true), '')
  );--> statement-breakpoint

-- ── Candidate-owned data, keyed through the submission ───────────────────────────────────────
DROP POLICY IF EXISTS candidate_submissions_capability_all ON candidate_submissions;--> statement-breakpoint
CREATE POLICY candidate_submissions_capability_all ON candidate_submissions
  FOR ALL TO builderhunt_capability
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND invitation_id::text = nullif(current_setting('app.invitation_id', true), '')
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND invitation_id::text = nullif(current_setting('app.invitation_id', true), '')
  );--> statement-breakpoint

DROP POLICY IF EXISTS candidate_links_capability_all ON candidate_links;--> statement-breakpoint
CREATE POLICY candidate_links_capability_all ON candidate_links
  FOR ALL TO builderhunt_capability
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1 FROM candidate_submissions s
      WHERE s.organization_id = candidate_links.organization_id
        AND s.id = candidate_links.submission_id
        AND s.invitation_id::text = nullif(current_setting('app.invitation_id', true), '')
    )
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1 FROM candidate_submissions s
      WHERE s.organization_id = candidate_links.organization_id
        AND s.id = candidate_links.submission_id
        AND s.invitation_id::text = nullif(current_setting('app.invitation_id', true), '')
    )
  );--> statement-breakpoint

DROP POLICY IF EXISTS candidate_documents_capability_all ON candidate_documents;--> statement-breakpoint
CREATE POLICY candidate_documents_capability_all ON candidate_documents
  FOR ALL TO builderhunt_capability
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1 FROM candidate_submissions s
      WHERE s.organization_id = candidate_documents.organization_id
        AND s.id = candidate_documents.submission_id
        AND s.invitation_id::text = nullif(current_setting('app.invitation_id', true), '')
    )
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1 FROM candidate_submissions s
      WHERE s.organization_id = candidate_documents.organization_id
        AND s.id = candidate_documents.submission_id
        AND s.invitation_id::text = nullif(current_setting('app.invitation_id', true), '')
    )
  );--> statement-breakpoint

-- ── Consent, which already carries the invitation ────────────────────────────────────────────
DROP POLICY IF EXISTS privacy_consents_capability_select ON privacy_consents;--> statement-breakpoint
CREATE POLICY privacy_consents_capability_select ON privacy_consents
  FOR SELECT TO builderhunt_capability
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND invitation_id::text = nullif(current_setting('app.invitation_id', true), '')
  );--> statement-breakpoint

DROP POLICY IF EXISTS privacy_consents_capability_update ON privacy_consents;--> statement-breakpoint
CREATE POLICY privacy_consents_capability_update ON privacy_consents
  FOR UPDATE TO builderhunt_capability
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND invitation_id::text = nullif(current_setting('app.invitation_id', true), '')
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND invitation_id::text = nullif(current_setting('app.invitation_id', true), '')
  );--> statement-breakpoint

DROP POLICY IF EXISTS privacy_consents_capability_insert ON privacy_consents;--> statement-breakpoint
CREATE POLICY privacy_consents_capability_insert ON privacy_consents
  FOR INSERT TO builderhunt_capability
  WITH CHECK (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND invitation_id::text = nullif(current_setting('app.invitation_id', true), '')
  );--> statement-breakpoint

-- ── The booked event and everything hanging off it ───────────────────────────────────────────
-- A candidate may see the event their own invitation booked, and no other.
DROP POLICY IF EXISTS calendar_events_capability_select ON calendar_events;--> statement-breakpoint
CREATE POLICY calendar_events_capability_select ON calendar_events
  FOR SELECT TO builderhunt_capability
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1 FROM scheduling_invitations i
      WHERE i.organization_id = calendar_events.organization_id
        AND i.booked_event_id = calendar_events.id
        AND i.id::text = nullif(current_setting('app.invitation_id', true), '')
    )
  );--> statement-breakpoint

DROP POLICY IF EXISTS calendar_events_capability_update ON calendar_events;--> statement-breakpoint
CREATE POLICY calendar_events_capability_update ON calendar_events
  FOR UPDATE TO builderhunt_capability
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1 FROM scheduling_invitations i
      WHERE i.organization_id = calendar_events.organization_id
        AND i.booked_event_id = calendar_events.id
        AND i.id::text = nullif(current_setting('app.invitation_id', true), '')
    )
  )
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));--> statement-breakpoint

-- INSERT keeps its organization-only WITH CHECK: the booking transaction creates the event and only
-- then points the invitation at it, so `booked_event_id` is still null while the row is written and
-- an invitation-scoped predicate would reject the very insert it is meant to allow.

DROP POLICY IF EXISTS event_participants_capability_select ON event_participants;--> statement-breakpoint
CREATE POLICY event_participants_capability_select ON event_participants
  FOR SELECT TO builderhunt_capability
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1 FROM scheduling_invitations i
      WHERE i.organization_id = event_participants.organization_id
        AND i.booked_event_id = event_participants.event_id
        AND i.id::text = nullif(current_setting('app.invitation_id', true), '')
    )
  );--> statement-breakpoint

DROP POLICY IF EXISTS calendar_event_occurrences_capability_select ON calendar_event_occurrences;--> statement-breakpoint
CREATE POLICY calendar_event_occurrences_capability_select ON calendar_event_occurrences
  FOR SELECT TO builderhunt_capability
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1 FROM scheduling_invitations i
      WHERE i.organization_id = calendar_event_occurrences.organization_id
        AND i.booked_event_id = calendar_event_occurrences.event_id
        AND i.id::text = nullif(current_setting('app.invitation_id', true), '')
    )
  );--> statement-breakpoint

DROP POLICY IF EXISTS calendar_event_reminders_capability_select ON calendar_event_reminders;--> statement-breakpoint
CREATE POLICY calendar_event_reminders_capability_select ON calendar_event_reminders
  FOR SELECT TO builderhunt_capability
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1 FROM scheduling_invitations i
      WHERE i.organization_id = calendar_event_reminders.organization_id
        AND i.booked_event_id = calendar_event_reminders.event_id
        AND i.id::text = nullif(current_setting('app.invitation_id', true), '')
    )
  );--> statement-breakpoint

DROP POLICY IF EXISTS calendar_event_reminders_capability_update ON calendar_event_reminders;--> statement-breakpoint
CREATE POLICY calendar_event_reminders_capability_update ON calendar_event_reminders
  FOR UPDATE TO builderhunt_capability
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1 FROM scheduling_invitations i
      WHERE i.organization_id = calendar_event_reminders.organization_id
        AND i.booked_event_id = calendar_event_reminders.event_id
        AND i.id::text = nullif(current_setting('app.invitation_id', true), '')
    )
  )
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));--> statement-breakpoint

-- ── The organizer's availability, keyed by the invitation's owner ────────────────────────────
-- The candidate needs these to pick a slot, so they stay readable — but only the availability of
-- the person they are booking with, not of every organizer in the company.
DROP POLICY IF EXISTS availability_policies_capability_select ON availability_policies;--> statement-breakpoint
CREATE POLICY availability_policies_capability_select ON availability_policies
  FOR SELECT TO builderhunt_capability
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND owner_user_id = nullif(current_setting('app.capability_owner_user_id', true), '')
  );--> statement-breakpoint

DROP POLICY IF EXISTS availability_rules_capability_select ON availability_rules;--> statement-breakpoint
CREATE POLICY availability_rules_capability_select ON availability_rules
  FOR SELECT TO builderhunt_capability
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND owner_user_id = nullif(current_setting('app.capability_owner_user_id', true), '')
  );--> statement-breakpoint

DROP POLICY IF EXISTS availability_overrides_capability_select ON availability_overrides;--> statement-breakpoint
CREATE POLICY availability_overrides_capability_select ON availability_overrides
  FOR SELECT TO builderhunt_capability
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND owner_user_id = nullif(current_setting('app.capability_owner_user_id', true), '')
  );--> statement-breakpoint

DROP POLICY IF EXISTS user_calendars_capability_select ON user_calendars;--> statement-breakpoint
CREATE POLICY user_calendars_capability_select ON user_calendars
  FOR SELECT TO builderhunt_capability
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND owner_user_id = nullif(current_setting('app.capability_owner_user_id', true), '')
  );
