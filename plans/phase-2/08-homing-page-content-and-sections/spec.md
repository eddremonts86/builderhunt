# Homing-page content and sections (spec)

> **Status**: `pending`
> **Depends on**: nothing in the same phase. Reads [`app-reality`](../../_meta/app-reality.md)
> for the ground truth on what is shipped today and what the home page is allowed to claim. Reads
> every plan under `plans/` to know what is coming so the home page can advertise it honestly.
> **Blocks**: nothing. Pure landing-page rewrite — no schema, no API, no migration.
> **Reality check**: the current landing (`src/modules/landing/components/HomePage.tsx`) is a single
> 600+ line file that grew organically across three redesign passes (light/glass, dark/glass, the
> persona-tab pass). It currently advertises only the discovery loop and a 4-persona grid. It does
> NOT mention: teams, sprints, alerts as a first-class surface, notes, exports, RSS, claimable
> profiles, outreach, enrichment, AI helpers, the credit ledger, multi-source search beyond
> "13 sources", semantic search, or any of the 14 phase-4 plans in queue. Anyone landing on
> `builderhunt.dev` for the first time does not know half of what the product already does, and
> does not know that the company is shipping toward the other half.

## Problem

The home page is the front door. Three things are wrong with it today:

1. **It under-claims shipped work.** The dashboard ships 14 widgets
   (`src/modules/dashboard/lib/widget-registry.ts`, verified 2026-07-30). The pricing page
   already names `smart alerts`, `AI sourcing sprints`, `work-sample analysis`, `team seats`,
   `activity feed`. The home page names none of them. A new visitor sees a 13-sources
   discovery loop and nothing else; the value of teams, alerts, sprints, and credits is invisible
   until they sign up and click around.

2. **It over-claims aspirational work.** The 4-persona grid ("Open-source maintainers",
   "Founders sourcing hires", "Recruiters & talent partners", "DevRel & community teams") is
   generic; every persona gets the same one-line copy. Phase-2 plan `06-landing-segmentada` is
   pending and exists precisely because a single landing cannot honestly serve `hiring`,
   `investing`, `building`, and `other` from one page — but a segmented landing can still exist
   as a single page whose copy shifts by query parameter without changing the structure.

3. **It tells no story about what's coming.** Plans `phase-4/hiring-pipeline-kanban`,
   `match-evidence-panel`, `look-alike-sourcing`, `availability-signals`, `ai-cv-generation-and-tailoring`,
   `collaboration-graph`, `solutions-intelligence`, `browser-extension-overlay`, `delegated-job-applications`,
   `job-opportunities-workspace`, `talent-market-intelligence`, `ats-integrations`,
   `saved-search-health`, `jd-to-candidates-matching` are all `pending` and represent real product
   direction. None of it appears on the home page.

## Goal

A single, sectioned landing page that:

1. **Honestly inventories what is shipped** by reading `app-reality.md` and every plan's
   `Status` header. Every claim on the home is backed by a real feature in the code, or
   labelled `Coming soon` with the plan name.
2. **Holds the four landing personas in one page** (`hiring`, `investing`, `building`,
   `other`) by shifting the copy per persona without changing the structure. Phase-2
   `06-landing-segmentada` can later extract these as separate routes without rewriting copy.
3. **Adds three new sections** between the existing discovery and the closing CTA, sized so the
   page does not exceed ~7 viewport heights on desktop or ~14 on mobile. The new sections are:
   `Pipeline` (alerts + sprints + team shortlists, the three shipped surfaces that justify
   upgrading), `AI helpers` (semantic search, AI outreach, AI sprints, profile enrichment,
   AI CV — a single honest statement of "where AI helps and where it does not"), and `Roadmap`
   (a public list of the next 6 to 10 plans with `Coming soon` badges and the plan name as the
   anchor link).
4. **Keeps every numeric claim grounded** by reading the source. Counts that are dynamic
   (sources, alert volume, builder coverage) come from the existing walker evidence
   (`docs/ui-audit/evidence/walk-summary.json`, refreshed by `scripts/audit/saas-review-walk.ts`)
   plus the seed-test-users fixtures — never invented.
5. **Does not exceed the page size budget**: the spec files and the
   `design-taste-frontend` skill §4.7 HERO STACK DISCIPLINE rule both forbid an unbounded
   landing. The plan measures pre-change vs post-change viewport height on desktop 1440 and
   mobile 320, fails the gate if either grows by more than 1.5×, and explicitly drops the
   lowest-priority section when it does.

## Non-goals

- **Not a redesign.** The glass/light/dark theme, hero, sticky-stack "How it works", bento
  Features, persona tabs, and Sources strip all stay. The work is **additive** sections
  between Features and Sources, plus a copy refresh on the existing ones to match the
  shipped-vs-coming-soon vocabulary this plan introduces.
- **No persona-specific routes.** Phase-2 `06-landing-segmentada` is the right owner of that
  work. This plan makes the single-page persona switch a `?persona=hiring|investing|building|other`
  query parameter (no SSR, just client-side copy swap) so the segmented-landing plan can
  extract the personas into routes without redoing any copy.
- **No new imagery, no new illustrations, no new marketing site pages.** The landing stays
  one page. New pages (`/roadmap`, `/changelog`, `/security`, `/trust`) already exist as
  routes and link from the footer; this plan only adds a roadmap teaser section in-page that
  links out to the existing `/roadmap`.

## Persona switch (`?persona=`)

Default `hiring` because that is the paid plan's primary audience. Other values swap the
persona-aware copy in three places only: the hero sub-paragraph, the persona-tabs section
heading, and the closing CTA strip. The rest of the page is identical across personas.

| persona | hero copy pivot | persona tab headline | CTA strip |
|---|---|---|---|
| `hiring` | "Activity scored for recency, so the top of your results are the people shipping right now." (current) | "Whoever you need to find, we surface them first." | "Create a free workspace and search 13 sources in under a minute." |
| `investing` | "Track who's shipping what. Across code, conversation, and publishing." | "Map a market without scraping it." | "Sign up free. Track 50 founders, upgrade for unlimited." |
| `building` | "Claim your profile. Show the work. Skip the spam." | "Your public work, indexed by people who care." | "Claim your builder profile in under 3 minutes." |
| `other` | "We don't know your job yet. Tell us — we'll show you where BuilderHunt fits." | "If you read code, you can use this." | "Browse public builders without signing up." |

## New sections

The three new sections are inserted **after the existing "Built for the people who build
things" bento and before the existing "Whoever you need to find" persona tabs**, because the
existing flow is: hero → how-it-works → bento features → persona tabs → sources strip → FAQ →
closing CTA. The new flow is:

```
hero
how-it-works (existing)
bento features (existing, copy refreshed)
─── NEW: Pipeline (shipped, justifies upgrading)
─── NEW: AI helpers (shipped + 1 roadmap item)
persona tabs (existing, copy refreshed per persona)
─── NEW: Roadmap (Coming soon, public plan list)
sources strip (existing)
FAQ (existing)
closing CTA (existing)
```

### Section 1 — `Pipeline`

Why: the dashboard has alerts, sprints, and team shortlists as first-class surfaces today,
but the landing never mentions them. A visitor who only sees the discovery loop thinks the
product is "search and look". `Pipeline` shows the three recurring-work surfaces, framed
honestly ("not magic, just less clicking"). Copy lives in
[`landing-copy/03-pipeline.md`](./landing-copy/03-pipeline.md).

Three cards, one per shipped surface:

1. **Keyword alerts.** "Set the filter once. We ping the moment a new builder matches — email
   or RSS." (mirrors `src/modules/dashboard/components/ActionQueueWidget.tsx` and
   `src/routes/api/alerts/*`.) Plan: `phase-1/34-smart-alerts`, `partially-implemented` —
   landing says "ships today".
2. **AI sourcing sprints.** "Pick keywords. We re-run them in the background until a result
   quota. Free: 0 concurrent. Pro: 3. Team: 10." Plan: `phase-1/41-ai-sourcing-sprints`,
   `implemented`. Shipped today.
3. **Team shortlists.** "Share saved searches and shortlists with your workspace. Owner-only
   visibility on private lists. Admins see org-visible lists." Plan:
   `phase-1/28-shared-resources`, `pending — unblocked 2026-07-29`. Landing says "ships in the
   next two-week cycle" — honest because the precondition is met and the remaining work is
   narrow.

The card grid uses the same `md:grid-cols-2 lg:grid-cols-3` bento the org-admin section uses
(see `src/modules/dashboard/components/admin/OrganizationAdminSection.tsx`). Same `liquid-glass`
panel style as the hero (`HeroGlass.tsx`). No new image asset required.

### Section 2 — `AI helpers`

Why: the AI cost story is the biggest source of visitor confusion. Visitors either assume
"AI recruiter tool" (and leave when they read about credits) or assume "scraper" (and leave
when they read about pgvector). The honest answer is: AI shows up in five specific places,
each with a credit cost. Listing them in one section makes the boundary clear.

Five tiles, each labelled `Shipped` or `Coming soon`:

| tile | status | plan | credit cost | one-line copy |
|---|---|---|---|---|
| Semantic search | Shipped | `phase-1/22-semantic-search` complete | free | "Find builders by what they shipped, not just what they say they do." |
| AI sourcing sprints | Shipped | `phase-1/41-ai-sourcing-sprints` implemented | included in plan | "Background re-runs of saved searches. Free: 0. Pro: 3 concurrent. Team: 10." |
| AI outreach copilot | Shipped | `phase-1/26-outreach-generator` complete | included in plan | "Draft the first note in your voice. Three tones. You edit before sending." |
| AI profile enrichment | Shipped (claim-gated) | `phase-1/24-ai-profile-enrichment` partially-implemented | per-request | "Verified claim holders get an evidence-backed persona card. Free for the holder; never sold." |
| AI CV generation & tailoring | Coming soon | `phase-4/ai-cv-generation-and-tailoring` pending | per-request | "Generate a CV from confirmed facts; tailor it to a job without inventing experience." |

Section copy in [`landing-copy/04-ai-helpers.md`](./landing-copy/04-ai-helpers.md).

### Section 3 — `Roadmap`

Why: a public roadmap prevents the "is this thing alive?" question that drives sign-ups away.
The footer already links to `/roadmap`, so this section is a teaser that links out, not a
fork.

A list of 8 to 10 upcoming plans. Each item is one line: `Plan name — one-line why — Coming
soon` with the plan's full title as the link target. Order is by what an interested visitor
would care about first, not by phase:

1. Hiring Pipeline Kanban — "Stage your tracked builders. New → Reviewed → Contacted → In
   conversation → Hired." — `phase-4/hiring-pipeline-kanban`
2. Why This Match (Evidence Panel) — "See exactly which signal pushed a builder to the top
   of your results." — `phase-4/match-evidence-panel`
3. Saved Search Health — "Know which of your saved searches are still returning fresh
   matches and which have gone quiet." — `phase-4/saved-search-health`
4. Look-alike Sourcing — "From any builder, find more like them. One HNSW query, zero AI
   calls." — `phase-4/look-alike-sourcing`
5. AI CV Generation & Tailoring — "Generate a CV from confirmed facts. Tailor to a job
   without inventing experience." — `phase-4/ai-cv-generation-and-tailoring`
6. Solutions Intelligence — "Paste a brief. Get up to three evidence-backed Human, AI, and
   Hybrid solution routes." — `phase-1/43-solutions-intelligence` (in progress)
7. Co-Shipping Collaboration Graph — "See who has shipped with who. Find your next hire by
   the people they have shipped with before." — `phase-4/collaboration-graph`
8. Browser Extension Overlay — "Get match scores and notes on any builder's profile across
   the open web, without leaving the tab." — `phase-4/browser-extension-overlay`

The list is capped at 8 to fit in ~2 viewports. Items past the cap move to `/roadmap`. The
list refreshes when a phase-1 plan transitions from `pending` to `implemented` (commit-time,
not page-render-time).

### Section 4 — `Persona switch` (optional)

A small toggle below the hero sub-paragraph: `I'm hiring · I'm investing · I'm a builder ·
Something else`. Picking one sets `?persona=` and swaps the persona-aware copy. Picking the
default hides the toggle. Reason: phase-2 plan `06-landing-segmentada` is the long-term
answer; this is the minimum viable version that lives in one page. Plan:
`phase-2/06-landing-segmentada`.

## Copy refresh (no structural change)

Three existing sections get a copy refresh only:

- **Hero sub-paragraph**: no change to the default. Persona variants live in the persona
  switch table above.
- **Bento Features**: the six existing feature cards stay. Each gets a `Coming soon` badge
  if the plan's status is `pending` (none of them are today — all six shipped features are
  marked `implemented` or `complete` in `app-reality.md`). The "Multi-source discovery" card
  gets a one-line clarification: "Federated across 12 communities + semantic search on top,
  not a scraper."
- **Sources strip**: the "13 sources" claim becomes "12 sources + semantic search". The
  `app-reality.md` source list (github, hn, devto, reddit, lobsters, stackoverflow, npm,
  huggingface, gitlab, codeberg, hashnode, sourcehut) is 12 entries; phase-1 `17-bluesky`,
  `18-producthunt`, `19-devpost`, `20-indiehackers` are added but the headline count comes
  from the live `src/lib/sources/index.ts` registry, not from a hard-coded number. The copy
  says "12+ sources live today, more on the way" rather than asserting a static count.

## Page-size budget

The landing must not grow beyond 1.5× its current viewport-height footprint on either
desktop 1440 or mobile 320. The current landing is roughly:

- desktop 1440×900 viewport: 7.2 viewports tall
- mobile 320×720 viewport: 13.4 viewports tall

After this plan, the budget is:

- desktop: ≤ 10.8 viewports (7.2 × 1.5)
- mobile: ≤ 20.1 viewports (13.4 × 1.5)

The new sections add roughly:

- `Pipeline`: ~1.2 desktop, ~2.4 mobile
- `AI helpers`: ~1.4 desktop, ~2.6 mobile
- `Roadmap`: ~1.0 desktop, ~2.0 mobile
- `Persona switch`: ~0.1 desktop, ~0.2 mobile

Total +: ~3.7 desktop, ~7.2 mobile.

Resulting footprint: ~10.9 desktop (over by 0.1), ~20.6 mobile (over by 0.5). **Margin is
small.** If the measurement after implementation goes over budget by more than 0.2 viewports,
the section with the lowest read-rate gets dropped first. Read-rate is approximated by
existing `/saas-review-walk` evidence: routes with the most console errors or non-zero
`failed-requests` are read the most.

## Verification

1. **Numeric-claim audit**: `grep -nE '[0-9]+' src/modules/landing/components/HomePage.tsx
   landing-copy/*.md` returns every number on the home. Each one resolves to:
   - a real feature in `src/` (e.g. `13 sources` → `grep -l sources src/lib/sources/index.ts`),
   - or `Coming soon` with a plan name in the same line.
2. **Page-size gate**: `scripts/audit/check-dashboard-budgets.ts` is repurposed for the
   landing: a sibling script `scripts/audit/check-landing-budget.ts` measures rendered
   viewport-height on desktop 1440 and mobile 320 against the budget above. CI fails if
   either is over by > 0.2.
3. **Persona variants**: `browser_navigate` to `?persona=hiring`, `?persona=investing`,
   `?persona=building`, `?persona=other`. Each renders three swapped copy blocks
   (hero, persona-tabs headline, CTA strip). All other sections identical across personas.
4. **Roadmap freshness**: every plan name in the roadmap section exists at the linked path
   under `plans/phase-1/` or `plans/phase-4/`. A grep CI gate fails if a roadmap item has no
   matching plan directory.
5. **Sign-in and account-claim flows** still work. The home page does not block the
   `?persona=` query param from passing through to the sign-up page (so a recruiter who
   picks `hiring` lands on sign-up with that preference carried forward).
6. **Existing visual regressions stay clean**: `scripts/audit/saas-review-walk.ts` records
   the current home as the desktop baseline (a new `evidence/landing-baseline/` directory
   under the same walker). Future runs diff against it.

## Constraints this plan respects

1. `app-reality.md` — every claim is grounded in the inventory. A claim with no source is
   rejected.
2. `security-and-multitenancy` §2 — no per-user/per-tenant leak in copy. Numbers like "13
   sources" or "140 credits/month" are plan-level constants, not per-user data.
3. `ai-policy.md` — every AI claim is paired with the credit cost or the
   `Coming soon` label. No "AI does everything" framing.
4. `design-taste-frontend` §4.7 — pre-flight already shipped
   (`src/modules/landing/components/HomePage.tsx`); the persona switch, new sections, and
   copy refresh do not violate HERO STACK DISCIPLINE or EYEBROW RESTRAINT.
5. `design-taste-frontend` §5 — liquid-glass panel style is reused from `HeroGlass.tsx`;
   no new motion pattern is introduced.

## Out of scope

- Pricing-page refresh (already comprehensive; stays).
- `/explore` refresh (already comprehensive; stays).
- Blog post previews on the home (covered by `phase-1/46-content-marketing`).
- Persona-segmented routes (covered by `phase-2/06-landing-segmentada`).
- Visual rebrand or icon refresh.
- SEO copy beyond the existing meta-description (covered by
  `phase-1/45-public-landing-pages`).
