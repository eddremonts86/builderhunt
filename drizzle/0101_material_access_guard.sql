-- Custom SQL migration file, put your code below! --

-- Enforcement for `event_participants.material_access_granted` (0100), and the one policy that makes
-- the grant mean anything.
--
-- Background. `access_granted` meant two different things to the two halves of this codebase:
-- calendar code reads it as "may see the event" and grants it to every internal attendee
-- (`src/lib/calendar/service.ts`), while `src/lib/interviews/brief-context.ts` read it as "was handed
-- the candidate's material" and released the brief, report, suggestions and transcript on it. Adding a
-- colleague to an interview invite therefore handed them the interview. Nothing was disclosed only
-- because the second half was unreachable — see the policy at the bottom of this file.
--
-- 0100 split the two. This migration makes the new column safe to trust.

-- ── Only the event owner may change material access ──────────────────────────────────────────────
--
-- `event_participants_app_owner_all` (0069) lets the event owner write any participant row, and
-- `event_participants_app_self_update` lets an attendee write their OWN row so they can RSVP. RLS is
-- row-level, and `builderhunt_app` holds table-wide UPDATE, so that second policy would also let a
-- participant flip `material_access_granted` on themselves — self-service access to a candidate's
-- transcript, one careless endpoint away. Column-level grants cannot separate the two paths either,
-- because both run as the same role.
--
-- A trigger can, because it sees which row it is and who is asking. The guard fires only when the
-- column actually changes, so RSVPs are untouched.
--
-- When `app.user_id` is unset there is no request principal: that is a worker or maintenance
-- connection, whose reach is bounded by its grants instead (`builderhunt_worker` holds SELECT only on
-- this table). A request path cannot reach this branch by omitting the setting, because every policy
-- on the table requires it to match and would deny the row first.
CREATE OR REPLACE FUNCTION event_participants_guard_material_access()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  actor text := nullif(current_setting('app.user_id', true), '');
BEGIN
  IF NEW.material_access_granted IS DISTINCT FROM OLD.material_access_granted
     AND actor IS NOT NULL
     AND actor <> OLD.event_owner_user_id
  THEN
    RAISE EXCEPTION 'only the event owner may change interview material access'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS event_participants_material_access_guard ON event_participants;--> statement-breakpoint
CREATE TRIGGER event_participants_material_access_guard
  BEFORE UPDATE ON event_participants
  FOR EACH ROW
  EXECUTE FUNCTION event_participants_guard_material_access();--> statement-breakpoint

-- ── A granted participant can reach the invitation the material hangs off ─────────────────────────
--
-- `scheduling_invitations` had exactly one app policy, `scheduling_invitations_app_owner_all`,
-- requiring `owner_user_id = app.user_id`. `briefContextForEvent` opens with an inner join against
-- that table, so for anyone but the organizer it returned null at `if (!row)` and never reached the
-- branch that admits granted participants. That branch was dead code, which is why the two meanings
-- of `access_granted` had not yet cost anyone their transcript.
--
-- The predicate widened here is the explicit grant from 0100 — not "was invited to the meeting". The
-- EXISTS is evaluated under the caller's own privileges, so it can only match through
-- `event_participants_app_self_select`: their own participant row, never a colleague's.
DROP POLICY IF EXISTS scheduling_invitations_app_participant_select ON scheduling_invitations;--> statement-breakpoint
CREATE POLICY scheduling_invitations_app_participant_select ON scheduling_invitations
  FOR SELECT TO builderhunt_app
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND booked_event_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM event_participants p
      WHERE p.event_id = scheduling_invitations.booked_event_id
        AND p.organization_id = scheduling_invitations.organization_id
        AND p.user_id = nullif(current_setting('app.user_id', true), '')
        AND p.material_access_granted
    )
  );
