-- Custom SQL migration file, put your code below! --

-- A narrow purge path for consent evidence that is past its retention window.
--
-- 0075 granted nobody DELETE on `privacy_consents` deliberately: "A `GRANT DELETE` here would make
-- 'the candidate withdrew' and 'the row was removed' indistinguishable after the fact", and it named
-- the executor as the platform role through a maintenance path. The interview retention worker then
-- issued `delete from privacy_consents` anyway, as `builderhunt_worker`. It was denied (42501) on
-- every tenant, and because that statement shares a transaction with the rest of the pass, the abort
-- took everything with it: transcripts, sessions, reports, briefs, extractions and CVs were never
-- purged either, for any organization, while `/api/admin/interviews/run-retention` answered
-- `ok: true` with every count at zero. The invariant held. The retention promise did not.
--
-- This restores the purge without granting the privilege the invariant withholds. No role gains
-- DELETE on the table. What the worker gains is EXECUTE on one function whose statement it cannot
-- change:
--
--   * The predicate shape is fixed here — one organization, `decided_at` before a cutoff. A
--     `GRANT DELETE` would have let any statement in the worker remove any consent row by any
--     predicate; this can only ever express "this tenant's evidence, older than X".
--   * Withdrawal stays a distinguishable act: it stamps `withdrawn_at` through the column-level
--     UPDATE grant and leaves the row in place. Nothing here can rewrite a decision.
--   * EXECUTE is revoked from PUBLIC and granted only to the role that runs retention.
--
-- The window itself is `INTERVIEW_CONSENT_RETENTION_MONTHS`, which `env.ts` constrains to a positive
-- integer of at most 24 — the 24 months are a CEILING on how long evidence may be kept, so a shorter
-- configured window is a stricter choice and not something SQL should second-guess. The cutoff and
-- the clock come from the caller here exactly as they do for every other table in the same pass
-- (`retention_expires_at <= params.now`); what this function adds is the privilege boundary, not a
-- second opinion about time.

CREATE OR REPLACE FUNCTION purge_expired_privacy_consents(
  p_organization_id text,
  p_cutoff timestamptz
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  removed integer;
BEGIN
  DELETE FROM privacy_consents
  WHERE organization_id = p_organization_id
    AND decided_at <= p_cutoff;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION purge_expired_privacy_consents(text, timestamptz) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION purge_expired_privacy_consents(text, timestamptz) TO builderhunt_worker;--> statement-breakpoint

-- `privacy_consents` carries FORCE ROW LEVEL SECURITY, which applies policies to the table owner as
-- well. Wherever the owning role is not a superuser, a SECURITY DEFINER delete with no DELETE policy
-- to match would quietly affect zero rows — the same silent no-op this migration exists to remove.
-- The policy is unconditional on purpose: the gate is the EXECUTE grant plus the fixed statement
-- above, and a predicate here that disagreed with the caller's clock would reintroduce exactly that
-- silent no-op on any host whose database clock ran behind.
DROP POLICY IF EXISTS privacy_consents_owner_purge ON privacy_consents;--> statement-breakpoint
CREATE POLICY privacy_consents_owner_purge ON privacy_consents
  FOR DELETE TO builderhunt_owner
  USING (true);
