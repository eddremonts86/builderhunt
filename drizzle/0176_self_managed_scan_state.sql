ALTER TABLE "self_managed_attachments" DROP CONSTRAINT "self_managed_attachments_size_check";--> statement-breakpoint
ALTER TABLE "self_managed_attachments" DROP CONSTRAINT "self_managed_attachments_checksum_check";--> statement-breakpoint
ALTER TABLE "self_managed_attachments" ALTER COLUMN "size_bytes" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "self_managed_attachments" ALTER COLUMN "checksum_sha256" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "self_managed_attachments" ADD COLUMN "scan_status" text DEFAULT 'awaiting_upload' NOT NULL;--> statement-breakpoint
ALTER TABLE "self_managed_attachments" ADD COLUMN "scan_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "self_managed_attachments" ADD COLUMN "rejection_code" text;--> statement-breakpoint
ALTER TABLE "self_managed_attachments" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "self_managed_attachments_scan_status_idx" ON "self_managed_attachments" USING btree ("scan_status");--> statement-breakpoint
ALTER TABLE "self_managed_attachments" ADD CONSTRAINT "self_managed_attachments_scan_status_check" CHECK ("self_managed_attachments"."scan_status" in ('awaiting_upload', 'pending', 'scanning', 'clean', 'infected', 'failed'));--> statement-breakpoint
ALTER TABLE "self_managed_attachments" ADD CONSTRAINT "self_managed_attachments_checksum_present_check" CHECK ("self_managed_attachments"."scan_status" = 'awaiting_upload' or "self_managed_attachments"."checksum_sha256" is not null);--> statement-breakpoint
ALTER TABLE "self_managed_attachments" ADD CONSTRAINT "self_managed_attachments_size_present_check" CHECK ("self_managed_attachments"."scan_status" = 'awaiting_upload' or "self_managed_attachments"."size_bytes" is not null);--> statement-breakpoint
ALTER TABLE "self_managed_attachments" ADD CONSTRAINT "self_managed_attachments_rejection_check" CHECK (("self_managed_attachments"."scan_status" in ('infected', 'failed')) = ("self_managed_attachments"."rejection_code" is not null));--> statement-breakpoint
ALTER TABLE "self_managed_attachments" ADD CONSTRAINT "self_managed_attachments_size_check" CHECK ("self_managed_attachments"."size_bytes" is null or ("self_managed_attachments"."size_bytes" > 0 and "self_managed_attachments"."size_bytes" <= 26214400));--> statement-breakpoint
ALTER TABLE "self_managed_attachments" ADD CONSTRAINT "self_managed_attachments_checksum_check" CHECK ("self_managed_attachments"."checksum_sha256" is null or "self_managed_attachments"."checksum_sha256" ~ '^[0-9a-f]{64}$');--> statement-breakpoint

-- Hand-written from here (plan: phase-2/07-perfiles-autogestionados, "Extend the existing quarantine
-- and scanning pipeline for profile attachments").
--
-- Rows written before this migration predate the scan pipeline entirely — the repository's old
-- contract said "bytes already stored and scanned", but nothing ever scanned them, because nothing
-- could. ADD COLUMN has just stamped them `awaiting_upload`, which is a lie in the other direction:
-- their bytes exist. `pending` is the honest state — stored, unverified — and it is fail-closed:
-- the worker will scan them before the new public-read policy ever exposes them.
UPDATE "self_managed_attachments" SET "scan_status" = 'pending' WHERE "checksum_sha256" IS NOT NULL;--> statement-breakpoint

-- The public-read policy gains the scan predicate. The spec's rule is "recently uploaded attachments
-- stay `pending` and are not served until the scan says `clean`", and a policy that ignored the scan
-- would leave that rule resting entirely on every query remembering the filter. The owner policy is
-- untouched: owners see their own pending and rejected rows, which is how an editor can show
-- "scanning…" and "rejected" states at all.
DROP POLICY "self_managed_attachments_public_select" ON "self_managed_attachments";--> statement-breakpoint
CREATE POLICY "self_managed_attachments_public_select" ON "self_managed_attachments"
	FOR SELECT TO "builderhunt_app"
	USING ("deleted_at" IS NULL AND "scan_status" = 'clean' AND EXISTS (
		SELECT 1 FROM "self_managed_profiles" p
		WHERE p."id" = "self_managed_attachments"."profile_id"
		  AND p."visibility" in ('public', 'unlisted')
		  AND p."deleted_at" IS NULL
	));--> statement-breakpoint

-- `0175` granted the worker SELECT/UPDATE/DELETE on all three tables and its comment claimed the
-- role "bypasses RLS through its own role". It does not: `builderhunt_worker` is NOBYPASSRLS (see
-- `scripts/db/roles.sql`), the tables are FORCE RLS, and a role with grants but no policy gets an
-- empty result, not an error — the failure mode `0085` warns about by name. Every worker on these
-- tables (the scan pipeline this migration unblocks, the retention sweep, the reservation sweep)
-- needs what `candidate_documents` gave its worker in `0085`: explicit per-operation policies.
CREATE POLICY "self_managed_attachments_worker_select" ON "self_managed_attachments"
	FOR SELECT TO "builderhunt_worker" USING (true);--> statement-breakpoint
CREATE POLICY "self_managed_attachments_worker_update" ON "self_managed_attachments"
	FOR UPDATE TO "builderhunt_worker" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "self_managed_attachments_worker_delete" ON "self_managed_attachments"
	FOR DELETE TO "builderhunt_worker" USING (true);--> statement-breakpoint

CREATE POLICY "self_managed_profiles_worker_select" ON "self_managed_profiles"
	FOR SELECT TO "builderhunt_worker" USING (true);--> statement-breakpoint
CREATE POLICY "self_managed_profiles_worker_update" ON "self_managed_profiles"
	FOR UPDATE TO "builderhunt_worker" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "self_managed_profiles_worker_delete" ON "self_managed_profiles"
	FOR DELETE TO "builderhunt_worker" USING (true);--> statement-breakpoint

CREATE POLICY "self_managed_handle_reservations_worker_select" ON "self_managed_handle_reservations"
	FOR SELECT TO "builderhunt_worker" USING (true);--> statement-breakpoint
CREATE POLICY "self_managed_handle_reservations_worker_delete" ON "self_managed_handle_reservations"
	FOR DELETE TO "builderhunt_worker" USING (true);