-- RLS and grants for the live-interview tables added in 0092 (plan:
-- calendar-scheduling-interview-intelligence, Phase 9).
--
-- These four hold the most sensitive material in the product: what a named candidate actually said,
-- what a model inferred from it, and the assessment written afterwards. The policy shape therefore
-- copies `interview_briefs` (0091) rather than the looser tenant pattern used elsewhere — the owner, or
-- a colleague *explicitly granted* access to that interview, and nobody else.
--
-- ## "Explicit participant" means `access_granted`, again
--
-- Being on an interview's attendee list is not the same act as being handed its transcript. The
-- predicate requires `event_participants.access_granted = true`, and the RLS fixture carries a
-- participant with it set to false precisely so that distinction is measured rather than assumed.
--
-- ## No organization-admin path, and no capability grant
--
-- An admin manages seats and billing without reading what a candidate said in an interview. And a
-- candidate has no route here at all: their lawful route to their own transcript is a GDPR access
-- request, which is mediated, logged, and reviewed — not an endpoint they can poll.
--
-- ## Segments and suggestions inherit through the session
--
-- Their policies walk `interview_sessions` rather than duplicating the participant join. One place to
-- change if the sharing rule ever changes, and no possibility of the three drifting apart.

ALTER TABLE interview_sessions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE interview_sessions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE transcript_segments ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE transcript_segments FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE interview_suggestions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE interview_suggestions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE interview_reports ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE interview_reports FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- ── interview_sessions ───────────────────────────────────────────────────────────────────────────
CREATE POLICY interview_sessions_app_owner_all ON interview_sessions
  FOR ALL TO builderhunt_app
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND owner_user_id = nullif(current_setting('app.user_id', true), '')
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND owner_user_id = nullif(current_setting('app.user_id', true), '')
  );--> statement-breakpoint

-- SELECT only for a granted colleague: they watch and read, they do not start, pause or finish someone
-- else's interview.
CREATE POLICY interview_sessions_app_participant_select ON interview_sessions
  FOR SELECT TO builderhunt_app
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1 FROM event_participants p
      WHERE p.organization_id = interview_sessions.organization_id
        AND p.event_id = interview_sessions.event_id
        AND p.user_id = nullif(current_setting('app.user_id', true), '')
        AND p.access_granted = true
    )
  );--> statement-breakpoint

CREATE POLICY interview_sessions_worker_all ON interview_sessions
  FOR ALL TO builderhunt_worker USING (true) WITH CHECK (true);--> statement-breakpoint

-- ── transcript_segments ──────────────────────────────────────────────────────────────────────────
-- Inherited through the session, which is what keeps one sharing rule in one place.
CREATE POLICY transcript_segments_app_all ON transcript_segments
  FOR ALL TO builderhunt_app
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1 FROM interview_sessions s
      WHERE s.organization_id = transcript_segments.organization_id
        AND s.id = transcript_segments.session_id
        AND s.owner_user_id = nullif(current_setting('app.user_id', true), '')
    )
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1 FROM interview_sessions s
      WHERE s.organization_id = transcript_segments.organization_id
        AND s.id = transcript_segments.session_id
        AND s.owner_user_id = nullif(current_setting('app.user_id', true), '')
    )
  );--> statement-breakpoint

-- A granted participant reads the transcript. They cannot write one: segments arrive from the
-- organizer's capture client, and a second writer would break the sequence contract.
CREATE POLICY transcript_segments_app_participant_select ON transcript_segments
  FOR SELECT TO builderhunt_app
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1 FROM interview_sessions s
      JOIN event_participants p
        ON p.organization_id = s.organization_id AND p.event_id = s.event_id
      WHERE s.organization_id = transcript_segments.organization_id
        AND s.id = transcript_segments.session_id
        AND p.user_id = nullif(current_setting('app.user_id', true), '')
        AND p.access_granted = true
    )
  );--> statement-breakpoint

CREATE POLICY transcript_segments_worker_all ON transcript_segments
  FOR ALL TO builderhunt_worker USING (true) WITH CHECK (true);--> statement-breakpoint

-- ── interview_suggestions ────────────────────────────────────────────────────────────────────────
CREATE POLICY interview_suggestions_app_all ON interview_suggestions
  FOR ALL TO builderhunt_app
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1 FROM interview_sessions s
      WHERE s.organization_id = interview_suggestions.organization_id
        AND s.id = interview_suggestions.session_id
        AND s.owner_user_id = nullif(current_setting('app.user_id', true), '')
    )
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1 FROM interview_sessions s
      WHERE s.organization_id = interview_suggestions.organization_id
        AND s.id = interview_suggestions.session_id
        AND s.owner_user_id = nullif(current_setting('app.user_id', true), '')
    )
  );--> statement-breakpoint

CREATE POLICY interview_suggestions_worker_all ON interview_suggestions
  FOR ALL TO builderhunt_worker USING (true) WITH CHECK (true);--> statement-breakpoint

-- ── interview_reports ────────────────────────────────────────────────────────────────────────────
CREATE POLICY interview_reports_app_owner_all ON interview_reports
  FOR ALL TO builderhunt_app
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND owner_user_id = nullif(current_setting('app.user_id', true), '')
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND owner_user_id = nullif(current_setting('app.user_id', true), '')
  );--> statement-breakpoint

CREATE POLICY interview_reports_app_participant_select ON interview_reports
  FOR SELECT TO builderhunt_app
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1 FROM event_participants p
      WHERE p.organization_id = interview_reports.organization_id
        AND p.event_id = interview_reports.event_id
        AND p.user_id = nullif(current_setting('app.user_id', true), '')
        AND p.access_granted = true
    )
  );--> statement-breakpoint

CREATE POLICY interview_reports_worker_all ON interview_reports
  FOR ALL TO builderhunt_worker USING (true) WITH CHECK (true);--> statement-breakpoint

-- ── Grants ───────────────────────────────────────────────────────────────────────────────────────
--
-- App and worker only. No `builderhunt_capability` (a candidate has no route to their own transcript
-- except a GDPR request) and no `builderhunt_readonly` (a table with a readonly grant tends to acquire
-- a dashboard, and this one holds what a person said in a job interview).
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE interview_sessions TO builderhunt_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE transcript_segments TO builderhunt_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE interview_suggestions TO builderhunt_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE interview_reports TO builderhunt_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE interview_sessions TO builderhunt_worker;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE transcript_segments TO builderhunt_worker;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE interview_suggestions TO builderhunt_worker;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE interview_reports TO builderhunt_worker;
