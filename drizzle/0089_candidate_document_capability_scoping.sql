-- Narrows the candidate's own policy on `candidate_documents` from the organization to the one
-- invitation their capability is pinned to (plan: calendar-scheduling-interview-intelligence,
-- Phase 6, candidate upload APIs).
--
-- 0085 left this open and said so, with a ⚠️: "row-level separation *between candidates of the same
-- organization* rests on the capability resolver and the repository query, not on RLS". The stated
-- reason was that narrowing it "would need a `app.submission_id` GUC that nothing sets today: the
-- predicate would evaluate to NULL, match zero rows, and candidate uploads would fail silently".
--
-- That is no longer true. 0086 pinned `app.invitation_id` in `withCapabilityContext` for exactly
-- this class of problem, and a submission is reachable from an invitation by a single join — so the
-- predicate can be written against a GUC that is actually set, and *measured* rather than assumed.
-- Closing it here because this is the migration that turns candidate uploads on: leaving it would
-- ship a feature whose isolation depends on every future query remembering to filter.
--
-- Note also that 0085's own header claims "the capability resolver already pins
-- `app.organization_id` and `app.submission_id` before any statement runs", which contradicts the
-- ⚠️ forty lines below it and was never true. An applied migration is immutable, so the correction
-- lives here: there is no `app.submission_id` GUC, there never was, and this policy uses
-- `app.invitation_id` instead.

DROP POLICY candidate_documents_capability_all ON candidate_documents;--> statement-breakpoint

-- `FOR ALL` still, because the candidate legitimately needs to insert their upload and read back its
-- status. What changes is the row set: documents belonging to the submission of *their* invitation,
-- and no other. `nullif(..., '')` keeps an unpinned connection matching nothing rather than
-- everything — a missing GUC must fail closed.
CREATE POLICY candidate_documents_capability_all ON candidate_documents
  FOR ALL TO builderhunt_capability
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1 FROM candidate_submissions s
      WHERE s.organization_id = candidate_documents.organization_id
        AND s.id = candidate_documents.submission_id
        AND s.invitation_id = nullif(current_setting('app.invitation_id', true), '')::uuid
    )
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1 FROM candidate_submissions s
      WHERE s.organization_id = candidate_documents.organization_id
        AND s.id = candidate_documents.submission_id
        AND s.invitation_id = nullif(current_setting('app.invitation_id', true), '')::uuid
    )
  );
