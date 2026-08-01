-- Custom SQL migration file, put your code below! --
-- plans/phase-1/43-solutions-intelligence Phase 3, "Add canonical human and source-link schema".
--
-- `builder_identities` is a source ACCOUNT (one row per source+source_id). One person may hold
-- several. These tables add the person those accounts can belong to, plus the evidence that says so
-- and the lineage that lets it be undone.
--
-- Purely additive: nothing reads these yet, `builder_identities` is untouched, and organization
-- tracking keeps pointing at identities. The dual-read/dual-write cutover is a later task, which is
-- what makes this migration safe to ship ahead of the code that uses it.
--
-- Classification: global-public, same as `builder_identities` — no organization column, read through
-- publicDb, written by workers and reviewed admin actions. Tenant-private opinions about a person
-- stay in `organization_builders.private_metadata`, which this does not touch.

CREATE TABLE "canonical_humans" (
  "id" text PRIMARY KEY NOT NULL,
  -- Projections chosen from linked accounts, not authored here. All nullable: "no agreed display
  -- name yet" is a normal state, and two sources disagreeing is what field_provenance records
  -- instead of silently picking a winner.
  "display_name" text,
  "headline" text,
  "country" text,
  "language" text,
  -- { fieldName: { sourceLinkId, observedAt } } — so an unmerge can detach the projected values it
  -- brought in, field by field, rather than leaving them behind with no traceable origin.
  "field_provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "human_source_links" (
  "id" text PRIMARY KEY NOT NULL,
  "canonical_human_id" text NOT NULL REFERENCES "canonical_humans"("id") ON DELETE CASCADE,
  "builder_identity_id" text NOT NULL REFERENCES "builder_identities"("id") ON DELETE CASCADE,
  "link_method" text NOT NULL,
  "review_state" text DEFAULT 'pending_review' NOT NULL,
  -- Basis points so confidence is an integer; a float would drift under repeated recomputation.
  "confidence_bps" integer DEFAULT 0 NOT NULL,
  "evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "reviewed_by_user_id" text REFERENCES "auth_users"("id") ON DELETE SET NULL,
  "reviewed_at" timestamp with time zone,
  -- Withdrawal sets valid_until rather than deleting: reversible merges need the history, and so
  -- does answering "why was this person shown as that account last week".
  "valid_from" timestamp with time zone DEFAULT now() NOT NULL,
  "valid_until" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "human_source_links_human_identity_unique" UNIQUE ("canonical_human_id", "builder_identity_id"),
  CONSTRAINT "human_source_links_method_check"
    CHECK ("link_method" IN ('verified_claim', 'explicit_cross_link', 'reviewed_deterministic', 'probabilistic_candidate')),
  CONSTRAINT "human_source_links_review_state_check"
    CHECK ("review_state" IN ('auto_approved', 'pending_review', 'approved', 'rejected')),
  CONSTRAINT "human_source_links_confidence_range_check" CHECK ("confidence_bps" BETWEEN 0 AND 10000),
  -- The storage-level guarantee behind spec.md's "Semantic similarity can propose an edge for review
  -- but cannot activate it": a similarity-derived link can never be auto-approved, so no future code
  -- path can re-create the "two people called alice are one person" bug by writing the row directly.
  CONSTRAINT "human_source_links_probabilistic_needs_review_check"
    CHECK ("link_method" <> 'probabilistic_candidate' OR "review_state" <> 'auto_approved'),
  CONSTRAINT "human_source_links_validity_order_check"
    CHECK ("valid_until" IS NULL OR "valid_until" > "valid_from")
);

-- The core integrity rule: one source account belongs to at most ONE canonical human at a time.
-- Partial on purpose — withdrawn and rejected links must not block a later correct link, which is
-- precisely what makes unmerge-then-remerge possible.
CREATE UNIQUE INDEX "human_source_links_active_identity_unique"
  ON "human_source_links" ("builder_identity_id")
  WHERE "valid_until" IS NULL AND "review_state" IN ('auto_approved', 'approved');

CREATE INDEX "human_source_links_review_queue_idx" ON "human_source_links" ("review_state", "created_at");
CREATE INDEX "human_source_links_human_idx" ON "human_source_links" ("canonical_human_id");

CREATE TABLE "human_merge_events" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "target_canonical_human_id" text NOT NULL REFERENCES "canonical_humans"("id") ON DELETE CASCADE,
  -- Deliberately NOT a foreign key: the absorbed human's row may be deleted after the merge, and the
  -- lineage has to outlive it or the merge stops being reversible.
  "source_canonical_human_id" text NOT NULL,
  "performed_by_user_id" text REFERENCES "auth_users"("id") ON DELETE SET NULL,
  "reason" text NOT NULL,
  "restore_snapshot" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "reverted_at" timestamp with time zone,
  "reverted_by_user_id" text REFERENCES "auth_users"("id") ON DELETE SET NULL
);

CREATE INDEX "human_merge_events_target_idx" ON "human_merge_events" ("target_canonical_human_id", "created_at");
CREATE INDEX "human_merge_events_source_idx" ON "human_merge_events" ("source_canonical_human_id");

-- Role grants, mirroring `builder_identities` (0011/0018) and `builder_claims` (0116).
--
-- `builderhunt_app` reads only. Linking decisions are made by the enrichment worker or by a reviewed
-- platform-admin action, never by an ordinary request — a request-scoped role that could INSERT here
-- would be able to assert that two real people are the same person.
GRANT SELECT ON TABLE "canonical_humans" TO "builderhunt_app";
GRANT SELECT ON TABLE "human_source_links" TO "builderhunt_app";

-- The worker proposes and applies links during approved ingestion. It may INSERT and UPDATE, but the
-- probabilistic CHECK above still stops it from approving a similarity guess on its own.
GRANT SELECT, INSERT, UPDATE ON TABLE "canonical_humans" TO "builderhunt_worker";
GRANT SELECT, INSERT, UPDATE ON TABLE "human_source_links" TO "builderhunt_worker";
GRANT SELECT, INSERT ON TABLE "human_merge_events" TO "builderhunt_worker";

-- Platform admins work the review queue and perform/revert merges. UPDATE on merge events is for
-- stamping reverted_at only; the audit rows themselves are never rewritten.
GRANT SELECT, INSERT, UPDATE ON TABLE "canonical_humans" TO "builderhunt_platform";
GRANT SELECT, INSERT, UPDATE ON TABLE "human_source_links" TO "builderhunt_platform";
GRANT SELECT, INSERT, UPDATE ON TABLE "human_merge_events" TO "builderhunt_platform";
