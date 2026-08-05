# Tasks: Launch Checklist

> **Status**: `non-actionable for an autonomous coding session` — every task here is a manual
> go-to-market action (posting to Show HN/Reddit/X/LinkedIn/Indie Hackers as the founder,
> submitting to Google Search Console/Bing Webmaster Tools under the founder's own account,
> monitoring prod analytics day-to-day). None of it is code. Reviewed 2026-07-25 and left
> as-is — this plan is the founder's own launch runbook to execute, not an implementation
> task queue.
> **Depends on**: [`production-infrastructure`](../02-production-infrastructure/spec.md), [`legal-and-compliance`](../04-legal-and-compliance/spec.md), [`public-landing-pages`](../45-public-landing-pages/spec.md), [`content-marketing`](../46-content-marketing/spec.md), [`status-and-trust`](../47-status-and-trust/spec.md), [`pricing-and-billing`](../31-pricing-and-billing/spec.md)
> **Blocks**: nothing
> **Reality check**: No waitlist is built or planned. These are execution/verification tasks
> against the already-deployed app; the only "Files" entries are checklists run against prod.

## Phase 1 — Prerequisite gate

- [ ] **Verify launch-blocking fixes from sibling plans are merged**
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
    what is marked noindex. **It is Edd's marketing decision**, and this checkbox cannot close until
    it is made: either flip those three surfaces to indexable (then `/blog` appears and the gate
    passes), or amend this task to stop requiring `/blog` in the sitemap. Submitting a sitemap
    without deciding is the one option that is not defensible.

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

- [ ] **Smoke-test the core authed funnel on prod**
  - Files: none (manual)
  - Do: Fresh email → sign up → land on `/onboarding/welcome` → complete the 3-step tour →
    run a search → track 3 builders → `/exports` CSV download → request upgrade on `/pricing`
    → verify it appears in `/admin/plan-requests` → delete the test account from
    `/settings/privacy` and cancel the deletion.
  - Verify: Every step succeeds; the plan request and deletion request rows appear and behave.
  - ⚠️ **Rewritten 2026-08-05. Two steps went through a surface that no longer exists; the
    replacement is below and this task is now runnable as written.**

    **Run this, in order.** Steps 1–5 and 8–9 are unchanged; 6–7 are the rewrite.

    1. Fresh email → sign up.
    2. Land on `/onboarding/welcome`; complete the 3-step tour.
    3. Run a search.
    4. Track 3 builders.
    5. `/exports` → download a CSV.
    6. **`/pricing` → "Subscribe to Pro" → tick the disclosure → Stripe Checkout opens.** Complete it
       with a Stripe *test* card if the deployment is in test mode; otherwise cancel and stop at the
       Checkout page. What is being verified is that a Checkout session is created and the return
       lands on `/settings/billing/return`.
    7. **`/settings/billing` shows the subscription as `active` and the organization's entitlement
       changed** (plan tier and the monthly credit grant). There is no admin approval step any more.
    8. `/settings/privacy` → request account deletion.
    9. Cancel the deletion; confirm the account is usable again.

    **Why 6–7 changed:** the legacy `plans`/`plan_requests` surface was retired on 2026-08-03/04
    (commit `8c4b1e2` and its two predecessors). `/admin/plan-requests` is gone and `src/` holds zero
    references to `plan_requests`, so "request upgrade → verify it appears in `/admin/plan-requests`"
    cannot be performed at all. Upgrades go through Stripe Checkout and the billing surfaces, which
    the billing E2E suite already covers in test mode — this task's value is the *human* pass over
    the same path on the real deployment.

    **Operator: this one needs a person, not the agent.** Step 1 requires creating an account and
    entering a password on the live site, which the agent must not do. The unauthenticated
    precursors were verified instead: all 13 public routes 200, `/api/status` reports
    `db: ok, redis: ok`.

  - ⚠️ **Original 2026-08-04 finding, kept for the record:**
    "request upgrade on `/pricing` → verify it appears in `/admin/plan-requests`" cannot be performed: the
    legacy `plans`/`plan_requests` surface was retired on 2026-08-03/04 (commits `8c4b1e2` and its two
    predecessors), the route is gone, and `src/` holds zero references to `plan_requests`. Upgrades now go
    through Stripe Checkout and the billing surfaces.

    Rewrite those two steps before running this: the equivalent verification is a Checkout session reaching
    `active` and the organization's entitlement changing, which the billing E2E already covers in test mode.
    Everything else in this task — sign-up, onboarding, search, tracking, CSV export, account deletion and
    its cancellation — is still exactly right.

- [ ] **Submit sitemap and verify OG previews**
  - **OG half done 2026-08-05; submission half needs you.**

    The four URLs were fetched and their tags read directly rather than pasted into a validator,
    which is the same evidence a validator reports:

    - `/api/og/explore` and `/api/og/explore?q=react` both return **200, `image/png`, 1200×630**, and
      the bytes differ per query, so the renderer really is query-aware.
    - `/`, `/pricing`, `/explore?q=…` and a blog URL each carry `og:title`, `og:description`,
      `og:image`, `og:url` and `twitter:card: summary_large_image`.

    **Two defects were found and fixed in the process** (commit `fix(seo)`): `/pricing` and ten other
    public routes were serving the *homepage's* `og:title`/`og:description`, so every shared link
    previewed as the homepage; and the canonical URL dropped the query string, which made all ~50
    `/explore?q=…` sitemap entries declare themselves duplicates of one page.

    **Still yours:** adding the property in Google Search Console and Bing Webmaster Tools and
    submitting the sitemap. That needs account access, and it is gated on the `/blog` indexing
    decision in the Phase 1 task above — submitting a sitemap that omits `/blog` while `/blog` is
    `noindex` is consistent, but it is a choice worth making deliberately.

  - Files: none (external tools)
  - Do: Add the property in Google Search Console + Bing Webmaster Tools, submit
    `/sitemap.xml`. Paste `/`, `/pricing`, `/explore?q=react`, and one blog URL into the
    X card validator / LinkedIn post inspector / a Slack DM; confirm the PNG OG image renders
    (endpoint: `src/routes/api/og/explore.tsx`).
  - Verify: GSC shows sitemap "Success"; all 4 URLs show image + title + description previews.

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

- [ ] **Show HN post**
  - Files: none
  - Do: "Show HN: BuilderHunt – find active developers across 12 sources (GitHub, HN,
    Stack Overflow…)". First comment: honest write-up — what it does, stack (TanStack Start +
    Postgres, single Hetzner VPS), what feedback is wanted (search relevance, sources to add).
    Post morning US time, stay available all day to reply.
  - Verify: Post live; every top-level comment answered within 2h; feedback captured as issues.

- [ ] **dev.to cross-post + X thread + LinkedIn + one subreddit + Indie Hackers**
  - Files: none
  - Do: dev.to: cross-post "Why I built BuilderHunt" (`content/posts/why-i-built-builderhunt.md`)
    with `canonical_url` set to the builderhunt.dev URL. X: 6-8 tweet thread (problem → 12
    sources screenshot → tracking/alerts → link). LinkedIn: recruiter-angle summary. Reddit:
    r/ExperiencedDevs or r/webdev per sub self-promo rules. Indie Hackers: launch milestone.
    Stagger one per day after HN.
  - Verify: Each post live with working links; UTM-tagged links (`?utm_source=devto` etc.) so
    referrers show in analytics/server logs.

## Phase 5 — Monitoring (T+1..30)

- [ ] **Daily launch-week monitoring, then weekly**
  - Files: none
  - Do: Check `/admin/metrics` (signups, searches, errors), `/status`, Search Console
    impressions; reply to every feedback comment; file real bugs/requests into `plans/` or
    issues; publish a weekly changelog entry.
  - Verify: 30-day review written up: signups vs 200 target, activation rate
    (`onboarding_progress.completed` / signups), top 3 feedback themes, next-plan decision.
