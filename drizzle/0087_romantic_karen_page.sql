-- Retry counters for the candidate-document worker (plan:
-- calendar-scheduling-interview-intelligence, Phase 6, "Implement document repository and worker").
--
-- The cap these feed is the only thing separating "retry later" from an infinite loop. A transient
-- scan or extraction failure returns the row to `pending`; with no durable count, an object the
-- scanner can never read would be re-leased and re-scanned forever.
--
-- Safe to apply on a live table: a non-volatile DEFAULT makes ADD COLUMN a catalogue-only change in
-- Postgres 11+, so no rewrite and no long ACCESS EXCLUSIVE hold. The existing grants on
-- `candidate_documents` are table-level (0085), so both columns are covered without touching them.
ALTER TABLE "candidate_documents" ADD COLUMN "scan_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "candidate_documents" ADD COLUMN "extraction_attempts" integer DEFAULT 0 NOT NULL;