# Tasks: Trust, Claims, and Profile Removal Audit

> **Status**: `partially-implemented`
> **Depends on**: [`audit-performance-qa`](../audit-performance-qa/spec.md), [`pricing-and-billing`](../pricing-and-billing/spec.md), [`legal-and-compliance`](../legal-and-compliance/spec.md), [`claimable-profiles`](../claimable-profiles/spec.md)
> **Blocks**: [`waitlist-launch`](../waitlist-launch/spec.md)
> **Reality check**: `/pricing`, legal/privacy controls, public profiles, and claim email routes are
> shipped. User PAT entry, a functioning landing alert form, source-ownership proof, and global
> de-indexing are not shipped; the current claim email can be controlled by anyone.

- [ ] **Disable unsafe claims and remove unsupported public claims**
  - Files: `src/shared/lib/env.ts`, `.env.example`, `.env.production.example`, `src/routes/api/builders/$builderId/claim.ts`, `src/modules/builder-profile/components/BuilderProfilePage.tsx`, `src/modules/landing/components/HomePage.tsx`, `src/modules/landing/components/FAQSection.tsx`, `src/routes/__root.tsx`
  - Do: Add default-off `PROFILE_CLAIMS_ENABLED`; return 503 and hide the CTA while off. Remove user-PAT guidance, unsupported aggregate rating/counts/future features, anonymous “paid for itself” proof, and the inert “Join Alerts” form without inventing replacement data.
  - Verify: `rg -n "aggregateRating|420M|Join Alerts|personal access token|paid for itself" src` returns no unsupported public claim; route tests prove disabled claims cannot create a request.

- [ ] **Create and enforce a single product-claims contract**
  - Files: `src/shared/lib/product-claims.ts`, `src/shared/lib/product-claims.test.ts`, `src/shared/lib/billing-shared.ts`, `src/modules/landing/components/HomePage.tsx`, `src/modules/landing/components/FAQSection.tsx`, `src/routes/_landing/pricing.tsx`, `src/routes/__root.tsx`
  - Do: Derive visible limits/prices/source availability/export formats from shipped constants and code; replace duplicated beta/PAT/feature wording and keep structured data conservative.
  - Verify: `pnpm test -- src/shared/lib/product-claims.test.ts` fails when a plan limit, source list, or export capability drifts from displayed/JSON-LD claims.

- [ ] **Publish accurate security and removal guidance**
  - Files: `src/routes/_landing/security.tsx`, `src/routes/_landing/privacy/remove.tsx`, `src/shared/components/Footer.tsx`, `src/routes/sitemap[.]xml.ts`, `src/routes/_landing/legal/privacy.tsx`, `e2e/trust-copy.spec.ts`
  - Do: Explain operator-managed source tokens, transport/storage evidence, subprocessors, account deletion versus profile removal/correction, supported proof, manual fallback, and no upstream deletion promise; add footer/sitemap links.
  - Verify: `pnpm test:e2e -- e2e/trust-copy.spec.ts` passes at 390 and 1440 px and asserts no user-token input or unsupported encryption/AI claim.

- [ ] **Add additive request and suppression tables**
  - Files: `src/shared/lib/db/schema.ts`, `drizzle/0001_profile_suppressions.sql`, `drizzle/meta/_journal.json`, `drizzle/meta/0001_snapshot.json`, `src/shared/lib/env.ts`, `.env.example`, `.env.production.example`
  - Do: Add the exact request/suppression shapes, status checks, active `(source, source_id)` uniqueness, expiry index, FK/delete behavior, and comments from `spec.md`; store only keyed hashes for email/challenge/normalized URL. Require a dedicated 32-byte `PROFILE_REMOVAL_HMAC_KEY` when removal is enabled and support current/previous key IDs for safe rotation.
  - Verify: `pnpm db:migrate` succeeds twice; schema tests reject duplicate active suppressions and plaintext-sensitive columns; the previous app version still boots against the additive schema.

- [ ] **Implement privacy-safe removal primitives**
  - Files: `src/shared/lib/profile-suppression.ts`, `src/shared/lib/profile-suppression.test.ts`, `src/shared/lib/profile-removal.ts`, `src/shared/lib/profile-removal.test.ts`
  - Do: Implement strict URL normalization, source identity keys, keyed HMAC/redaction, 256-bit single-use challenges, 30-minute expiry, legal transitions, transaction helper, and batch suppression filtering.
  - Verify: `pnpm test -- src/shared/lib/profile-suppression.test.ts src/shared/lib/profile-removal.test.ts` covers canonicalization collisions, expiry, replay, cross-profile proof, rollback, and absence of plaintext secrets.

- [ ] **Build allowlisted source-proof adapters**
  - Files: `src/lib/sources/profile-proof.ts`, `src/lib/sources/profile-proof.test.ts`, `src/lib/sources/types.ts`
  - Do: Add explicit supported-source adapters using official fixed hosts, five-second aborts, response-size caps, strict content types, no cross-host redirects, and normalized `sourceId`; return `manual-review-required` for other sources.
  - Verify: unit tests with mocked fetch reject private/arbitrary hosts, redirect escapes, oversized bodies, wrong source IDs, missing challenges, and timeouts while accepting exact public-bio proof.

- [ ] **Implement request and verify endpoints**
  - Files: `src/routes/api/privacy/profile-removal/index.ts`, `src/routes/api/privacy/profile-removal/verify.ts`, `src/shared/lib/rate-limit.ts`, `src/shared/lib/log.ts`, `src/routes/_landing/privacy/remove.tsx`
  - Do: Zod-validate/cap bodies, normalize URLs, rate-limit IP plus profile, use uniform 202 request responses, verify proof constant-time, transact suppression/deletion, redact events, and expose manual fallback without identity enumeration.
  - Verify: integration tests cover 400/202/429, duplicate requests, wrong/replayed/expired proof, upstream failure, two-user deletion, transaction rollback, and logs containing no email/token/full URL.

- [ ] **Enforce suppression across search and every consumer**
  - Files: `src/lib/search.ts`, `src/routes/api/builders/track.ts`, `src/routes/api/builders/$builderId.ts`, `src/routes/api/builders/recent/index.ts`, `src/routes/api/recommendations/index.ts`, `src/routes/api/export/builders.ts`, `src/routes/api/feeds/$searchId.ts`, `src/lib/alerts/worker.ts`, `src/shared/lib/profile-suppression.test.ts`
  - Do: Batch-filter memory/Redis hits and fresh results, version/evict caches, reject track, return 404 publicly, and filter recent/recommendation/export/feed/alert paths by `(source, sourceId)`.
  - Verify: one integration scenario seeds the identity for two users plus memory and Redis caches, verifies suppression, restarts the app, and proves absence from every named surface for longer than the five-minute cache TTL.

- [ ] **Replace email-only builder verification with source proof**
  - Files: `src/routes/api/builders/$builderId/claim.ts`, `src/routes/api/builders/claim/verify.ts`, `src/shared/lib/db/schema.ts`, `src/shared/lib/email.ts`, `src/modules/builder-profile/components/BuilderProfilePage.tsx`, `src/lib/sources/profile-proof.ts`
  - Do: Require a matching source-hosted challenge before contact-email confirmation or `isVerified=true`; hash tokens, prevent replay, and never auto-create a verified account from arbitrary email alone. Re-enable claims only after migration and tests.
  - Verify: wrong email with no source proof, right email with wrong-profile proof, replay, and expired proof cannot claim; exact source proof plus email confirmation succeeds once.

- [ ] **Add trust runtime gates and redacted metrics**
  - Files: `src/shared/lib/metrics.ts`, `e2e/trust-removal.spec.ts`, `.github/workflows/quality.yml`, `docs/operations/profile-removal.md`
  - Do: Count request outcomes/source and measure suppression latency without identifiers; run copy and removal abuse tests in QA with `AI_DISABLED=true`; document flags, manual review, revocation, incident handling, and canary procedure.
  - Verify: CI passes the trust suites, a synthetic production canary disappears from all surfaces in ≤5 minutes, and sampled DB/log/trace/metric output contains no plaintext email, challenge, private note, or AI payload.

- [ ] **Roll out source by source without weakening enforcement**
  - Files: `.env.production.example`, `docs/operations/profile-removal.md`
  - Do: Enable intake, then each verified source adapter, then claims; record responsible owner, timestamp, canary evidence, and rollback switch. Keep existing suppressions enforced when intake is disabled.
  - Verify: toggling `PROFILE_REMOVAL_ENABLED=false` rejects new mutation requests while a previously suppressed synthetic identity remains absent after restart and cache expiry.
