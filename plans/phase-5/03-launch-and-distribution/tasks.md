# Launch and distribution (tasks)

> **Status**: `blocked` — every task happens at or after launch
> **Depends on**: [`01-production-readiness-audit`](../01-production-readiness-audit/tasks.md),
> [`02-legal-and-commercial-approvals`](../02-legal-and-commercial-approvals/tasks.md)
> **Provenance**: ten tasks moved from `plans/phase-1/54-waitlist-launch` and
> `plans/implemented/46-content-marketing` on 2026-08-05, on Edd's instruction. A launch cannot be performed
> before a launch, and their presence in the build phase made phase-1 permanently unfinishable.

Work these in order — see [`plan.md`](./plan.md) for why the order is load-bearing rather than tidy.

## Phase 1 — publish what is already written

- [ ] **Publish "The solo founder's guide to technical sourcing"**
  - Files: `content/posts/technical-sourcing-guide.md`
  - Do: Rename `content/posts/_draft-technical-sourcing-guide.md` off the `_` prefix after reading it.
    Tool-agnostic process piece targeting "technical sourcing guide"; the two BuilderHunt mentions are
    worked examples of a trade-off and both map to `src/lib/score.ts` and `src/lib/dedup.ts`.
  - Verify: the post builds, renders at its slug, and every quantitative statement maps to code.
  - Drafted 2026-08-04. `blog.ts` filters `_`-prefixed files and ignores a `draft:` frontmatter key
    entirely, so the prefix is the only thing keeping it off `/blog` and the Atom feed.
  - Moved from `plans/implemented/46-content-marketing` Phase 3 on 2026-08-05.

- [ ] **Publish "What I learned indexing developer profiles"**
  - Files: `content/posts/lessons-indexing-developers.md`
  - Do: Rename `content/posts/_draft-lessons-indexing-developers.md` off the `_` prefix after reading it.
    Targets "developer data aggregation" and explains dedup/scoring trade-offs by citing real decisions
    in `src/lib/dedup.ts` and `src/lib/score.ts`.
  - Verify: the post builds, renders at its slug, and no statement invents a scale metric.
  - Drafted 2026-08-04. **Note the title**: the original brief said "indexing 10,000 developer profiles"
    and the draft deliberately does not claim 10,000, because the corpus is nowhere near that and the
    brief's own rule was not to invent scale metrics.
  - Moved from `plans/implemented/46-content-marketing` Phase 3 on 2026-08-05.

- [ ] **Publish "Saved searches as a hiring radar: a setup tutorial"**
  - Files: `content/posts/saved-search-hiring-radar.md`
  - Do: Rename `content/posts/_draft-saved-search-hiring-radar.md` off the `_` prefix after reading it.
    Targets "developer hiring alerts"; every route, field label and dropdown option is read out of
    `SearchPage.tsx` and `alerts.tsx` rather than remembered.
  - Verify: follow the published tutorial in a seeded account end to end; the three embedded screenshots
    still match the running app.
  - Drafted 2026-08-05, **with all three screenshots taken** (`search-save-search.webp`,
    `alerts-new-radar.webp`, `alerts-radar-with-matches.webp`). Nothing in the third is seeded: the radar
    was created through the real form and its five matches are rows the alerts worker produced by
    re-running the saved search against the live sources. Their shot definitions are in
    `scripts/dev/capture-app-screenshots.ts`, so a redesign refreshes them with every other blog image.
  - Writing it is what surfaced the radar dropdown labelling four events the product never detects, fixed
    the same day (commit `05f601d04`). Worth one deliberate decision before publishing: the screenshots
    show real people's public handles, which is the same standard as the existing search/explore images.
  - Moved from `plans/implemented/46-content-marketing` Phase 3 on 2026-08-05.

- [ ] **Publish "How the BuilderHunt activity score works"**
  - Files: `content/posts/how-activity-score-works.md`, `src/lib/score.ts`
  - Do: Rename `content/posts/_draft-how-activity-score-works.md` off the `_` prefix after reading it.
    Targets "measure developer activity" and explains the current heuristics, limitations and source
    differences without presenting the score as objective ability.
  - Verify: a reviewer maps every scoring statement to `src/lib/score.ts`; the post builds and renders.
  - Drafted 2026-08-04, presented as a heuristic with named limitations throughout.
  - Moved from `plans/implemented/46-content-marketing` Phase 3 on 2026-08-05.

## Phase 2 — tell search engines

- [ ] **Submit the sitemap and confirm the previews**
  - Files: none (external tools)
  - Do: Add the property in Google Search Console and Bing Webmaster Tools, submit `/sitemap.xml`. Paste
    `/`, `/pricing`, `/explore?q=react` and one blog URL into the X card validator, the LinkedIn post
    inspector and a Slack DM.
  - Verify: GSC reports the sitemap as `Success`, and all four URLs show image, title and description.
  - **The OG half is already verified** (2026-08-05): the four URLs were fetched and their tags read
    directly, which is the same evidence a validator reports. `/api/og/explore` and
    `/api/og/explore?q=react` both return 200 `image/png` 1200×630 with bytes that differ per query, and
    each page carries `og:title`, `og:description`, `og:image`, `og:url` and
    `twitter:card: summary_large_image`. Two defects were found and fixed on the way (commit `fix(seo)`):
    eleven public routes served the *homepage's* OG title and description, and the canonical URL dropped
    the query string.
  - **Gated on the indexing decision** in
    [`01-production-readiness-audit`](../01-production-readiness-audit/tasks.md): `/blog`, `/changelog`
    and `/roadmap` are `noindex` today, so submitting first asks Google to index a site whose blog is
    invisible.
  - Operator: needs Search Console and Bing account access.
  - Moved from `plans/phase-1/54-waitlist-launch` Phase 2 on 2026-08-05.

## Phase 3 — distribution, one channel per day

- [ ] **Show HN post**
  - Files: none
  - Do: "Show HN: BuilderHunt – find active developers across 12 sources (GitHub, HN, Stack Overflow…)".
    First comment: an honest write-up — what it does, the stack (TanStack Start + Postgres, single
    Hetzner VPS), and what feedback is wanted (search relevance, sources to add). Post morning US time
    and stay available all day to reply.
  - Verify: the post is live, every top-level comment is answered within 2h, and feedback is captured as
    issues or plan entries rather than left in the thread.
  - Operator: the maintainer's voice and the maintainer's day. Do not queue this behind other channels —
    its Verify line is unmeetable while running several threads at once.
  - Moved from `plans/phase-1/54-waitlist-launch` Phase 4 on 2026-08-05.

- [ ] **Cross-post to dev.to, X, LinkedIn, one subreddit and Indie Hackers**
  - Files: none (external platforms)
  - Do: dev.to and Hashnode: paste the markdown, set `canonical_url` to the builderhunt.dev URL, same
    tags. X: a 6-8 tweet thread (problem → 12-sources screenshot → tracking/alerts → link). LinkedIn: a
    recruiter-angle summary. Reddit: r/ExperiencedDevs or r/webdev, per that sub's self-promo rules. Indie
    Hackers: a launch milestone. Add `?utm_source=devto|hashnode|x|linkedin` to every link. Stagger one
    per day after Show HN.
  - Verify: each post is live with working links; both mirrors show `rel=canonical` to builderhunt.dev in
    view-source; UTM referrers appear in server logs after clicks.
  - Moved from `plans/phase-1/54-waitlist-launch` Phase 4 and
    `plans/implemented/46-content-marketing` Phase 2 on 2026-08-05 — they were the same task written twice,
    once for the launch post and once as a per-post routine, and are merged here.

## Phase 4 — read what happens

- [ ] **Monitor daily through launch week, then weekly**
  - Files: none
  - Do: Check `/admin/metrics` (signups, searches, errors), `/status`, and Search Console impressions.
    Reply to every feedback comment. File real bugs and requests into `plans/` or issues. Publish a
    weekly changelog entry.
  - Verify: a 30-day review is written up stating signups against the 200 target, the activation rate
    (`onboarding_progress.completed` / signups), the top three feedback themes, and the next-plan
    decision.
  - Operator: needs 30 days of elapsed time and real traffic. No agent can shorten it, and a review
    written from a week of data is not the review this asks for.
  - Moved from `plans/phase-1/54-waitlist-launch` Phase 5 on 2026-08-05.

- [ ] **Run the monthly content review**
  - Files: none — the decision is appended to this task or to the repo journal
  - Do: Check Search Console queries and impressions per post; double down on the best-performing topic
    in the next brief; kill formats that consistently take more than six hours to write.
  - Verify: a one-paragraph note per month recording the decision taken.
  - Operator: needs Search Console data accumulated over months, which requires the sitemap submitted and
    the posts indexed. It is the last item in this phase for that reason.
  - Moved from `plans/implemented/46-content-marketing` Phase 3 on 2026-08-05.
