-- Two candidates could book the same minute. A narrowly privileged busy-range read, because slot
-- generation needs conflicts it must not be allowed to read as rows.
--
-- ## What was broken
--
-- `querySlots` subtracts the organizer's busy intervals from their availability, reading them with
-- `listBusyRanges`, which selects `starts_at, ends_at` and nothing else — see the note at the top of
-- `slot-service.ts`: "other candidates' interviews stay invisible: `listBusyRanges` selects
-- start/end only".
--
-- That reasoning is about *columns*. 0086 then scoped the capability role's view of
-- `calendar_events` to the caller's own invitation, which is about *rows* — and RLS filters rows. So
-- under a candidate's capability the busy read returned nothing at all, every already-booked slot
-- was offered as free, and two candidates of the same organizer could each book the same instant.
-- Both requests answered `200`.
--
-- The advisory lock did its job: the two bookings were serialized. The second one recomputed the
-- slots exactly as designed, and recomputed them from a busy list its own role could not see.
--
-- Found by the Phase 12 candidate e2e, which books the same slot from two invitations concurrently
-- and asserts one winner. It got two.
--
-- ## Why a function rather than a wider policy
--
-- Widening the capability role's row access to every event of the organizer would restore slot
-- correctness by undoing 0086 — handing one candidate the times, titles and attendees of every other
-- interview in the organization. spec.md is explicit: "Capability writes go through a narrowly
-- privileged server command, never anonymous SQL grants," and this is the read side of the same
-- principle. The function returns two timestamps per row and nothing else: no id, no title, no
-- participant, no invitation. A candidate learns that a time is taken, which they would learn anyway
-- by trying to book it.
--
-- ## The owner cannot be chosen by the caller
--
-- `owner_user_id_input` is checked against the *pinned* identity, not trusted:
--
--   * under a capability, `app.capability_owner_user_id` is set by `withCapabilityContext` from the
--     resolved invitation, so a candidate can only ask about the organizer who invited them;
--   * under an authenticated session, `app.user_id` is the caller, so an organizer can only ask
--     about themselves.
--
-- Neither pinned means no match and an empty result — fail closed, the same shape as every
-- `nullif(current_setting(...), '')` predicate in these migrations.

CREATE OR REPLACE FUNCTION scheduling_busy_ranges(
  owner_user_id_input text,
  range_from timestamptz,
  range_to timestamptz
)
RETURNS TABLE (starts_at timestamptz, ends_at timestamptz)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
STABLE
AS $$
  SELECT e.starts_at, e.ends_at
  FROM public.calendar_events e
  WHERE e.organization_id = nullif(current_setting('app.organization_id', true), '')
    AND e.owner_user_id = owner_user_id_input
    -- The caller may only ask about the identity their own context pins.
    AND (
      owner_user_id_input = nullif(current_setting('app.capability_owner_user_id', true), '')
      OR owner_user_id_input = nullif(current_setting('app.user_id', true), '')
    )
    AND e.busy = true
    AND e.status IN ('scheduled', 'confirmed', 'in_progress')
    AND e.starts_at < range_to
    AND e.ends_at >= range_from
  ORDER BY e.starts_at;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION scheduling_busy_ranges(text, timestamptz, timestamptz) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION scheduling_busy_ranges(text, timestamptz, timestamptz) TO builderhunt_capability;--> statement-breakpoint
-- The organizer's own preview of the slots a candidate would see runs under the app role and must
-- agree with what the candidate is offered, or the preview quietly shows different times.
GRANT EXECUTE ON FUNCTION scheduling_busy_ranges(text, timestamptz, timestamptz) TO builderhunt_app;
