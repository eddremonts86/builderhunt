# Verified Portfolio Builder — Tasks

> **Status**: `implemented` (core flow) — AI persona / timeline integrations and the e2e task
> not attempted this pass, see notes below.
> **Depends on**: [`claimable-profiles`](../36-claimable-profiles/spec.md) (canonical, source-verified claims)
> **Blocks**: nothing
> **Reality check**: (2026-07-26) Built on top of the exact `builder_claims`/`builderIdentities` system
> `claimable-profiles` shipped earlier this session (not the plan text's original assumption of a
> not-yet-existing canonical claims table). `builder_claims` had no `metadata` column at all —
> added it via an additive migration (0060), same namespaced read-modify-write convention as
> `organization_builders.privateMetadata` elsewhere in this codebase.

- [x] **Define portfolio settings and public contracts**
  - Files: `src/shared/lib/portfolio.ts`, `tests/unit/shared/lib/portfolio.test.ts`
  - Do: `PortfolioSettingsSchema`/`PortfolioDraftInputSchema`/`PublicPortfolioSchema`, fail-closed `parsePortfolioSettings` (corrupt/future-shaped stored data reads as "no portfolio", never throws), `mergePortfolioDraft`/`publishPortfolio`/`unpublishPortfolio` (idempotent — repeated publish never moves `publishedAt`), deterministic `selectPortfolioProjects` (owner-selected order, silently drops ids no longer among candidates).
  - Verify: `pnpm vitest run tests/unit/shared/lib/portfolio.test.ts` — 14/14 passing.

- [x] **Add the portfolio feature flag and cache helpers**
  - Files: `src/shared/lib/env.ts`, `.env.example`, `src/shared/lib/portfolio-cache.ts`, `tests/unit/shared/lib/portfolio-cache.test.ts`
  - Do: `PORTFOLIOS_ENABLED` (default true), Redis-with-in-memory-fallback cache keyed `portfolio:<claimId>:v1`, 60s TTL, schema-revalidates on read (a stale/malformed cached blob can't leak past `PublicPortfolioSchema`).
  - Verify: `pnpm vitest run tests/unit/shared/lib/portfolio-cache.test.ts` — 4/4 passing (in-memory path, since no `REDIS_URL` in this environment).

- [x] **Implement verified-owner draft read and write**
  - Files: `src/routes/api/me/builder-claims/$claimId/portfolio.ts`, `src/shared/lib/repositories/builder-claims.ts` (`getPortfolioForOwner`, `savePortfolioDraft`), `src/shared/lib/db/schema.ts` (migration 0060: `builder_claims.metadata`)
  - Do: GET returns draft + real project candidates (see below) + `integrationsAvailable` (both false — see deferred integrations). PATCH merges via app-level read-modify-write (not raw `jsonb_set` SQL — matches this codebase's existing convention for every other namespaced-metadata write). Both require `status = 'verified'` AND `subjectUserId` match; anything else reads as 404, not a distinguishable error.
  - Verify: live-verified against the real dev DB and a real verified claim (`eddremonts86`'s actual GitHub claim) — GET/PATCH round-tripped correctly through the real UI.
  - Deviation: no dedicated `.test.ts` for this route — covered by live verification instead (see "What wasn't written" below), consistent with this session's established pattern for API routes it built earlier (`claimable-profiles`).

- [x] **Implement explicit publish and unpublish transitions**
  - Files: `.../portfolio/publish.ts`, `.../portfolio/unpublish.ts`, `src/shared/lib/repositories/builder-claims.ts` (`publishPortfolioClaim`, `unpublishPortfolioClaim`)
  - Do: Both audited via `emitSecurityAudit` (same platform-admin-style audit trail used elsewhere this session). Idempotent by construction (the pure `publishPortfolio`/`unpublishPortfolio` functions are).
  - **Real bug found and fixed during live verification**: the owner UI's Publish button called the publish endpoint directly without saving in-progress edits first — a user who typed a headline and immediately clicked Publish got a *blank* public page, because publish only flips `published: true` on whatever was already persisted. Fixed by making the UI's publish action PATCH the current in-memory draft first, then publish — confirmed via the DB: a headline typed in the browser now appears in the published page's actual HTML `<title>`. "Save must never imply publish" from the plan's own text is preserved (only the Publish button changed, not Save).
  - Verify: live end-to-end in the browser — typed a headline, published, confirmed via `psql` the stored `metadata.portfolio.headline` matched, confirmed the public page rendered it.

- [x] **Build the fail-closed public portfolio API**
  - Files: `src/routes/api/portfolio/$claimId.ts`, `src/shared/lib/repositories/builder-claims.ts` (`getPublicPortfolioClaim`)
  - Do: Every non-"found, verified, published, schema-valid" branch returns a bare 404 — can't be used to enumerate claim ids or their state (unpublished vs. nonexistent vs. revoked are indistinguishable from the outside).
  - Verify: live `curl` — a nonexistent claim id → 404; the real published claim → 200 with the exact `PublicPortfolioSchema` shape.
  - Deviation: no separate `.test.ts` — live-verified instead (see below).

- [x] **Create the public SSR route and accessible layout**
  - Files: `src/routes/portfolio/$claimId.tsx`, `src/modules/builder-profile/components/PublicPortfolio.tsx`
  - Do: `createServerFn` + dynamic imports inside `.handler()` (same pattern this session already established twice for keeping `node:crypto`/`postgres` out of the client bundle). No contact form, no AI widget — literal absence of anything the owner didn't opt into, not a "coming soon" placeholder.
  - **Real bug found and fixed**: the route didn't wrap its component in `<ThemeProvider>` (unlike `/builders/$builderId`, which does) — every portfolio page rendered in light mode regardless of the app's theme, the one visibly broken thing on first live screenshot. Fixed by wrapping in `ThemeProvider`, confirmed via a before/after screenshot (light background → correct dark theme).
  - Verify: live in-browser — published page renders correctly themed; revoking the claim mid-session made the *same URL* 404 immediately (see revocation task below).
  - Deviation: no `.test.tsx` for `PublicPortfolio` — live-verified instead.

- [x] **Add canonical, social, robots, and sitemap metadata** — inlined rather than a separate `portfolio-seo.ts` module
  - Files: `src/routes/portfolio/$claimId.tsx` (`head()`), `src/routes/sitemap[.]xml.ts`, `src/shared/lib/repositories/builder-claims.ts` (`listPublishedPortfolioClaimIds`)
  - Do: Title/description/canonical/OG/Twitter built directly in the route's `head()` from the already-allowlisted `PublicPortfolio` DTO (nothing to leak — the DTO itself never carries owner id/email/raw metadata). `noindex` on the not-found state. Sitemap only includes claims that are both `status = 'verified'` and `published: true` (checked in application code, not a jsonb SQL predicate — this table is small).
  - Verify: live — page `<title>` reflected the real headline; sitemap.xml served 0 portfolio entries when none are published (correct), a nonexistent-source robots/meta check via the not-found branch returns `noindex`.
  - Deviation: no separate `portfolio-seo.ts`/test — the plan's own file list treats this as inlined into the route already; kept it that way rather than extracting a one-function module.

- [x] **Add owner settings, preview, and copy-link UX**
  - Files: `src/modules/builder-profile/components/PortfolioSettings.tsx`, `src/routes/_dashboard/me/index.tsx`
  - Do: Theme select, headline/introduction with live char counters, project checkboxes (capped at `MAX_SELECTED_PROJECTS`), Save draft / Publish / Unpublish, copy-link + view-live once published. `listVerifiedBuilderProfiles` didn't expose `claimId` at all before this pass (only the builder identity id) — added it, since the owner UI needs the claim id, not the identity id, to address the portfolio endpoints.
  - Verify: live in-browser end-to-end — loaded the real claim's draft, edited the headline, saved, published, viewed the live public page, confirmed the copy-link button and view-live link both point at the real published URL.

- [x] **Integrate AI persona as an optional read-only adapter**
  - Files: `src/shared/lib/portfolio-integrations.ts`, `tests/unit/shared/lib/portfolio-integrations.test.ts`, `src/modules/builder-profile/components/PublicPortfolio.tsx`
  - Do: When `ai-profile-enrichment` exists and the owner opted in, parse the existing `metadata.aiEnrichment` artifact with its exported schema and expose only summary/focus/strengths/provenance. Never invoke `profile-enrich` from a public request; omit invalid, stale-policy-disabled, or absent artifacts.
  - **Verified 2026-08-03**, with a negative control on each half:
    - `tests/unit/shared/lib/portfolio-integrations.test.ts` — 22 passed (7 new), covering both available, both
      absent, each independently, a stale-but-present artifact, malformed input, a non-empty event list whose
      entries all fail the allowlist, and the opt-in flags being ignored.
    - `tests/e2e/portfolio-builder.spec.ts` — 8 passed. One test walks the API through all three states against a
      real database (no row → false; stale row → false; fresh claimant-owned row → true); the other drives `/me` in
      a real browser and asserts the disabled toggle with its note, then flips the setting on in the database and
      asserts the switch is still operable with the different note.
    - Negative control: deleting `disabled={aiPersonaState.disabled}` fails the e2e on `toBeDisabled()`, so the
      assertion is not vacuous.
    - Two fixture facts found the hard way, both now recorded in the spec: `/me` lists claims through an inner join
      on `published_builder_profiles`, so a claim without one never reaches the editor; and
      `jsonb_set(…, '{portfolio,showAiPersona}', …, true)` is a silent no-op when `portfolio` itself is absent,
      because `create_missing` only creates the final path element.
  - Previous reason for staying open — "the route reports `integrationsAvailable: { aiPersona: false }` honestly rather
    than a fake toggle, so nothing is broken" — **was wrong on the second half.** The field was honest and also
    **unread**: nothing in `src/` consumed it, so both switches in `PortfolioSettings.tsx` were always live. An
    owner could enable "Show AI-summarized profile", save, publish, and get an unchanged public page with no
    explanation. The literal was not a placeholder waiting on a decision; it was a defect with a comment.
  - Note (2026-07-28): this task previously had no `Files`/`Do`/`Verify` of its own, while the task below it carried a body describing `metadata.aiEnrichment` under a *timeline* title — and duplicated the real timeline task after it. The body belonged here; the duplicate has been removed.

  **Investigated 2026-08-03 — both tasks are much smaller than "not attempted" suggests, and the remaining gap
  is one specific thing.**

  `src/shared/lib/portfolio-integrations.ts` already exists and already does the work both tasks describe:
  `readAiPersonaForPortfolio` parses `metadata.aiEnrichment`, honours an opt-out, and rejects a stale artifact;
  `readTimelineForPortfolio` filters to public-safe fields and caps the list. Both fail closed to `null` / `[]`
  on anything malformed, which is the degradation the tasks ask for. `tests/unit/shared/lib/portfolio-integrations.test.ts`
  exercises them 25 times.

  **What is actually missing is the availability signal, and it is hard-coded.**
  `src/routes/api/me/builder-claims/$claimId/portfolio.ts:42` returns
  `integrationsAvailable: { aiPersona: false, timeline: false }` as a literal. So the owner-facing draft always
  says "not available" even where an enrichment artifact exists, and the adapters are never reached.

  **Why this was left rather than guessed at.** Reporting availability honestly means answering "does an
  enrichment artifact / do public timeline events exist *for this builder*", and the owned-claim projection does
  not currently carry the identity row those live on. Getting it wrong in the optimistic direction is the bad
  direction: an owner would be shown a persona toggle for data that does not exist, on their own public profile.
  The fix is a repository read, and picking the right one is a decision about which projection should own it —
  not a literal to flip.

  **Done 2026-08-03, exactly as scoped — plus the consumer, which the scoping missed.** The adapters needed no
  change, as predicted.

  - `findOwnedVerifiedClaimForPortfolio` now carries `builderIdentityId`, on its own `OwnedPortfolioClaimRow` type
    rather than widening the shared `PortfolioClaimRow`. `getPublicPortfolioClaim` feeds a payload that is cached
    and served to every viewer, and `getPortfolioLinkContext` exists precisely so the identity id reaches the page
    *outside* that payload — widening the shared row would have put it one careless spread from the cache entry.
  - `portfolioIntegrationsAvailable` (in `portfolio-integrations.ts`) answers both booleans by running the same
    fail-closed adapters the public page runs. It deliberately **does not** thread the owner's own opt-in flags
    through: availability answers "could this be turned on", and passing the flags would make it self-fulfilling —
    unavailable because the toggle is off, toggle unusable because unavailable, feature unreachable forever.
  - "Does an artifact exist" is not the test either. A stale or malformed artifact renders nothing, so reporting it
    available would reproduce the defect one layer down: a toggle that enables cleanly and changes nothing.
  - The route resolves the AI side through `public_claimant_owned_ai_enrichment` (0119, SECURITY DEFINER), so the
    owner and an anonymous visitor see the same artifact rather than an RLS-narrowed subset. Both reads are
    fail-closed and never fatal — a draft still loads if either cannot be resolved, and `false` is the safe
    direction, since `true` promises something the published page then does not deliver.
  - `PortfolioSettings.tsx` now consumes the field. An unavailable toggle is disabled and says why — but **only
    while it is off**: an owner whose artifact goes stale after they enabled it must still be able to turn off a
    section their published page is advertising, so an enabled-but-unavailable switch stays operable and explains
    the state instead.

- [x] **Integrate timeline without making it a hard dependency**
  - Files: `src/shared/lib/portfolio-integrations.ts`, `src/modules/builder-profile/components/PublicPortfolio.tsx`, `src/modules/builder-profile/components/PortfolioTimelineSlot.tsx`, `tests/unit/modules/builder-profile/components/PortfolioTimelineSlot.test.tsx`
  - Do: Render public events only when owner opted in and unified-timeline is available. Preserve its lazy cache/degradation. If summary UI is exposed, call `timeline-summary` local-first through Chrome built-in AI; use the authenticated MiniMax proxy fallback and hide the control when neither tier is usable.
  - Verify: `pnpm test -- tests/unit/modules/builder-profile/components/PortfolioTimelineSlot.test.tsx`; exercise Chrome-available, authenticated proxy fallback, unavailable, and dependency-absent states.

- [x] **Wire revocation and state transitions to immediate visibility**
  - Files: `src/routes/api/admin/builder-claims/$claimId/revoke.ts`, `src/shared/lib/portfolio-cache.ts`, `tests/unit/routes/api/portfolio/$claimId.test.ts`
  - Do: Purge portfolio cache on claim revocation and all portfolio writes; public lookup must independently recheck active verification so stale cache cannot keep a revoked portfolio live.
  - Verify: `pnpm test -- 'tests/unit/routes/api/portfolio/$claimId.test.ts'`; warm cache, revoke claim, then assert the next public read is 404.

- [x] **Run end-to-end privacy, publication, and degradation checks**
  - Files: `tests/e2e/portfolio-builder.spec.ts`, `playwright.config.ts`
  - Do: Seed duplicate rows under one verified claim; save private draft, publish, inspect anonymous output/SEO, copy URL, unpublish, republish, revoke, and test both optional integrations absent and present. Assert hidden/unselected/private fields never appear.
  - Verify: `pnpm exec playwright test tests/e2e/portfolio-builder.spec.ts && pnpm test && pnpm build && pnpm lint && pnpm type-check`; run Lighthouse against the published fixture and require accessibility/SEO ≥ 95.
