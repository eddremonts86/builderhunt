-- Custom SQL migration file, put your code below! --

-- Per-role statement and idle-in-transaction timeouts (plan 55 phase 3).
--
-- ## Why per role and not one global GUC
--
-- A single `statement_timeout` in `postgresql.conf` has to be loose enough for the slowest legitimate query
-- in the system, which is a worker sweep — so it would be 30 s for everyone, and a request-serving backend
-- would hold a connection for thirty seconds after the person waiting on it had already given up. Under load
-- that is the difference between shedding a request and exhausting the pool.
--
-- `ALTER ROLE ... SET` applies at connection time, so each identity gets the bound that matches what it is
-- for, with no application code involved and nothing to forget in a new call path.
--
-- ## The tiers, and the reasoning behind each
--
-- **5 s / 10 s — app, auth, capability.** Request-serving. A query nobody is waiting for any more should not
-- still be holding a backend, and 5 s is already far past the p95 of 1.5 s the load contract targets. The
-- 10 s idle bound is longer than the statement bound on purpose: a transaction legitimately spans two
-- statements plus the round trip between them.
--
-- **30 s / 30 s — worker.** A discovery sweep or an embedding batch genuinely runs longer than a page load,
-- and cancelling it at 5 s would turn a working job into a permanent failure that retries into the same wall.
--
-- **15 s / 10 s — platform.** An operator running a report can wait; they should not wait forever. The idle
-- bound stays at 10 s because an admin transaction has no reason to sit open longer than a tenant one.
--
-- `builderhunt_readonly` is deliberately absent: it is the restore/inspection identity, used by a human at a
-- psql prompt, and a timeout there turns a legitimate long analytical query into a mystery cancellation.
--
-- ## Why these are role defaults and not enforced here
--
-- A role default is a starting value a session can raise with `SET`. That is intentional — a migration needs
-- to run DDL longer than 5 s, and it connects as the migration role rather than as any of these. What this
-- migration cannot do is prove the settings take effect, which is why
-- `scripts/db/verify-role-timeouts.mjs` connects as each role and cancels a real query past its budget:
-- a timeout that is set but not enforced looks identical to a correct one until something hangs.

ALTER ROLE builderhunt_app SET statement_timeout = '5s';
--> statement-breakpoint
ALTER ROLE builderhunt_app SET idle_in_transaction_session_timeout = '10s';
--> statement-breakpoint

ALTER ROLE builderhunt_auth SET statement_timeout = '5s';
--> statement-breakpoint
ALTER ROLE builderhunt_auth SET idle_in_transaction_session_timeout = '10s';
--> statement-breakpoint

ALTER ROLE builderhunt_capability SET statement_timeout = '5s';
--> statement-breakpoint
ALTER ROLE builderhunt_capability SET idle_in_transaction_session_timeout = '10s';
--> statement-breakpoint

ALTER ROLE builderhunt_worker SET statement_timeout = '30s';
--> statement-breakpoint
ALTER ROLE builderhunt_worker SET idle_in_transaction_session_timeout = '30s';
--> statement-breakpoint

ALTER ROLE builderhunt_platform SET statement_timeout = '15s';
--> statement-breakpoint
ALTER ROLE builderhunt_platform SET idle_in_transaction_session_timeout = '10s';
