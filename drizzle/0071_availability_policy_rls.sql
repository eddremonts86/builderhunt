-- Custom SQL migration file, put your code below! --

-- RLS and grants for `availability_policies` (0070), matching the owner-only pattern already
-- applied to `availability_rules` and `availability_overrides` in 0069.
--
-- Same reasoning as that migration: the organization filter alone would let any member -- including
-- an admin who is not the owner -- read or overwrite someone else's availability. There is
-- deliberately no `app.organization_role = 'admin'` escape hatch. An availability policy has no
-- participant concept at all, so unlike `calendar_events` there is no read-only branch either:
-- you are the owner or you see nothing.
--
-- `builderhunt_worker` is granted SELECT only. The public slot generator resolves an invitation
-- server-side and needs to read the owner's policy to compute offered slots, but nothing in the
-- background path has any business changing what a user is available for.

ALTER TABLE availability_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE availability_policies FORCE ROW LEVEL SECURITY;

CREATE POLICY availability_policies_app_all ON availability_policies
  FOR ALL TO builderhunt_app
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND owner_user_id = nullif(current_setting('app.user_id', true), '')
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND owner_user_id = nullif(current_setting('app.user_id', true), '')
  );

-- The worker has no session user, so its policy is org-scoped only -- exactly like the worker
-- policies in 0069. Its reach is bounded by `withWorkerOrganization` setting one tenant per
-- transaction, never by a user predicate it does not have.
CREATE POLICY availability_policies_worker_select ON availability_policies
  FOR SELECT TO builderhunt_worker
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE availability_policies TO builderhunt_app;
GRANT SELECT ON TABLE availability_policies TO builderhunt_worker;
