-- Custom SQL migration file, put your code below! --
-- Registers the public job-feed APIs, and adds the columns their terms make load-bearing.
--
-- Source: docs/operations/source-register.md and the landscape review the maintainer supplied. Every
-- endpoint below was probed live on 2026-08-01 before being written here — the review is a year-scale
-- document and these APIs change, so what is recorded is what answered, not what was claimed.
--
-- ## Why attribution needs columns
--
-- Three of these APIs state their terms *inside the response body*, and two of them make continued access
-- conditional on us honouring an attribution obligation:
--
--   RemoteOK: "Please link back (with follow, and without nofollow!) to the URL on Remote OK and mention
--             Remote OK as a source ... If you do not we'll have to suspend API access."
--   Jobicy:   "Please ensure Jobicy is clearly credited with a direct link to the source, and all
--             application buttons redirect to the original job URL provided in this feed."
--
-- `register_notes` already existed and would have held that text, but a note is prose: no code can read
-- it, so a UI could render results with no link-back and we would silently lose access. These are
-- structured columns so the obligation travels with the data to whatever renders it, and the CHECK below
-- makes the pair inseparable — a source cannot claim to require attribution without saying what to show.
--
-- `max_requests_per_day` exists because `rate_limit_per_hour` cannot express Remotive's limit of four
-- requests per *day*: as a whole number of requests per hour that rounds to zero, which reads as "no
-- limit recorded" rather than "a very low limit".

ALTER TABLE "solution_sources"
  ADD COLUMN "attribution_required" boolean DEFAULT false NOT NULL,
  ADD COLUMN "attribution_text" text,
  ADD COLUMN "attribution_url" text,
  ADD COLUMN "max_requests_per_day" integer;

ALTER TABLE "solution_sources"
  ADD CONSTRAINT "solution_sources_attribution_complete_check"
  CHECK ("attribution_required" = false OR ("attribution_text" IS NOT NULL AND "attribution_url" IS NOT NULL));

-- ── Feeds with an adapter, ready to enable ──────────────────────────────────────────────────────
--
-- All four share one `allowed_fields` list, because they share one adapter: `createJobFeedAdapter` emits the
-- same thirteen keys for every feed and leaves the ones a given source does not provide as null. Narrowing a
-- register entry to only the fields *that* source happens to populate reads as tighter but is not — the
-- adapter would still emit the others, `assertAdapterFieldsAreRegistered` would report them as silently
-- dropped, and the next person would have to work out whether that was intentional. It caught exactly this
-- while these four were being written.
--
-- All four ship disabled, like every other solutions source: enabling one is an explicit operator act.
-- Each contributes `human_role` components — an employer describing a role it wants filled — exactly as
-- Jobindex does, and never candidate data.

INSERT INTO "solution_sources"
  ("key", "kind", "label", "homepage_url", "enabled", "allowed_fields", "geography",
   "rate_limit_per_hour", "max_requests_per_day", "refresh_interval_hours", "retention_days",
   "attribution_required", "attribution_text", "attribution_url", "register_notes")
VALUES
  -- No auth, no key, no stated attribution requirement. The redirect matters: the documented host
  -- `arbeitnow.com` 301s to `www.arbeitnow.com`, so both are permitted hosts or every request dies on the
  -- first hop.
  ('arbeitnow_jobs', 'feed', 'Arbeitnow (EU + remote)', 'https://www.arbeitnow.com', false,
   '["roleTitle","companyName","area","summary","postingUrl","publishedAt","remote","employmentType","seniority","salaryMin","salaryMax","salaryCurrency","tags"]'::jsonb,
   'eu', 60, 24, 6, 90, false, NULL, NULL,
   'Public job-board API, no auth (https://www.arbeitnow.com/blog/job-board-api). Probed 2026-08-01: 175 postings, no stated attribution requirement. Europe and remote, with a visa_sponsorship filter. arbeitnow.com 301-redirects to www.arbeitnow.com.'),

  -- Attribution is a condition of access, in their own words.
  ('remoteok_jobs', 'feed', 'Remote OK', 'https://remoteok.com', false,
   '["roleTitle","companyName","area","summary","postingUrl","publishedAt","remote","employmentType","seniority","salaryMin","salaryMax","salaryCurrency","tags"]'::jsonb,
   'global', 60, 24, 6, 90, true,
   'Jobs from Remote OK', 'https://remoteok.com',
   'Public API, no auth. Their terms, served in the response body: "Please link back (with follow, and without nofollow!) to the URL on Remote OK and mention Remote OK as a source ... If you do not we''ll have to suspend API access." The logo is a registered trademark and must not be used; the name may be. Probed 2026-08-01: 100 postings. Note their titles arrive double-encoded (UTF-8 read as latin-1) for non-ASCII languages — the adapter repairs this.'),

  ('jobicy_jobs', 'feed', 'Jobicy', 'https://jobicy.com', false,
   '["roleTitle","companyName","area","summary","postingUrl","publishedAt","remote","employmentType","seniority","salaryMin","salaryMax","salaryCurrency","tags"]'::jsonb,
   'global', 60, 24, 6, 90, true,
   'Jobs from Jobicy', 'https://jobicy.com',
   'Public REST API v2, no auth. Their terms, served in the response body: "Please ensure Jobicy is clearly credited with a direct link to the source, and all application buttons redirect to the original job URL provided in this feed." The second half is a product constraint, not just a credit: an apply button must go to their URL. Probed 2026-08-01.'),

  ('himalayas_jobs', 'feed', 'Himalayas', 'https://himalayas.app', false,
   '["roleTitle","companyName","area","summary","postingUrl","publishedAt","remote","employmentType","seniority","salaryMin","salaryMax","salaryCurrency","tags"]'::jsonb,
   'global', 60, 24, 6, 90, false, NULL, NULL,
   'Public JSON API, no auth. Probed 2026-08-01: 96218 postings reported, paginated by offset/limit. Richest structured fields of the four — employment type, seniority, salary band, location and timezone restrictions.')
ON CONFLICT ("key") DO NOTHING;

-- ── Registered, and deliberately without an adapter ─────────────────────────────────────────────
--
-- Remotive's terms conflict with what this product is. Recorded verbatim rather than summarised, because
-- the decision about whether BuilderHunt falls under that clause belongs to the maintainer and needs the
-- exact wording, not a paraphrase of it.
INSERT INTO "solution_sources"
  ("key", "kind", "label", "homepage_url", "enabled", "allowed_fields", "geography",
   "max_requests_per_day", "refresh_interval_hours", "retention_days",
   "attribution_required", "attribution_text", "attribution_url", "register_notes")
VALUES
  ('remotive_jobs', 'feed', 'Remotive', 'https://remotive.com', false,
   '[]'::jsonb, 'global', 4, 24, 90, true,
   'Jobs from Remotive', 'https://remotive.com',
   'NO ADAPTER, and not a technical gap. Their terms, served in the response body, include: "Displaying our jobs in order to collect signups/email addresses to show a listing constitutes a breach of our terms of services." BuilderHunt is a product people sign up for, so whether that clause covers us is a judgement with real consequences (their private API starts at $5k/mo) and belongs to the maintainer, not to this migration. Also: max 4 requests/day, mandatory link-back, and a deliberate 24h delay on the data. allowed_fields is empty so nothing can be stored even if an adapter appeared.'),

  -- Consistent with how LinkedIn is treated: an undocumented internal endpoint is not an offered API.
  ('thehub_startups', 'public_scrape', 'The Hub (Nordic startups)', 'https://thehub.io', false,
   '[]'::jsonb, 'nordics', NULL, 24, 90, false, NULL, NULL,
   'NO ADAPTER. thehub.io has an internal JSON endpoint that third-party scrapers use, but an undocumented internal endpoint is not a published API — the same reasoning that keeps LinkedIn adapter-less. Registered as public_scrape so solution_sources_scrape_needs_review_check requires a recorded terms review before it can ever be enabled. Founder names and LinkedIn links appear in its data, which makes it personal data and not merely company data.')
ON CONFLICT ("key") DO NOTHING;
