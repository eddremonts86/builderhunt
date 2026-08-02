-- The seven credentialed job sources (plan 43 Phase 4, deferred until 2026-08-02).
--
-- **Every one is registered `enabled = false`, and that is the whole safety story here.** Four of the seven
-- parse a shape taken from published documentation rather than from a response anyone has seen — the adapter
-- file's header says exactly which — so enabling one is a maintainer act that should be followed immediately
-- by a real run and a look at what landed. `unexpected_response_shape` is a hard failure in the adapter, so a
-- documented shape that turns out to be wrong says so on the first run instead of storing nothing quietly.
--
-- `allowed_fields` is identical across all seven and matches the adapter's `metadataKeys` exactly.
-- `check-adapter-field-parity` compares the two, because `filterToAllowedFields` drops silently by design: a
-- naming mismatch would report a successful run that stored an empty object. That check is what caught
-- Hugging Face's `pipeline_tag` vs `pipelineTag` before.
--
-- Three of the seven need no secret at all:
--
--   jobtech_dev_jobs      Sweden's public employment service. Probed live 2026-08-02, no key needed.
--   themuse_jobs          Page 1 answers unauthenticated; a key only raises the rate limit.
--   arbeitsagentur_jobs   Uses `X-API-Key: jobboerse-jobsuche`, the public client key their own web app sends.
--
-- They are registered here anyway because they arrived in the same batch and share the adapter.

INSERT INTO "solution_sources" (
  key, kind, label, homepage_url, enabled, allowed_fields, geography, rate_limit_per_hour,
  refresh_interval_hours, retention_days, register_notes, attribution_required
) VALUES
  (
    'jobtech_dev_jobs', 'feed', 'JobTech Dev (Arbetsförmedlingen)', 'https://jobsearch.api.jobtechdev.se', false,
    '["roleTitle","companyName","area","summary","postingUrl","publishedAt","remote","employmentType","seniority","salaryMin","salaryMax","salaryCurrency","tags"]'::jsonb,
    'SE', 600, 12, 60,
    'Swedish Public Employment Service open API. Probed live 2026-08-02: no key required, full hit shape inspected and the parser written against it. JOBTECH_DEV_API_KEY is optional and raises limits only. Taxonomy labels are stored, never concept ids — an id like fg7B_yov_smw matches nothing a person would type.',
    false
  ),
  (
    'themuse_jobs', 'feed', 'The Muse', 'https://www.themuse.com', false,
    '["roleTitle","companyName","area","summary","postingUrl","publishedAt","remote","employmentType","seniority","salaryMin","salaryMax","salaryCurrency","tags"]'::jsonb,
    'global', 100, 12, 60,
    'Probed live 2026-08-02: page 1 answers without a key and the full result shape was inspected. MUSE_API_KEY raises the rate limit. Descriptions are HTML and go through htmlToPlainText. Remote is inferred from a location named "Flexible / Remote" because there is no flag.',
    false
  ),
  (
    'arbeitsagentur_jobs', 'feed', 'Bundesagentur für Arbeit', 'https://rest.arbeitsagentur.de', false,
    '["roleTitle","companyName","area","summary","postingUrl","publishedAt","remote","employmentType","seniority","salaryMin","salaryMax","salaryCurrency","tags"]'::jsonb,
    'DE', 300, 12, 60,
    'Probed live 2026-08-02 with X-API-Key: jobboerse-jobsuche, the public client key their own web app sends. The search payload carries no description at all — only title, employer and place — so summary is null rather than padded with the title. Full text would need a second call per posting, which is a rate-limit decision nobody has made.',
    false
  ),
  (
    'adzuna_jobs', 'feed', 'Adzuna', 'https://api.adzuna.com', false,
    '["roleTitle","companyName","area","summary","postingUrl","publishedAt","remote","employmentType","seniority","salaryMin","salaryMax","salaryCurrency","tags"]'::jsonb,
    'global', 250, 24, 60,
    'NEVER RUN. Shape from the published field list on developer.adzuna.com; needs ADZUNA_APP_ID and ADZUNA_APP_KEY. Country is part of the path (ADZUNA_COUNTRY, default gb) — a wrong country returns a valid-looking page of the wrong market. salary_is_predicted marks Adzuna''s own model output rather than the employer''s figure, and a predicted salary is dropped rather than stored: it would feed a cost estimate the employer never stated.',
    false
  ),
  (
    'usajobs_jobs', 'feed', 'USAJOBS', 'https://data.usajobs.gov', false,
    '["roleTitle","companyName","area","summary","postingUrl","publishedAt","remote","employmentType","seniority","salaryMin","salaryMax","salaryCurrency","tags"]'::jsonb,
    'US', 300, 24, 60,
    'NEVER RUN. Shape from the published SearchResult.SearchResultItems[].MatchedObjectDescriptor envelope; a probe on 2026-08-02 returned 401, which confirms only that Authorization-Key is required. USAJOBS_USER_AGENT is not decoration — their terms require a contact address in the User-Agent. Currency is asserted as USD, the one place it can be without guessing.',
    false
  ),
  (
    'france_travail_jobs', 'feed', 'France Travail', 'https://api.francetravail.io', false,
    '["roleTitle","companyName","area","summary","postingUrl","publishedAt","remote","employmentType","seniority","salaryMin","salaryMax","salaryCurrency","tags"]'::jsonb,
    'FR', 200, 24, 60,
    'NEVER RUN, and not yet runnable. Shape from the published Offres d''emploi v2 documentation; a probe on 2026-08-02 returned 401. Their auth is OAuth2 client-credentials, so the token is short-lived and cannot be a static environment variable — the adapter reads FRANCE_TRAVAIL_ACCESS_TOKEN as a bearer, which means something else must mint it, and that exchange is NOT implemented. salaire.libelle is free text and is deliberately not regex-mined.',
    false
  ),
  (
    'infojobs_jobs', 'feed', 'InfoJobs', 'https://api.infojobs.net', false,
    '["roleTitle","companyName","area","summary","postingUrl","publishedAt","remote","employmentType","seniority","salaryMin","salaryMax","salaryCurrency","tags"]'::jsonb,
    'ES', 200, 24, 60,
    'NEVER RUN. Shape from the published v9 offer documentation; a probe on 2026-08-02 returned 401. Auth is HTTP Basic over INFOJOBS_CLIENT_ID:INFOJOBS_CLIENT_SECRET, built at request time rather than stored pre-encoded.',
    false
  )
ON CONFLICT (key) DO NOTHING;
