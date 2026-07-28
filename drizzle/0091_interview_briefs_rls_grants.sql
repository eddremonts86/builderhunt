-- RLS and grants for `interview_briefs` (plan: calendar-scheduling-interview-intelligence, Phase 8).
--
-- A brief is an assessment of a named person, assembled from their CV. The tenant predicate alone is
-- nowhere near enough: every organizer in an organization would read every other organizer's
-- assessments of every candidate. So access is the *narrower* of two things — the organizer who owns
-- the brief, or a colleague explicitly added to that interview.
--
-- ## "Explicit participant" means `access_granted`, not merely listed
--
-- `event_participants` records everyone invited to an event, including people who were added and never
-- given access to the preparation material. spec.md scopes brief reads to explicit participants, so the
-- policy requires `access_granted = true` rather than mere presence in the row set. Being on an
-- interview's attendee list is not the same act as being granted its candidate assessment, and
-- conflating them would hand a CV summary to anyone an organizer added to a calendar invite.
--
-- ## Deliberately no organization-admin path
--
-- Unlike most tables here, an org admin has no policy. An admin can manage seats and billing without
-- reading a colleague's evaluation of a candidate, and "admin" is an operational role, not a
-- need-to-know one. Same posture as `availability_policies` in 0069.
--
-- ## No capability grant at all
--
-- A candidate must never read the assessment written about them — not because it is secret from them
-- as a matter of principle, but because a GDPR access request is the lawful, mediated route for that,
-- and a live API endpoint is not. `builderhunt_capability` gets nothing on this table.

ALTER TABLE interview_briefs ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE interview_briefs FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- The organizer who owns the brief. `nullif(..., '')` so an unpinned connection matches nothing:
-- `col = NULL` is NULL, and a missing GUC must fail closed rather than open up.
CREATE POLICY interview_briefs_app_owner_all ON interview_briefs
  FOR ALL TO builderhunt_app
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND owner_user_id = nullif(current_setting('app.user_id', true), '')
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND owner_user_id = nullif(current_setting('app.user_id', true), '')
  );--> statement-breakpoint

-- A colleague explicitly granted access to this interview. SELECT only: a participant reads the
-- preparation material, they do not regenerate or edit someone else's brief.
CREATE POLICY interview_briefs_app_participant_select ON interview_briefs
  FOR SELECT TO builderhunt_app
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1 FROM event_participants p
      WHERE p.organization_id = interview_briefs.organization_id
        AND p.event_id = interview_briefs.event_id
        AND p.user_id = nullif(current_setting('app.user_id', true), '')
        AND p.access_granted = true
    )
  );--> statement-breakpoint

-- The retention sweeper and the generation worker. Cross-tenant by necessity, which is why the
-- repository always names the organization in its own WHERE clause rather than relying on the policy.
CREATE POLICY interview_briefs_worker_all ON interview_briefs
  FOR ALL TO builderhunt_worker USING (true) WITH CHECK (true);--> statement-breakpoint

-- ── Grants ───────────────────────────────────────────────────────────────────────────────────────
--
-- No `builderhunt_capability`, no anonymous, and no `builderhunt_readonly`: an analytics reader has no
-- business with a candidate assessment, and a table with a readonly grant tends to acquire a dashboard.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE interview_briefs TO builderhunt_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE interview_briefs TO builderhunt_worker;
