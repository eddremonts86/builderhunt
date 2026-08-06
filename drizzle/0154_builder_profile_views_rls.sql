-- Row-level security for `builder_profile_views` (plans/ui-dashboard Wave 5, "Add an optional
-- verified-profile-owner summary").
--
-- ## What was wrong
--
-- This table records who looked at whose builder profile. `0020_account_subject_grants.sql` gave
-- `builderhunt_app` a blanket `SELECT, INSERT, UPDATE, DELETE` on it, and no migration ever enabled
-- row-level security. Its two closest siblings both have it enabled *and* forced:
--
--     published_builder_profiles | t | t
--     builder_profile_views      | f | f
--     builder_claims             | t | t
--
-- RLS disabled means no row filter, so the application role could read every row of the table,
-- `viewer_id` included. Nothing exploited it: the one read path,
-- `GET /api/builders/$builderId/views`, gates on `isVerifiedBuilderClaimant` before it queries. But
-- the guarantee lived entirely in one handler, on the most identifying table in this area — the
-- repository comment says viewer identities never leave the server, which was true of that query
-- rather than of the table.
--
-- The dashboard's verified-profile-owner widget adds a second read path over the same rows. Adding
-- it while the only defence is another application-level check multiplies the places where one
-- forgotten condition becomes a disclosure of who is looking at whom.
--
-- ## The policies
--
-- Two things may read a row, and they are different people:
--
--   * the **viewer**, for their own rows — the deduplication check on write, and the account data
--     export's "profiles I viewed" section;
--   * the **subject**, for views of a profile they have verifiably claimed — the owner analytics.
--
-- Written as two policies rather than one `OR`, because they are two distinct authorisations that
-- will change independently: the subject's depends on the claim lifecycle, the viewer's does not.
-- Postgres ORs permissive policies for the same command anyway, so the effect is identical and the
-- intent survives.
--
-- The subject policy re-reads `builder_claims`, which has its own RLS keyed on the same
-- `app.user_id`. That is consistent rather than circular: the subquery can only see the caller's own
-- claims, which is exactly the set it needs.
--
-- ## Why FORCE
--
-- Matching the siblings. Without it the table owner bypasses the policies, and migrations and admin
-- sessions connect as the owner. Foreign-key cascades are unaffected — referential integrity checks
-- bypass row security by design, which is what keeps the `ON DELETE cascade` from
-- `builder_identities` and the `ON DELETE set null` from `auth_users` working.
--
-- ## No UPDATE policy, deliberately
--
-- A view record is an immutable fact about a moment. Nothing in the codebase updates one, and the
-- absence of a policy means an accidental future `UPDATE` fails closed instead of rewriting history.
-- The `GRANT` from 0020 still lists UPDATE and DELETE; the grant is the ceiling, the policies are the
-- door, and there is no door for those two.

ALTER TABLE builder_profile_views ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE builder_profile_views FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY builder_profile_views_app_viewer_select ON builder_profile_views
  FOR SELECT TO builderhunt_app
  USING (viewer_id = nullif(current_setting('app.user_id', true), ''));--> statement-breakpoint

CREATE POLICY builder_profile_views_app_subject_select ON builder_profile_views
  FOR SELECT TO builderhunt_app
  USING (EXISTS (
    SELECT 1 FROM builder_claims c
    WHERE c.builder_identity_id = builder_profile_views.builder_id
      AND c.subject_user_id = nullif(current_setting('app.user_id', true), '')
      AND c.status = 'verified'
  ));--> statement-breakpoint

CREATE POLICY builder_profile_views_app_insert ON builder_profile_views
  FOR INSERT TO builderhunt_app
  WITH CHECK (viewer_id = nullif(current_setting('app.user_id', true), ''));
