-- RLS and grants for the candidate-document tables added in 0084
-- (plan: calendar-scheduling-interview-intelligence, Phase 6).
--
-- Mirrors the shape 0069 established for `candidate_submissions`/`candidate_links`: the tenant
-- predicate alone is not enough, because every organizer in an organization would then read every
-- other organizer's candidate documents. Ownership is proven by walking back to the invitation's
-- `owner_user_id`, exactly as the sibling tables do.
--
-- Four roles, four different reasons:
--   * `builderhunt_app`      — the organizer, scoped to invitations they own.
--   * `builderhunt_capability` — the accountless candidate, holding a signed capability. It may
--     INSERT its own upload and read it back, and nothing else; the capability resolver already
--     pins `app.organization_id` and `app.submission_id` before any statement runs.
--   * `builderhunt_worker`   — the scanner, extractor and retention sweeper. Reads and updates
--     status columns, deletes on expiry, never inserts.
--   * nobody else. There is no anonymous grant on any of these tables.

ALTER TABLE candidate_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidate_documents FORCE ROW LEVEL SECURITY;
ALTER TABLE document_extractions ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_extractions FORCE ROW LEVEL SECURITY;
ALTER TABLE candidate_web_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidate_web_imports FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- ── candidate_documents ──────────────────────────────────────────────────────────────────────
CREATE POLICY candidate_documents_app_owner_all ON candidate_documents
  FOR ALL TO builderhunt_app
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1 FROM candidate_submissions s
      JOIN scheduling_invitations i
        ON i.organization_id = s.organization_id AND i.id = s.invitation_id
      WHERE s.organization_id = candidate_documents.organization_id
        AND s.id = candidate_documents.submission_id
        AND i.owner_user_id = nullif(current_setting('app.user_id', true), '')
    )
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1 FROM candidate_submissions s
      JOIN scheduling_invitations i
        ON i.organization_id = s.organization_id AND i.id = s.invitation_id
      WHERE s.organization_id = candidate_documents.organization_id
        AND s.id = candidate_documents.submission_id
        AND i.owner_user_id = nullif(current_setting('app.user_id', true), '')
    )
  );--> statement-breakpoint

-- Organization-scoped only, matching `candidate_submissions_capability_all` and
-- `candidate_links_capability_all` exactly. Narrowing this to a single submission would need a
-- `app.submission_id` GUC that nothing sets today: the predicate would evaluate to NULL, match zero
-- rows, and candidate uploads would fail silently rather than loudly.
--
-- ⚠️ That means row-level separation *between candidates of the same organization* rests on the
-- capability resolver and the repository query, not on RLS — the same posture the two sibling
-- tables already have. Worth closing for all three together by pinning a submission GUC in
-- `withCapabilityContext`; out of scope for this migration, which must not change the security
-- model of tables it does not own.
CREATE POLICY candidate_documents_capability_all ON candidate_documents
  FOR ALL TO builderhunt_capability
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''))
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));--> statement-breakpoint

CREATE POLICY candidate_documents_worker_select ON candidate_documents
  FOR SELECT TO builderhunt_worker USING (true);--> statement-breakpoint
CREATE POLICY candidate_documents_worker_update ON candidate_documents
  FOR UPDATE TO builderhunt_worker USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY candidate_documents_worker_delete ON candidate_documents
  FOR DELETE TO builderhunt_worker USING (true);--> statement-breakpoint

-- ── document_extractions ─────────────────────────────────────────────────────────────────────
-- Ownership is inherited from the document, which in turn proves it through the invitation. The
-- candidate has no policy here at all: they upload bytes, they do not read what a parser made of
-- them.
CREATE POLICY document_extractions_app_owner_all ON document_extractions
  FOR ALL TO builderhunt_app
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1 FROM candidate_documents d
      JOIN candidate_submissions s
        ON s.organization_id = d.organization_id AND s.id = d.submission_id
      JOIN scheduling_invitations i
        ON i.organization_id = s.organization_id AND i.id = s.invitation_id
      WHERE d.organization_id = document_extractions.organization_id
        AND d.id = document_extractions.document_id
        AND i.owner_user_id = nullif(current_setting('app.user_id', true), '')
    )
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1 FROM candidate_documents d
      JOIN candidate_submissions s
        ON s.organization_id = d.organization_id AND s.id = d.submission_id
      JOIN scheduling_invitations i
        ON i.organization_id = s.organization_id AND i.id = s.invitation_id
      WHERE d.organization_id = document_extractions.organization_id
        AND d.id = document_extractions.document_id
        AND i.owner_user_id = nullif(current_setting('app.user_id', true), '')
    )
  );--> statement-breakpoint

CREATE POLICY document_extractions_worker_all ON document_extractions
  FOR ALL TO builderhunt_worker USING (true) WITH CHECK (true);--> statement-breakpoint

-- ── candidate_web_imports ────────────────────────────────────────────────────────────────────
CREATE POLICY candidate_web_imports_app_owner_all ON candidate_web_imports
  FOR ALL TO builderhunt_app
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1 FROM candidate_links l
      JOIN candidate_submissions s
        ON s.organization_id = l.organization_id AND s.id = l.submission_id
      JOIN scheduling_invitations i
        ON i.organization_id = s.organization_id AND i.id = s.invitation_id
      WHERE l.organization_id = candidate_web_imports.organization_id
        AND l.id = candidate_web_imports.candidate_link_id
        AND i.owner_user_id = nullif(current_setting('app.user_id', true), '')
    )
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1 FROM candidate_links l
      JOIN candidate_submissions s
        ON s.organization_id = l.organization_id AND s.id = l.submission_id
      JOIN scheduling_invitations i
        ON i.organization_id = s.organization_id AND i.id = s.invitation_id
      WHERE l.organization_id = candidate_web_imports.organization_id
        AND l.id = candidate_web_imports.candidate_link_id
        AND i.owner_user_id = nullif(current_setting('app.user_id', true), '')
    )
  );--> statement-breakpoint

CREATE POLICY candidate_web_imports_worker_all ON candidate_web_imports
  FOR ALL TO builderhunt_worker USING (true) WITH CHECK (true);--> statement-breakpoint

-- ── Grants ───────────────────────────────────────────────────────────────────────────────────
-- Without these the policies above are unreachable and every statement fails with a permission
-- error rather than an empty result — the failure mode that hid the `sourcing_sprints` bug for
-- weeks, because it only appears under the real least-privilege roles.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE candidate_documents TO builderhunt_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE document_extractions TO builderhunt_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE candidate_web_imports TO builderhunt_app;--> statement-breakpoint

GRANT SELECT, INSERT ON TABLE candidate_documents TO builderhunt_capability;--> statement-breakpoint

GRANT SELECT, UPDATE, DELETE ON TABLE candidate_documents TO builderhunt_worker;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE document_extractions TO builderhunt_worker;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE candidate_web_imports TO builderhunt_worker;
