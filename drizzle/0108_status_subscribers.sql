-- Plan 47 (status-and-trust) Phase 2: status subscribers.
--
-- Why a separate table from a generic "newsletter" or "marketing list":
-- the legal posture is different. An incident subscriber opted in to
-- receiving a specific kind of transactional email (their email address
-- was captured at /status, their consent is for "tell me when this site
-- is broken", and the unsubscribe is one click). Marketing email is
-- consent for a different purpose and lives in a different system.
-- Mixing them invites a privacy footgun: an admin who wants to clean up
-- a stale marketing list would also delete incident subscribers, and an
-- export for "all email we have" would mix the two without a join.
--
-- `unsubscribe_token_hash` is a 32-byte random base64url string stored as
-- the SHA-256 of itself. The token in the unsubscribe URL is the raw
-- value; the row is keyed by the hash, so a leak of the database does
-- not yield working unsubscribe links (mirror of plan 28's feed-capability
-- anti-enumeration contract).
--
-- `confirmed_at` distinguishes a typed-email-and-clicked-confirm
-- subscriber from a typo. We do not send to unconfirmed rows; the
-- /api/status/subscribe endpoint auto-confirms (double-opt-in is the
-- safer default but the task spec asked for "plain-text emails on
-- subscribe", and a "you are now subscribed" email + the ability to
-- unsubscribe is the minimum viable consent receipt).

CREATE TABLE IF NOT EXISTS "status_subscribers" (
  "id" text PRIMARY KEY,
  "email" text NOT NULL,
  "email_lower" text NOT NULL,
  "unsubscribe_token_hash" text NOT NULL,
  "confirmed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "unsubscribed_at" timestamp with time zone,
  CONSTRAINT "status_subscribers_email_unique" UNIQUE ("email_lower")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "status_subscribers_confirmed_idx"
  ON "status_subscribers"
  USING btree ("confirmed_at")
  WHERE "unsubscribed_at" IS NULL;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "status_subscribers" TO "builderhunt_app";
