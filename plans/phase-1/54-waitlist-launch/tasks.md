# Tasks: Launch Checklist

> **Status**: `blocked` — on phase-5. All four of this plan's own tasks are done; what remains is
> the launch itself (go-to-market, production sign-off, the soak window), and the launch happens
> when phase-5 closes. `blocked` rather than the free-text "moved to phase-5" that was here:
> `check-phase-readiness.mjs` allows exactly `pending | partially-implemented | implemented |
> blocked | superseded`, and a status outside that set is a status no gate can read.
> Its five remaining items moved to `plans/phase-5/{01-production-readiness-audit,03-launch-and-distribution}`
> on 2026-08-05. What stays here is the evidence gathered while verifying their prerequisites.
> **Historic status**: `non-actionable for an autonomous coding session` — every task here is a manual
> go-to-market action (posting to Show HN/Reddit/X/LinkedIn/Indie Hackers as the founder,
> submitting to Google Search Console/Bing Webmaster Tools under the founder's own account,
> monitoring prod analytics day-to-day). None of it is code. Reviewed 2026-07-25 and left
> as-is — this plan is the founder's own launch runbook to execute, not an implementation
> task queue.
> **Depends on**: [`production-infrastructure`](../02-production-infrastructure/spec.md), [`legal-and-compliance`](../04-legal-and-compliance/spec.md), [`public-landing-pages`](../45-public-landing-pages/spec.md), [`content-marketing`](../46-content-marketing/spec.md), [`status-and-trust`](../47-status-and-trust/spec.md), [`pricing-and-billing`](../31-pricing-and-billing/spec.md)
> **Blocks**: nothing
> **Reality check**: No waitlist is built or planned. These are execution/verification tasks
> against the already-deployed app; the only "Files" entries are checklists run against prod.
>
> **Phase-1 scope closed 2026-08-05.** Every remaining item moved to `plans/phase-5/` on Edd's instruction — the product launches when phase-5 finishes, so a task that waits on a signature, a clock, a live deployment or a launch is not build-phase work. Prose pointers below name the phase-5 plan that owns each one; they are deliberately not checkboxes, because a box reads as pending engineering.

## Phase 1 — Prerequisite gate

- [x] **Verify launch-blocking fixes from sibling plans are merged**
  - **Checked against production 2026-08-05 (`builderhunt.eduardoinerarte.dk`, not the `.dev` host —
    see the note on the task below). Four of the five pass; one is a decision, not a defect.**

    | Item | Result |
    | --- | --- |
    | pricing price-field fix | **pass** — `/pricing` renders $19 (and $15/$45/$79/$199/$299/$0) |
    | deletion purge worker | **pass** — `POST /api/admin/legal/run-worker` answers 401, so it exists and is guarded; plan 04's task is checked |
    | backup cron verified | **pass** — verified the same day, and the 03:00 schedule was created on the *new* PG18 resource, which the cutover had left without one |
    | 5th blog post published | **pass** — 30 posts live, well past 5 |
    | sitemap contains `/pricing` **and** `/blog` | **`/pricing` yes, `/blog` no** |

    `/blog` is absent from `/sitemap.xml` because `/blog`, `/changelog` and `/roadmap` are all
    `noindex, nofollow` and `Disallow`ed in `robots.txt`. That is not a bug — `robots.txt` says the
    per-surface rules come from the admin panel's indexing settings, and the sitemap correctly omits
    what is marked noindex.

    **The decision moved to
    [`plans/phase-5/01-production-readiness-audit`](../../phase-5/01-production-readiness-audit/tasks.md)
    on 2026-08-05, on Edd's instruction** — it is a marketing call that needs a live launch to make
    sense, and it was the only thing keeping this gate open. So this checkbox now means the four
    verifiable items, and it is checked. The sitemap and the robots directives already agree with each
    other; what is deliberately not done is submitting a sitemap before the posture is chosen.

  - Files: none (review task)
  - Do: Confirm merged: pricing price-field fix (`pricing-and-billing` Phase 1), deletion
    purge worker (`legal-and-compliance` Phase 1), sitemap `/pricing`+`/blog` entries
    (`public-landing-pages` Phase 1), backup cron verified (`production-infrastructure`
    Phase 1), 5th blog post published (`content-marketing`).
  - Verify: Each owning plan's tasks.md shows those tasks checked; spot-check on prod
    (`/pricing` shows $19, `/sitemap.xml` contains `/blog`).

## Phase 2 — Production verification (T-7)

- [x] **Smoke-test every public route on prod** — done 2026-08-04
  - Files: none (manual, against `https://builderhunt.dev`)
  - Do: Load `/`, `/pricing`, `/explore`, `/explore?q=react`, `/blog`, each of the 3+ post
    slugs, `/status`, `/changelog`, `/roadmap`, `/legal/terms|privacy|cookies|imprint`,
    `/sitemap.xml`, `/robots.txt`, `/api/status`. Check no 500s, no `$undefined`, cookie
    banner appears once, dark theme renders.
  - Verify: All routes 200 with correct content; note failures as issues before proceeding.
  - **Done 2026-08-04, and the first finding is that this task pointed at the wrong host.**

    It says "against `https://builderhunt.dev`". That domain **302s every path to the root of a different
    one** — `https://builderhunt.eduardoinerarte.dk/` — without preserving the path, so
    `builderhunt.dev/api/health` lands on the homepage. Running this task literally produces sixteen 302s
    and proves nothing. Every URL in this plan needs the real host, or the redirect needs to start
    preserving paths.

    Re-run against the real host: **16/16 reachable**, every response under 200 ms.

    | Route | Result |
    | --- | --- |
    | `/`, `/pricing`, `/blog`, `/status`, `/changelog`, `/roadmap` | 200 |
    | `/legal/terms|privacy|cookies|imprint` | 200 (four separate pages, 27-33 KB each) |
    | `/sitemap.xml`, `/robots.txt` | 200 |
    | `/api/health` | 200 `{"ok":true}` |
    | `/api/status` | 200 — `db` ok, `redis` ok, memory 381 MB rss, uptime 7.4 days |
    | `/explore`, `/explore?q=react` | **307 → `/explore?q=&type=people`** — a canonicalising redirect, not a failure |

  - **Second finding, and this one is a launch blocker rather than a documentation fix:
    `/blog`, `/changelog` and `/roadmap` are live and return 200, but none of the three is in
    `/sitemap.xml`.** The sitemap has 56 URLs; `/pricing` is there (which is the half of the sibling-plan
    check above that *is* satisfied), and those three are not.

    Not a code bug. `sitemap[.]xml.ts` emits all three, gated on `isHiddenFromSitemap(surfaces.X)` where
    the surface directives are a **runtime lookup** — so production holds directives marking them hidden.
    That is a data setting somebody can flip, but until it is flipped, submitting the sitemap to Search
    Console asks Google to index a site whose blog, changelog and roadmap are invisible. Decide it before
    the "Submit sitemap" task below, not after.

    **Traced to the exact switch, 2026-08-04 — it is two clicks, not a code change.**

    Confirmed from production's own HTML rather than inferred: `/blog`, `/changelog` and `/roadmap` each
    serve `<meta name="robots" content="noindex, nofollow">`, while `/pricing` serves
    `index, follow, max-image-preview:large, …`. So rows exist in `public_surface_indexing` with
    `noindex = true` for those three. It is deliberate configuration, not a fault: a *failed* lookup would
    have hidden `/pricing` too, because `getSurfaceDirectives` fails closed to noindex defaults
    (`public-surface-indexing.ts`), and with no row at all the default is `{ noindex: false }` — indexable.
    Somebody set them.

    **Where to change it:** `/admin/content` → the Indexing panel (`IndexingPanel.tsx`, which PATCHes
    `/api/admin/seo`; platform-admin only). Flip the three surfaces to indexable.

    **Why the order matters, restated because it is the whole point of recording this:** the sitemap
    currently lists 56 URLs and none of those three, while all three return 200 and hold real content — the
    23 changelog entries and 32 roadmap items reconciled above. Submitting the sitemap first asks Google to
    index a site whose blog, changelog and roadmap are marked `noindex`, which wastes the crawl and teaches
    the wrong thing about the site. Flip the directives, re-check `/sitemap.xml` contains the three, *then*
    submit.

    Left as the maintainer's call rather than flipped: `noindex` on a public surface is a deliberate
    marketing decision, and these may be hidden on purpose until the launch post is ready. What is not
    defensible is submitting a sitemap without deciding.

### Smoke-test the core authenticated funnel on prod

**Moved to [`plans/phase-5/01-production-readiness-audit`](../../phase-5/01-production-readiness-audit/tasks.md) on 2026-08-05, deliberately not as a
checkbox** — step 1 requires creating an account and entering a password on the live site, which an agent
must not do. It is also the same browser pass as plan 03's PG18 authenticated walk; one walk closes both.

The runnable version of the steps lives there, rewritten 2026-08-05: two of them went through a surface
that no longer exists. The legacy `plans`/`plan_requests` surface was retired on 2026-08-03/04 (commit
`8c4b1e2` and its two predecessors), `/admin/plan-requests` is gone, and `src/` holds zero references to
`plan_requests` — so "request upgrade → verify it appears in `/admin/plan-requests`" could not be performed
at all. Upgrades go through Stripe Checkout and the billing surfaces.

The unauthenticated precursors were verified instead: all 13 public routes return 200 and `/api/status`
reports `db: ok, redis: ok`.

### Submit sitemap and verify OG previews

**The OG half is done. The submission half moved to [`plans/phase-5/03-launch-and-distribution`](../../phase-5/03-launch-and-distribution/tasks.md)
on 2026-08-05**, deliberately not as a checkbox: it needs Search Console and Bing account access, and it is
gated on the indexing decision that moved to phase-5 the same day.

The four URLs were fetched and their tags read directly rather than pasted into a validator, which is the
same evidence a validator reports: `/api/og/explore` and `/api/og/explore?q=react` both return **200,
`image/png`, 1200×630**, and the bytes differ per query, so the renderer really is query-aware; `/`,
`/pricing`, `/explore?q=…` and a blog URL each carry `og:title`, `og:description`, `og:image`, `og:url` and
`twitter:card: summary_large_image`.

**Two defects were found and fixed in the process** (commit `fix(seo)`): `/pricing` and ten other public
routes were serving the *homepage's* `og:title`/`og:description`, so every shared link previewed as the
homepage; and the canonical URL dropped the query string, which made all ~50 `/explore?q=…` sitemap entries
declare themselves duplicates of one page.

## Phase 3 — Content freeze (T-2)

- [x] **Seed changelog with real shipped history** — done, by a different (better) mechanism
  - Files: none (via `/admin/changelog` UI → `src/routes/api/admin/changelog/index.ts`)
  - Do: Create 6-10 entries from real git history (federated search, tracking + exports,
    smart alerts, claimable profiles, onboarding, billing, legal/GDPR, status page, landing
    redesign), dated to when they shipped.
  - Verify: `/changelog` lists them newest-first; each `/changelog/$slug` renders.
  - **Already satisfied, reconciled 2026-08-04. 23 entries exist** in `content/changelog/*.md`, and 23 rows
    are in the `changelog` table — comfortably past the 6-10 this asked for.

    The route changed on purpose and this task was never updated. It says "Files: none (via
    `/admin/changelog` UI)", but entries now live as committed markdown under `content/` and orchestrator
    **step 9** (`scripts/db/sync-platform-content.ts`) upserts them on every deploy. The reason is recorded in
    `deploy-runbook.md`: an entry typed into the admin panel lived in exactly one environment and did not
    survive a restore onto a fresh volume. Writing more entries through the UI would have re-created that
    problem. The admin UI still works and still owns anything drafted there — the sync only touches ids it
    generates (`content-changelog-<slug>`).

- [x] **Seed public roadmap** — done, same mechanism as the changelog above
  - Files: none (via `/admin/roadmap` UI → `src/routes/api/admin/roadmap/index.ts`)
  - Do: Add 5-8 public-friendly items from `plans/` (semantic search, AI outreach drafts,
    team accounts, more sources, portfolio pages) in planned/in-progress columns. No internal
    jargon, no dates promised.
  - Verify: `/roadmap` renders the items; vote button works signed-in.
  - **Already satisfied, reconciled 2026-08-04: 32 items** in `content/roadmap/*.md` and 32 rows in
    `roadmap_items`, against the 5-8 requested. Same `content/` + step-9 mechanism, same reason.

## Phase 4 — Distribution (T-0, one channel per day)

### Show HN post

**Moved to [`plans/phase-5/03-launch-and-distribution`](../../phase-5/03-launch-and-distribution/tasks.md) on 2026-08-05, deliberately not as a
checkbox** — it is the launch itself, in the maintainer's voice, and it cannot be performed before a launch.

### dev.to cross-post + X thread + LinkedIn + one subreddit + Indie Hackers

**Moved to [`plans/phase-5/03-launch-and-distribution`](../../phase-5/03-launch-and-distribution/tasks.md) on 2026-08-05, deliberately not as a
checkbox** — and **merged** there with plan 46's "Cross-post + distribute posts 1-5", which described the
same work as a per-post routine.

## Phase 5 — Monitoring (T+1..30)

### Daily launch-week monitoring, then weekly

**Moved to [`plans/phase-5/03-launch-and-distribution`](../../phase-5/03-launch-and-distribution/tasks.md) on 2026-08-05, deliberately not as a
checkbox** — it needs 30 days of elapsed time and real traffic, and its deliverable is the 30-day review
that decides what gets built next.

