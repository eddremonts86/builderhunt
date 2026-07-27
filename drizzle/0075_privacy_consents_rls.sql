-- Custom SQL migration file, put your code below! --

-- RLS and grants for `privacy_consents` (0074).
--
-- This table is the evidence that processing was lawful, so the interesting part of this migration
-- is not who can read it -- it is what nobody can do to it.
--
-- Append-only is enforced by the grant, not by convention:
--
--   * No DELETE to anyone. Not the app, not the worker. Retention deletion of consent evidence is a
--     24-month platform obligation (spec.md "consent and minimal redacted audit evidence: 24
--     months"), executed by the platform role through a maintenance path, not something a request
--     handler can reach. A `GRANT DELETE` here would make "the candidate withdrew" and "the row was
--     removed" indistinguishable after the fact.
--   * UPDATE is granted on `withdrawn_at` ONLY -- column-level, because RLS cannot restrict columns.
--     A withdrawal stamps that one timestamp. Nothing in a request path can rewrite which purpose
--     was consented to, on which notice version, or when. A changed decision inserts a new row
--     pointing back through `supersedes_id`; it never edits the old one.
--
-- Read access follows `candidate_submissions` in 0069: the invitation owner, resolved by joining
-- `scheduling_invitations`, with no admin escape hatch. An admin who is not the organizer has no
-- business reading a candidate's consent record.

ALTER TABLE privacy_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE privacy_consents FORCE ROW LEVEL SECURITY;

-- The organizer who owns the invitation. Deliberately not FOR ALL: see the grant block below --
-- even with a permissive policy, the app role has no DELETE privilege and can only write
-- `withdrawn_at` on UPDATE.
CREATE POLICY privacy_consents_app_owner_select ON privacy_consents
  FOR SELECT TO builderhunt_app
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1 FROM scheduling_invitations i
      WHERE i.organization_id = privacy_consents.organization_id
        AND i.id = privacy_consents.invitation_id
        AND i.owner_user_id = nullif(current_setting('app.user_id', true), '')
    )
  );

CREATE POLICY privacy_consents_app_owner_insert ON privacy_consents
  FOR INSERT TO builderhunt_app
  WITH CHECK (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1 FROM scheduling_invitations i
      WHERE i.organization_id = privacy_consents.organization_id
        AND i.id = privacy_consents.invitation_id
        AND i.owner_user_id = nullif(current_setting('app.user_id', true), '')
    )
  );

CREATE POLICY privacy_consents_app_owner_update ON privacy_consents
  FOR UPDATE TO builderhunt_app
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1 FROM scheduling_invitations i
      WHERE i.organization_id = privacy_consents.organization_id
        AND i.id = privacy_consents.invitation_id
        AND i.owner_user_id = nullif(current_setting('app.user_id', true), '')
    )
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1 FROM scheduling_invitations i
      WHERE i.organization_id = privacy_consents.organization_id
        AND i.id = privacy_consents.invitation_id
        AND i.owner_user_id = nullif(current_setting('app.user_id', true), '')
    )
  );

-- The worker has no session user, so its policy is org-scoped only -- exactly like the worker
-- policies in 0069. It writes the consent rows for an accountless candidate's booking and stamps a
-- withdrawal, because a candidate holding a capability is not an authenticated user and the booking
-- path runs as the worker with one tenant pinned per transaction (spec.md: "Capability writes go
-- through a narrowly privileged server command, never anonymous SQL grants").
CREATE POLICY privacy_consents_worker_select ON privacy_consents
  FOR SELECT TO builderhunt_worker
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY privacy_consents_worker_insert ON privacy_consents
  FOR INSERT TO builderhunt_worker
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY privacy_consents_worker_update ON privacy_consents
  FOR UPDATE TO builderhunt_worker
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''))
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));

-- No DELETE, and UPDATE narrowed to the single column a withdrawal touches.
GRANT SELECT, INSERT ON TABLE privacy_consents TO builderhunt_app;
GRANT UPDATE (withdrawn_at) ON TABLE privacy_consents TO builderhunt_app;
GRANT SELECT, INSERT ON TABLE privacy_consents TO builderhunt_worker;
GRANT UPDATE (withdrawn_at) ON TABLE privacy_consents TO builderhunt_worker;
