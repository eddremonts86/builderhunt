-- Custom SQL migration file, put your code below! --

-- The one privileged operation the public capability flow needs.
--
-- A candidate holding a capability is not an authenticated user and has no organization yet: the
-- whole point of the secret is that it *tells us* which tenant to enter. That is a genuine
-- chicken-and-egg problem against RLS, whose worker policies all read
-- `current_setting('app.organization_id')` -- with nothing set, `nullif('', '')` is NULL, the
-- predicate is NULL, and the lookup returns nothing.
--
-- The wrong fixes, and why:
--
--   * Grant the worker role a bypass policy on `scheduling_invitations`. That would make every
--     worker query able to read every tenant's invitations, to solve a problem that occurs once per
--     request in one code path.
--   * Set `app.organization_id` before we know it. There is nothing to set it to.
--   * Look the row up as the migration superuser. Same objection as the first, with more privilege.
--
-- So instead: one SECURITY DEFINER function, as narrow as the job allows.
--
--   * It takes a 64-character hex hash and nothing else. There is no pattern match, no prefix
--     search, and no way to ask it for a list -- an attacker who can call it can only confirm a
--     capability they already hold.
--   * It returns three columns: the organization, the owner, and the invitation id. It cannot be
--     used to read the role title, the candidate's email, or the status; those come afterwards,
--     through the ordinary RLS-checked path with the tenant now correctly set.
--   * `search_path` is pinned, so a caller cannot shadow `scheduling_invitations` with their own
--     table and make a definer-privileged function read it.
--   * EXECUTE is granted to the worker role only. `builderhunt_app` has no business calling it: an
--     authenticated organizer already has a tenant.
--
-- spec.md: "Capability writes go through a narrowly privileged server command, never anonymous SQL
-- grants."

CREATE OR REPLACE FUNCTION scheduling_resolve_capability(capability_hash_input text)
RETURNS TABLE (organization_id text, owner_user_id text, invitation_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
STABLE
AS $$
  SELECT i.organization_id, i.owner_user_id, i.id
  FROM public.scheduling_invitations i
  -- Exact match on a full-length hash only. Anything else is not a capability we issued, and
  -- refusing to look makes a malformed secret indistinguishable from a wrong one.
  WHERE i.capability_hash = capability_hash_input
    AND length(capability_hash_input) = 64
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION scheduling_resolve_capability(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scheduling_resolve_capability(text) TO builderhunt_worker;
