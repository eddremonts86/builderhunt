# Tasks: Devpost Integration

> **Status**: `implemented — dark by default`
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: Blocking decision made 2026-07-25 (product owner): option (b), approve
> scraping via a headless-browser ingestion worker, per this session's confirmed choice
> ("Headless browser worker en el VPS"). Built end-to-end and live-verified against the
> real site. `DEVPOST_ENABLED` defaults to `false` in every environment — the code ships
> inert; turning it on in production is a separate, deliberate follow-up (see bottom).

- [x] **Make the blocking decision: skip / approve scraping / re-check** — decided
  2026-07-25: **(b) approve scraping**, as a background ingestion worker (not a live
  connector — Devpost cannot support per-search latency).

- [x] **Build the ingestion worker + durable storage + thin connector**
  - Files: `src/shared/lib/db/schema.ts` (`devpostProfiles`, `devpostIngestionState`),
    `drizzle/0050_odd_charles_xavier.sql` (tables), `drizzle/0051_devpost_tables_grants.sql`
    (grants), `drizzle/0052_mushy_veda.sql` (`topics` column added after live testing
    exposed a real design gap — see below), `src/shared/lib/repositories/devpost-profiles.ts`,
    `src/lib/devpost/{keywords,scraper,worker}.ts`, `src/routes/api/admin/devpost/run-worker.ts`,
    `src/lib/sources/devpost.ts`, `src/lib/search.ts`, `src/lib/score.ts`,
    `src/lib/sources/types.ts`, `src/modules/landing/components/BrandIcons.tsx` (+
    `SearchPage.tsx`/`PersonResultCard.tsx` wiring), `src/shared/styles/globals.css`
    (`.badge-devpost`), `src/shared/lib/env.ts` (`DEVPOST_*`), `.env.example`, `Dockerfile`
    (Chromium install step), `vite.config.ts` (exclude `playwright` from dep
    optimization/SSR bundling — it hit the exact same native-binary crash `@resvg/resvg-js`
    already had a fix for), `package.json` (`playwright` moved dev→prod dependency),
    `docs/operations/deploy-runbook.md`.
  - Do: durable store follows the existing `builder_embeddings`/`discovery_state` pattern
    (global, non-tenant, written via `publicDb` = the `builderhunt_app` role) rather than
    reusing `builder_identities` — that table only gets populated when a user tracks a
    result and has no column for the search-time metadata (project count, discovery
    topic) Devpost needs before anyone has tracked anything. Worker launches headless
    Chromium (`playwright`), scrapes one page of search results for a rotating keyword
    (`src/lib/devpost/keywords.ts`), visits each project's team page, then each new
    member's profile, upserting into `devpost_profiles` — capped per run
    (`DEVPOST_PROJECTS_PER_RUN`/`DEVPOST_PROFILES_PER_RUN`) with a politeness delay
    (`DEVPOST_REQUEST_DELAY_MS`) between navigations, per-item error isolation (one bad
    project/profile never aborts the run), cursor persisted in `devpost_ingestion_state`.
    `src/lib/sources/devpost.ts` only ever reads the durable table — never scrapes live.
  - Verify: `pnpm tsc --noEmit`, `pnpm eslint .` (0 errors), `pnpm vitest run` (2006/2006
    passing, unchanged — no new tests added, matching this codebase's established
    convention of zero unit-test coverage for external-API connectors). Live-verified
    locally end to end: applied migrations against the local dev Postgres, ran the worker
    via `POST /api/admin/devpost/run-worker` with `DEVPOST_ENABLED=true` and a real
    `CRON_SECRET`, confirmed real Devpost people landed in `devpost_profiles` (`psql`
    query showing real usernames/display names/project counts), then confirmed a real
    authenticated `POST /api/search/builders` with `sources: ["github","devpost"]`
    returns real Devpost person cards (8 results, correct `topics`, correct scores 44-45,
    real avatar URLs) — the full search flow works end to end at the data/API layer.
    `DEVPOST_ENABLED` reverted to `false` in the local `.env` afterward (matches the
    committed default everywhere).

  - **Real findings from live testing (not guessed, discovered by actually running it):**
    - Devpost serves an initial `202` bot-challenge to a **real headless browser too**,
      not just plain `fetch` — its own client-side JS auto-resolves the challenge and
      reloads the same URL a moment later (same experience a real user's browser would
      have). `waitUntil: 'domcontentloaded'` alone races that reload and throws
      Playwright's "Execution context was destroyed" — fixed by settling on `load` +
      `waitForLoadState('networkidle')` + a short buffer, plus a one-retry wrapper
      (`withChallengeRetry` in `scraper.ts`) for the rare case the reload still lands
      mid-read.
    - **Design gap found and fixed**: the first version matched search keywords against
      a scraped profile's own username/displayName/bio. Devpost bios are frequently
      empty (verified live) and a person's own text rarely restates the hackathon
      project's topic they built for — so keyword search returned zero matches even
      though the worker was scraping real data correctly. Fixed by persisting the
      discovery keyword(s) as a `topics` column (unioned across runs) and matching
      against that too — the same fix any future maintainer would need if extending this
      further.
    - Playwright needed moving from `devDependencies` to `dependencies` (breaks the
      production Docker image otherwise) and excluding from Vite's `optimizeDeps`/`ssr`
      bundling in `vite.config.ts` (its optional `fsevents` native binary crashes Vite's
      dependency optimizer exactly like `@resvg/resvg-js` did — same fix applied).
    - No existing precedent anywhere in this codebase for a production headless-browser
      dependency; the Dockerfile change (`playwright install --with-deps chromium`)
      meaningfully increases image size/build time — documented inline in the Dockerfile
      and in `docs/operations/deploy-runbook.md`.

- [x] **Turn `DEVPOST_ENABLED=true` on — decided 2026-07-25: dev only, not production.**
  - Files: local `.env` (dev), Coolify env config for the `builderhunt` app (prod, untouched)
  - Do: user explicitly declined production activation for now ("no lo actives en
    producción") but asked for it active in local dev immediately, alongside every other
    scraper feature-flag ("junto con todos los scrapers"). Set `DEVPOST_ENABLED=true` and
    `ENRICHMENT_ENABLED=true` (the only other kill-switched scraper — public-profile
    enrichment, plan `stealth-scraping`; its `github` connector is already `enabled` in
    `docs/operations/public-enrichment-source-register.md`, reviewed 2026-07-20, so
    enabling it locally has no outstanding compliance gate) in the local `.env`.
  - Verify: restarted the local dev server (env validation passed with both flags true),
    confirmed both workers actually run: `POST /api/admin/devpost/run-worker` →
    `{"ok":true,"disabled":false,...}` with real progress (page 3 of "open source", 8
    profiles upserted, 0 errors); `POST /api/admin/enrichment/run-worker` →
    `{"ok":true,"disabled":false,...}` (0 claimed — no queued enrichment jobs right now,
    which is expected since that worker drains a job queue rather than crawling
    standalone; `disabled:false` confirms the flag itself is live).
  - Production stays `DEVPOST_ENABLED=false` — turning it on there remains a separate,
    future decision (real outbound scraping traffic from the production VPS, no
    published rate limit, real IP-ban risk), not something to bundle into this decision.
