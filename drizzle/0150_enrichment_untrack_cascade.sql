-- Enrichment: untracking a builder must not be blocked by its enrichment data.
--
-- `enrichment_evidence_organization_builder_fk` and `enrichment_jobs_organization_builder_fk` (0016)
-- were ON DELETE NO ACTION. Deleting a whole organization was always safe — both cascades from
-- `organizations` fire in one statement, and a NO ACTION check runs at end-of-statement, by which time
-- the children are gone. Untracking a *single* builder deletes only the `organization_builders` row, so
-- it raised 23503 and `DELETE /api/builders/:id` answered 500 for exactly the people the product had
-- enriched. Found 2026-08-05 by scripts/ops/verify-enrichment-adversarial-local.mjs, case 11.
--
-- Cascading is also correct on its own terms: the lawful basis for holding this evidence is a
-- recruiter's legitimate interest in a candidate they track, and it ends when the tracking does. The
-- other FK on this pair — `enrichment_evidence_organization_job_fk` — deliberately stays NO ACTION,
-- because cascading that one would delete accepted evidence when its job is retired at 90 days and
-- silently shorten the 180-day window the source register promises.
--
-- The two `access_requests_status_check` statements below are NOT part of this change. Migration 0148
-- wrote that CHECK as hand-authored SQL, so drizzle's snapshot never recorded it and every generate
-- since re-emits it. The redefinition is identical to what the constraint already is (verified against
-- the running database), so it is a no-op that finally puts the snapshot and the schema in agreement.
-- Left in rather than stripped out: deleting the SQL while the snapshot claims the constraint exists is
-- how a snapshot silently stops describing the database.

ALTER TABLE "access_requests" DROP CONSTRAINT "access_requests_status_check";--> statement-breakpoint
ALTER TABLE "enrichment_evidence" DROP CONSTRAINT "enrichment_evidence_organization_builder_fk";
--> statement-breakpoint
ALTER TABLE "enrichment_jobs" DROP CONSTRAINT "enrichment_jobs_organization_builder_fk";
--> statement-breakpoint
ALTER TABLE "enrichment_evidence" ADD CONSTRAINT "enrichment_evidence_organization_builder_fk" FOREIGN KEY ("organization_id","builder_identity_id") REFERENCES "public"."organization_builders"("organization_id","builder_identity_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrichment_jobs" ADD CONSTRAINT "enrichment_jobs_organization_builder_fk" FOREIGN KEY ("organization_id","builder_identity_id") REFERENCES "public"."organization_builders"("organization_id","builder_identity_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_status_check" CHECK ("access_requests"."status" in ('pending', 'approved', 'rejected', 'revoked'));