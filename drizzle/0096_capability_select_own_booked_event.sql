-- The candidate could not book at all. Fixes the capability SELECT policies on the four
-- event-shaped tables so a booking's own `INSERT ... RETURNING` can see the row it just wrote.
--
-- ## What was broken
--
-- 0086 tightened `calendar_events_capability_select` to require an invitation whose
-- `booked_event_id` equals the row's id. It reasoned carefully about the INSERT `WITH CHECK` —
-- see its own comment: "the booking transaction creates the event and only then points the
-- invitation at it, so `booked_event_id` is still null while the row is written and an
-- invitation-scoped predicate would reject the very insert it is meant to allow" — and left that
-- one org-scoped.
--
-- What it missed is that `insertEvent` writes with `RETURNING`, and PostgreSQL evaluates the
-- **SELECT** policies against the new row for the returned columns. So the insert satisfied its
-- WITH CHECK, failed the SELECT policy on a row whose `booked_event_id` back-pointer did not exist
-- yet, and raised `42501 new row violates row-level security policy`. Every candidate booking
-- answered `400 invalid_input`. The same applies to the participants and reminders written
-- immediately afterwards, which also use `RETURNING`.
--
-- ## Why nothing caught it
--
-- Three layers of test each missed it for a different reason, and the combination is the lesson:
--
--   * `booking-service.test.ts` runs on a disposable database as the migration superuser, which
--     bypasses RLS entirely — so it exercises the booking logic and none of the policies.
--   * the local `DATABASE_URL` names `postgres`, so the *authenticated* half of the app also runs
--     as a superuser on a developer machine. Tenant isolation there is upheld by application code
--     with the database backstop switched off.
--   * the E2E harness redirected the five role URLs at its disposable database but not
--     `DATABASE_CAPABILITY_URL`, so the public candidate flow talked to the developer's real
--     database and could never be exercised against a fixture at all.
--
-- The role that would have failed was the one role no test ever connected as.
--
-- ## The predicate
--
-- `source_type = 'scheduling_invitation' AND source_id = app.invitation_id` is true from the moment
-- the row exists, because the booking sets that pair in the same INSERT. It is also the *stronger*
-- link: `booked_event_id` is a back-pointer with `ON DELETE SET NULL`, so a cancelled or re-pointed
-- invitation would silently strip a candidate's access to the event they themselves booked, while
-- the source pair records which invitation created it for as long as the row lives.
--
-- Both are kept, OR'd, so nothing that resolved before resolves differently now.

-- ── calendar_events ──────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS calendar_events_capability_select ON calendar_events;--> statement-breakpoint
CREATE POLICY calendar_events_capability_select ON calendar_events
  FOR SELECT TO builderhunt_capability
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND (
      (
        calendar_events.source_type = 'scheduling_invitation'
        AND calendar_events.source_id = nullif(current_setting('app.invitation_id', true), '')
      )
      OR EXISTS (
        SELECT 1 FROM scheduling_invitations i
        WHERE i.organization_id = calendar_events.organization_id
          AND i.booked_event_id = calendar_events.id
          AND i.id::text = nullif(current_setting('app.invitation_id', true), '')
      )
    )
  );--> statement-breakpoint

-- UPDATE too: a candidate cancels by moving their event to `cancelled`, and `UPDATE ... RETURNING`
-- reads the row back through the same SELECT policy.
DROP POLICY IF EXISTS calendar_events_capability_update ON calendar_events;--> statement-breakpoint
CREATE POLICY calendar_events_capability_update ON calendar_events
  FOR UPDATE TO builderhunt_capability
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND (
      (
        calendar_events.source_type = 'scheduling_invitation'
        AND calendar_events.source_id = nullif(current_setting('app.invitation_id', true), '')
      )
      OR EXISTS (
        SELECT 1 FROM scheduling_invitations i
        WHERE i.organization_id = calendar_events.organization_id
          AND i.booked_event_id = calendar_events.id
          AND i.id::text = nullif(current_setting('app.invitation_id', true), '')
      )
    )
  )
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));--> statement-breakpoint

-- ── event_participants ───────────────────────────────────────────────────────────────────────
-- Reached through the event, so one sharing rule stays in one shape.
DROP POLICY IF EXISTS event_participants_capability_select ON event_participants;--> statement-breakpoint
CREATE POLICY event_participants_capability_select ON event_participants
  FOR SELECT TO builderhunt_capability
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1 FROM calendar_events e
      WHERE e.organization_id = event_participants.organization_id
        AND e.id = event_participants.event_id
        AND e.source_type = 'scheduling_invitation'
        AND e.source_id = nullif(current_setting('app.invitation_id', true), '')
    )
  );--> statement-breakpoint

-- ── calendar_event_reminders ─────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS calendar_event_reminders_capability_select ON calendar_event_reminders;--> statement-breakpoint
CREATE POLICY calendar_event_reminders_capability_select ON calendar_event_reminders
  FOR SELECT TO builderhunt_capability
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1 FROM calendar_events e
      WHERE e.organization_id = calendar_event_reminders.organization_id
        AND e.id = calendar_event_reminders.event_id
        AND e.source_type = 'scheduling_invitation'
        AND e.source_id = nullif(current_setting('app.invitation_id', true), '')
    )
  );--> statement-breakpoint

-- ── calendar_event_occurrences ───────────────────────────────────────────────────────────────
-- No capability write path exists here (an interview booking is a single occurrence, materialized
-- by the worker), but the read is corrected for the same reason: a `booked_event_id` that a cancel
-- nulled would hide the candidate's own appointment from them.
DROP POLICY IF EXISTS calendar_event_occurrences_capability_select ON calendar_event_occurrences;--> statement-breakpoint
CREATE POLICY calendar_event_occurrences_capability_select ON calendar_event_occurrences
  FOR SELECT TO builderhunt_capability
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1 FROM calendar_events e
      WHERE e.organization_id = calendar_event_occurrences.organization_id
        AND e.id = calendar_event_occurrences.event_id
        AND e.source_type = 'scheduling_invitation'
        AND e.source_id = nullif(current_setting('app.invitation_id', true), '')
    )
  );
