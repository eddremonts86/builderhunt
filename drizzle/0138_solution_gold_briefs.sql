-- Human-authored gold-set records (plan 43 Phase 0, "Create the synthetic gold set, its CRUD, and the baseline
-- report").
--
-- System-operational rather than tenant-private: a gold-set brief is an evaluation artifact the platform owns,
-- written by whoever curates quality, and no organization's data is in it. So there is no `organization_id`,
-- no RLS, and exactly one grant — the platform role. `builderhunt_app` is deliberately absent: a tenant request
-- has no business reading the evaluation corpus, and a grant added "so the admin page works" would be the
-- quickest way to make it readable from an ordinary session.
--
-- The synthetic 60 stay in `tests/fixtures/solutions/gold-set.json` and are never inserted here. Two
-- populations, two homes: the synthetic set is version-controlled scaffolding that changes by deploy, while
-- human judgments are edited during a beta by people who should not need one.

CREATE TABLE "solution_gold_briefs" (
	"id" text PRIMARY KEY NOT NULL,
	"authorship" text DEFAULT 'human' NOT NULL,
	"brief_text" text NOT NULL,
	"expected" jsonb NOT NULL,
	"created_by_user_id" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "solution_gold_briefs_authorship_check" CHECK ("solution_gold_briefs"."authorship" in ('synthetic', 'human')),
	CONSTRAINT "solution_gold_briefs_text_length_check" CHECK (char_length("solution_gold_briefs"."brief_text") between 1 and 4000)
);
--> statement-breakpoint
ALTER TABLE "solution_gold_briefs" ADD CONSTRAINT "solution_gold_briefs_created_by_user_id_auth_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."auth_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "solution_gold_briefs_authorship_idx" ON "solution_gold_briefs" USING btree ("authorship","created_at");--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "solution_gold_briefs" TO "builderhunt_platform";
