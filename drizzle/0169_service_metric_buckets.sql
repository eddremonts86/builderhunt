-- Custom SQL migration file, put your code below! --

-- Per-minute service metrics, stored as deltas (plan 57, Admin track — "Add truthful historical
-- service-metric storage or adapter").
--
-- ## Why this table exists at all
--
-- `metrics.get()` is cumulative-since-boot and per-instance, and the task's Do line forbids inferring
-- history from it — for two concrete reasons. A deploy resets the counter, so subtracting consecutive
-- reads yields a negative number that either renders as an absurd rate or gets clamped to zero and
-- silently drops a window. And with two instances the reads interleave, so a subtraction crosses
-- instances and describes neither of them.
--
-- Each row here is "what this instance saw during this minute". That sums across instances, and a restart
-- simply starts a new row instead of corrupting the previous one.
--
-- ## Why the latency histogram is counts against fixed boundaries
--
-- A p95 cannot be recovered from stored means: averaging averages loses the distribution, and averaging
-- percentiles is not a percentile of anything. Storing raw samples would be unbounded. Counts against one
-- code-owned boundary list make p50/p95/p99 a matter of summing arrays elementwise across whatever rows
-- the window covers — which is precisely the "reconcile across process restart and multiple instances"
-- the Verify line asks for. The boundaries live in `admin-metrics/history.ts`; changing them is a schema
-- change in effect, and the array length is asserted on write.
--
-- ## Why `route_family` and never a path
--
-- `/api/sprints/<id>` names a real sprint. A path column would publish tenant identifiers into an operator
-- table, and it would let traffic rather than design decide the table's cardinality. The family comes from
-- the fourteen-value allowlist in `admin-metrics/contracts.ts`; anything unrecognised is recorded as
-- `other` rather than stored verbatim.
--
-- ## Why no RLS
--
-- No tenant column and no personal data, so there is no predicate a policy could express — the same
-- rationale as `status_checks`, `access_requests` and `platform_beta_mode`. Access is GRANT-only and
-- deliberately asymmetric: the app writes its own minutes, the platform role reads, and the worker is the
-- only role that may delete.
--
-- The app does hold UPDATE, and the reason is worth stating precisely rather than claiming it does not.
-- A flush lands mid-minute, so the current minute's row is accumulated into with
-- `ON CONFLICT ... DO UPDATE SET requests = requests + excluded.requests` — additive, never replacing. So
-- no role can *set* a past value; the only write is "add what just happened to the minute it happened in".
-- That is the property worth having, and it is enforced by the one code path that writes here rather than
-- by the grant, which cannot express it.

CREATE TABLE IF NOT EXISTS "service_metric_buckets" (
  "bucket_start" timestamp with time zone NOT NULL,
  "route_family" text NOT NULL,
  "instance" text NOT NULL,
  "deployment" text NOT NULL,
  "requests" integer NOT NULL DEFAULT 0,
  "errors" integer NOT NULL DEFAULT 0,
  "searches" integer NOT NULL DEFAULT 0,
  "search_cache_hits" integer NOT NULL DEFAULT 0,
  "latency_buckets" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "service_metric_buckets_pkey" PRIMARY KEY ("bucket_start", "route_family", "instance"),
  CONSTRAINT "service_metric_buckets_requests_check" CHECK ("requests" >= 0 AND "errors" >= 0),
  CONSTRAINT "service_metric_buckets_searches_check" CHECK ("searches" >= 0 AND "search_cache_hits" >= 0)
);
--> statement-breakpoint

-- The read shape is "a window, then everything in it", and retention deletes by the same leading column,
-- so one index serves both. The primary key already covers the per-minute upsert.
CREATE INDEX IF NOT EXISTS "service_metric_buckets_window_idx"
  ON "service_metric_buckets" ("bucket_start" DESC);
--> statement-breakpoint

-- INSERT plus SELECT for the app: `ON CONFLICT ... DO UPDATE` needs to read the row it is merging into,
-- and `RETURNING` needs SELECT even when the write itself would succeed without it.
GRANT SELECT, INSERT, UPDATE ON "service_metric_buckets" TO builderhunt_app;
--> statement-breakpoint
GRANT SELECT ON "service_metric_buckets" TO builderhunt_platform;
--> statement-breakpoint
GRANT SELECT ON "service_metric_buckets" TO builderhunt_readonly;
--> statement-breakpoint
-- Retention only. The worker is the one role that may forget a minute.
GRANT SELECT, DELETE ON "service_metric_buckets" TO builderhunt_worker;
