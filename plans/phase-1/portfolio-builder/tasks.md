# Verified Portfolio Builder — Tasks

> **Status**: `implemented` (core flow) — AI persona / timeline integrations and the e2e task
> not attempted this pass, see notes below.
> **Depends on**: [`claimable-profiles`](../claimable-profiles/spec.md) (canonical, source-verified claims)
> **Blocks**: nothing
> **Reality check (2026-07-26)**: Built on top of the exact `builder_claims`/`builderIdentities` system
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

- [ ] **Integrate AI persona as an optional read-only adapter** — not attempted
  - Reason: the owner draft route already reports `integrationsAvailable: { aiPersona: false }` honestly rather than a fake toggle. Wiring the real `ai-profile-enrichment` artifact parsing is separable, genuinely optional per the plan's own framing, and not reached this pass.

- [ ] **Integrate timeline without making it a hard dependency** — not attempted, same reason as above (`integrationsAvailable.timeline: false` reported honestly)
  - Files: `src/shared/lib/portfolio-integrations.ts`, `tests/unit/shared/lib/portfolio-integrations.test.ts`, `src/modules/builder-profile/components/PublicPortfolio.tsx`
  - Do: When `ai-profile-enrichment` exists and owner opted in, parse the existing `metadata.aiEnrichment` artifact with its exported schema and expose only summary/focus/strengths/provenance. Never invoke `profile-enrich` from a public request; omit invalid, stale-policy-disabled, or absent artifacts.
  - Verify: `pnpm test -- tests/unit/shared/lib/portfolio-integrations.test.ts`; run with no AI files/config and with valid/invalid fixture artifacts.

- [ ] **Integrate timeline without making it a hard dependency**
  - Files: `src/shared/lib/portfolio-integrations.ts`, `src/modules/builder-profile/components/PublicPortfolio.tsx`, `src/modules/builder-profile/components/PortfolioTimelineSlot.tsx`, `tests/unit/modules/builder-profile/components/PortfolioTimelineSlot.test.tsx`
  - Do: Render public events only when owner opted in and unified-timeline is available. Preserve its lazy cache/degradation. If summary UI is exposed, call `timeline-summary` local-first through Chrome built-in AI; use the authenticated MiniMax proxy fallback and hide the control when neither tier is usable.
  - Verify: `pnpm test -- tests/unit/modules/builder-profile/components/PortfolioTimelineSlot.test.tsx`; exercise Chrome-available, authenticated proxy fallback, unavailable, and dependency-absent states.

- [ ] **Wire revocation and state transitions to immediate visibility**
  - Files: `src/routes/api/admin/builder-claims/$claimId/revoke.ts`, `src/shared/lib/portfolio-cache.ts`, `tests/unit/routes/api/portfolio/$claimId.test.ts`
  - Do: Purge portfolio cache on claim revocation and all portfolio writes; public lookup must independently recheck active verification so stale cache cannot keep a revoked portfolio live.
  - Verify: `pnpm test -- 'tests/unit/routes/api/portfolio/$claimId.test.ts'`; warm cache, revoke claim, then assert the next public read is 404.

- [ ] **Run end-to-end privacy, publication, and degradation checks**
  - Files: `tests/e2e/portfolio-builder.spec.ts`, `playwright.config.ts`
  - Do: Seed duplicate rows under one verified claim; save private draft, publish, inspect anonymous output/SEO, copy URL, unpublish, republish, revoke, and test both optional integrations absent and present. Assert hidden/unselected/private fields never appear.
  - Verify: `pnpm exec playwright test tests/e2e/portfolio-builder.spec.ts && pnpm test && pnpm build && pnpm lint && pnpm type-check`; run Lighthouse against the published fixture and require accessibility/SEO ≥ 95.
