# Verified Portfolio Builder — Tasks

> **Status**: `pending`
> **Depends on**: [`claimable-profiles`](../claimable-profiles/spec.md) (canonical, source-verified claims)
> **Blocks**: nothing
> **Reality check**: No scoped portfolio implementation exists. `src/routes/builders/$builderId.tsx` is a public profile, not an owner-curated/published portfolio. The canonical claim and its namespaced metadata from `claimable-profiles` must land first; AI enrichment and timeline remain optional.

- [ ] **Define portfolio settings and public contracts**
  - Files: `src/shared/lib/portfolio.ts`, `src/shared/lib/portfolio.test.ts`
  - Do: Implement `PortfolioSettingsSchema`, unpublished defaults, input/public DTO schemas, namespace-preserving merge, version fail-closed behavior, selected-project filtering, and deterministic representative-row selection.
  - Verify: `pnpm test -- src/shared/lib/portfolio.test.ts`

- [ ] **Add the portfolio feature flag and cache helpers**
  - Files: `src/shared/lib/env.ts`, `.env.example`, `src/shared/lib/portfolio-cache.ts`, `src/shared/lib/portfolio-cache.test.ts`
  - Do: Add optional `PORTFOLIOS_ENABLED`; cache only schema-valid published DTOs under `portfolio:<claimId>:v1` with a short TTL and expose purge used by every state transition and claim revocation.
  - Verify: `pnpm test -- src/shared/lib/portfolio-cache.test.ts && pnpm type-check`

- [ ] **Implement verified-owner draft read and write**
  - Files: `src/routes/api/me/builder-claims/$claimId/portfolio.ts`, `src/routes/api/me/builder-claims/$claimId/portfolio.test.ts`, `src/shared/lib/db/schema.ts`
  - Do: GET returns draft, project candidates, and optional-integration availability; PATCH validates owner input and updates only `builder_claims.metadata.portfolio` with `jsonb_set`. Require active source-verified ownership; admin cannot publish/edit for the owner.
  - Verify: `pnpm test -- 'src/routes/api/me/builder-claims/$claimId/portfolio.test.ts'`; cover anonymous, unrelated user, verified owner, revoked owner, and admin.

- [ ] **Implement explicit publish and unpublish transitions**
  - Files: `src/routes/api/me/builder-claims/$claimId/portfolio/publish.ts`, `src/routes/api/me/builder-claims/$claimId/portfolio/unpublish.ts`, `src/routes/api/me/builder-claims/$claimId/portfolio/publication.test.ts`, `src/shared/lib/log.ts`
  - Do: Require confirmation on first publish, set server timestamps, make transitions idempotent, emit audit events, purge cache, and reject legacy-email-only/unverified/revoked claims. Save must never imply publish.
  - Verify: `pnpm test -- 'src/routes/api/me/builder-claims/$claimId/portfolio/publication.test.ts'`; assert publish → visible, repeated publish → stable, unpublish → hidden.

- [ ] **Build the fail-closed public portfolio API**
  - Files: `src/routes/api/portfolio/$claimId.ts`, `src/routes/api/portfolio/$claimId.test.ts`, `src/shared/lib/portfolio.ts`
  - Do: Resolve canonical claim and freshest matching builder, return only `PublicPortfolioSchema`, include only selected projects, and 404 when disabled, missing, unpublished, invalid, or revoked. Never serialize raw metadata, owner IDs, emails, notes, analytics, or proof state.
  - Verify: `pnpm test -- 'src/routes/api/portfolio/$claimId.test.ts'`; snapshot exact keys for public, draft, revoked, duplicate-row, and deleted-project fixtures.

- [ ] **Create the public SSR route and accessible layout**
  - Files: `src/routes/portfolio/$claimId.tsx`, `src/modules/builder-profile/components/PublicPortfolio.tsx`, `src/modules/builder-profile/components/PublicPortfolio.test.tsx`
  - Do: Render identity, verification provenance, curated intro, selected projects, source links, independent optional slots, empty/404 states, responsive themes, and keyboard/semantic accessibility. No contact form or AI impersonation widget.
  - Verify: `pnpm test -- src/modules/builder-profile/components/PublicPortfolio.test.tsx && pnpm type-check`; anonymously load a published fixture and confirm an unpublished fixture returns 404.

- [ ] **Add canonical, social, robots, and sitemap metadata**
  - Files: `src/routes/portfolio/$claimId.tsx`, `src/shared/lib/portfolio-seo.ts`, `src/shared/lib/portfolio-seo.test.ts`, `src/routes/sitemap[.]xml.ts`
  - Do: Generate title/description/canonical/OG/Twitter fields from allowlisted data; use `noindex` for authenticated preview and add only published active claims to the sitemap.
  - Verify: `pnpm test -- src/shared/lib/portfolio-seo.test.ts`; curl page HTML and sitemap for published/unpublished fixtures.

- [ ] **Add owner settings, preview, and copy-link UX**
  - Files: `src/modules/builder-profile/components/PortfolioSettings.tsx`, `src/modules/builder-profile/components/PortfolioSettings.test.tsx`, `src/routes/_dashboard/me/index.tsx`
  - Do: Add theme, headline/introduction counters, explicit project selection, opt-in persona/timeline toggles, private preview, separate publish/unpublish controls, confirmation, and clipboard feedback. Hide behind feature flag and require verified claim.
  - Verify: `pnpm test -- src/modules/builder-profile/components/PortfolioSettings.test.tsx`; verify saving a draft does not make the public URL resolve.

- [ ] **Integrate AI persona as an optional read-only adapter**
  - Files: `src/shared/lib/portfolio-integrations.ts`, `src/shared/lib/portfolio-integrations.test.ts`, `src/modules/builder-profile/components/PublicPortfolio.tsx`
  - Do: When `ai-profile-enrichment` exists and owner opted in, parse the existing `metadata.aiEnrichment` artifact with its exported schema and expose only summary/focus/strengths/provenance. Never invoke `profile-enrich` from a public request; omit invalid, stale-policy-disabled, or absent artifacts.
  - Verify: `pnpm test -- src/shared/lib/portfolio-integrations.test.ts`; run with no AI files/config and with valid/invalid fixture artifacts.

- [ ] **Integrate timeline without making it a hard dependency**
  - Files: `src/shared/lib/portfolio-integrations.ts`, `src/modules/builder-profile/components/PublicPortfolio.tsx`, `src/modules/builder-profile/components/PortfolioTimelineSlot.tsx`, `src/modules/builder-profile/components/PortfolioTimelineSlot.test.tsx`
  - Do: Render public events only when owner opted in and unified-timeline is available. Preserve its lazy cache/degradation. If summary UI is exposed, call `timeline-summary` local-first through Chrome built-in AI; use the authenticated MiniMax proxy fallback and hide the control when neither tier is usable.
  - Verify: `pnpm test -- src/modules/builder-profile/components/PortfolioTimelineSlot.test.tsx`; exercise Chrome-available, authenticated proxy fallback, unavailable, and dependency-absent states.

- [ ] **Wire revocation and state transitions to immediate visibility**
  - Files: `src/routes/api/admin/builder-claims/$claimId/revoke.ts`, `src/shared/lib/portfolio-cache.ts`, `src/routes/api/portfolio/$claimId.test.ts`
  - Do: Purge portfolio cache on claim revocation and all portfolio writes; public lookup must independently recheck active verification so stale cache cannot keep a revoked portfolio live.
  - Verify: `pnpm test -- 'src/routes/api/portfolio/$claimId.test.ts'`; warm cache, revoke claim, then assert the next public read is 404.

- [ ] **Run end-to-end privacy, publication, and degradation checks**
  - Files: `tests/e2e/portfolio-builder.spec.ts`, `playwright.config.ts`
  - Do: Seed duplicate rows under one verified claim; save private draft, publish, inspect anonymous output/SEO, copy URL, unpublish, republish, revoke, and test both optional integrations absent and present. Assert hidden/unselected/private fields never appear.
  - Verify: `pnpm exec playwright test tests/e2e/portfolio-builder.spec.ts && pnpm test && pnpm build && pnpm lint && pnpm type-check`; run Lighthouse against the published fixture and require accessibility/SEO ≥ 95.
