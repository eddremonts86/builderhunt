-- The `awaiting_upload` state (plan: calendar-scheduling-interview-intelligence, Phase 6, candidate
-- upload APIs).
--
-- A document row is created when the signed upload URL is issued, not when the bytes arrive: that is
-- what reserves the 25 MB invitation quota, so a client cannot request a hundred intents and then
-- upload against an apparently empty allowance. Two consequences the schema has to carry:
--
--   * the row exists before any bytes do, so `sha256` cannot be NOT NULL — the candidate computes it
--     from what they actually sent. `candidate_documents_sha256_present_check` keeps the nullable
--     window exactly one state wide instead of leaving the column loosely nullable forever.
--   * the worker leases only `pending`, so `awaiting_upload` is what stops a document being scanned
--     before the completion call has confirmed what was written.
--
-- `DOCUMENT_STATUSES` in `src/shared/lib/interviews.ts` already had `pending_upload` as its initial
-- state and already declared `sha256` nullable, so this brings the table in line with the contract
-- the DTO layer has been describing all along rather than introducing a new idea.
--
-- Safe on a live table: dropping and re-adding a CHECK takes a brief ACCESS EXCLUSIVE lock and
-- validates existing rows, and every existing row is `pending` or later with a hash already set.
ALTER TABLE "candidate_documents" DROP CONSTRAINT "candidate_documents_scan_status_check";--> statement-breakpoint
ALTER TABLE "candidate_documents" DROP CONSTRAINT "candidate_documents_sha256_check";--> statement-breakpoint
ALTER TABLE "candidate_documents" ALTER COLUMN "sha256" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "candidate_documents" ALTER COLUMN "scan_status" SET DEFAULT 'awaiting_upload';--> statement-breakpoint
ALTER TABLE "candidate_documents" ADD CONSTRAINT "candidate_documents_sha256_present_check" CHECK ("candidate_documents"."scan_status" = 'awaiting_upload' or "candidate_documents"."sha256" is not null);--> statement-breakpoint
ALTER TABLE "candidate_documents" ADD CONSTRAINT "candidate_documents_scan_status_check" CHECK ("candidate_documents"."scan_status" in ('awaiting_upload', 'pending', 'scanning', 'clean', 'infected', 'failed'));--> statement-breakpoint
ALTER TABLE "candidate_documents" ADD CONSTRAINT "candidate_documents_sha256_check" CHECK ("candidate_documents"."sha256" is null or "candidate_documents"."sha256" ~ '^[a-f0-9]{64}$');