# Claimable Builder Profiles — Tasks

> **Status**: `partially-implemented`
> **Depends on**: nothing
> **Blocks**: [`portfolio-builder`](../portfolio-builder/spec.md)
> **Reality check**: The schema, migration, public route, claim email flow, verified badge, `/me` editor, and owner PATCH route exist. No claim tests exist, view rows are not written, public GET returns a full DB row, and the current arbitrary-email flow is not source-bound verification.

## Delivered baseline

- [x] **Add claim fields and supporting tables**
  - Files: `src/shared/lib/db/schema.ts`, `drizzle/0000_tranquil_hemingway.sql`, `drizzle/meta/0000_snapshot.json`
  - Do: Existing schema includes claim columns, `builder_claim_requests`, and `builder_profile_views` with foreign keys and defaults.
  - Verify: `rg -n "builderClaimRequests|builderProfileViews|isClaimed|claimedTopics" src/shared/lib/db/schema.ts drizzle/0000_tranquil_hemingway.sql`

- [x] **Deliver the public profile route and SEO metadata**
  - Files: `src/routes/builders/$builderId.tsx`, `src/modules/builder-profile/components/BuilderProfilePage.tsx`, `src/routes/api/builders/$builderId.ts`
  - Do: Existing code renders a public profile, OG/Twitter metadata, claimed fields, verified badge, and claim CTA.
  - Verify: `test -f 'src/routes/builders/$builderId.tsx' && rg -n "og:title|Claim this profile|Verified" 'src/routes/builders/$builderId.tsx' src/modules/builder-profile/components/BuilderProfilePage.tsx`

- [x] **Deliver rate-limited email claim initiation and verification**
  - Files: `src/routes/api/builders/$builderId/claim.ts`, `src/routes/api/builders/claim/verify.ts`, `src/shared/lib/email.ts`, `src/shared/lib/rate-limit.ts`
  - Do: Existing code issues a 24-hour token, rate-limits starts, sends through Resend/dev fallback, consumes a link, and updates claim fields. This task records shipped mechanics only; the source-binding remediation below remains mandatory.
  - Verify: `rg -n "builder-claim|24 \* 60|sendClaimEmail|usedAt|isVerified" 'src/routes/api/builders/$builderId/claim.ts' src/routes/api/builders/claim/verify.ts src/shared/lib/email.ts`

- [x] **Deliver claimed-owner editing UI and API ownership check**
  - Files: `src/routes/_dashboard/me/index.tsx`, `src/routes/api/me/builder/index.ts`, `src/routes/api/me/builder/$builderId.ts`
  - Do: Existing UI edits `claimedTopics` and `openToStatus`; API validation checks the current `claimedByUserId`.
  - Verify: `rg -n "claimedTopics|openToStatus|claimedByUserId" src/routes/_dashboard/me/index.tsx src/routes/api/me/builder/index.ts 'src/routes/api/me/builder/$builderId.ts'`

## Canonical identity and proof

- [ ] **Add canonical claims and hashed request state**
  - Files: `src/shared/lib/db/schema.ts`, `drizzle/0001_canonical_builder_claims.sql`, `drizzle/meta/0001_snapshot.json`, `drizzle/meta/_journal.json`
  - Do: Add `builder_claims` with unique `(source, source_id)`, owner, verification method, revoke fields, and namespaced `metadata`; extend requests with requester, method, token/challenge hashes, attempts, and supersession. Invalidate legacy plaintext tokens and backfill only unambiguous owners; emit conflict counts without PII.
  - Verify: `pnpm db:migrate && pnpm type-check`; run the migration twice against a disposable DB and confirm the second migrate is a no-op.

- [ ] **Implement claim state and proof primitives**
  - Files: `src/shared/lib/claims.ts`, `src/shared/lib/claims.test.ts`
  - Do: Define zod schemas, SHA-256 hashing, constant-time comparison, expiry/replay decisions, canonical-key normalization, supported-method selection, and public claim DTOs as pure functions.
  - Verify: `pnpm test -- src/shared/lib/claims.test.ts`

- [ ] **Implement source-proof adapters**
  - Files: `src/shared/lib/claim-sources/types.ts`, `src/shared/lib/claim-sources/index.ts`, `src/shared/lib/claim-sources/github.ts`, `src/shared/lib/claim-sources/gitlab.ts`, `src/shared/lib/claim-sources/codeberg.ts`, `src/shared/lib/claim-sources/devto.ts`, `src/shared/lib/claim-sources/index.test.ts`
  - Do: Fetch the canonical profile using stable source ID, confirm the challenge in public profile text, optionally return a trusted upstream email, enforce 5-second timeout, and return typed unsupported/not-found/rate-limited results. Never accept client-provided source identity.
  - Verify: `pnpm test -- src/shared/lib/claim-sources/index.test.ts`

- [ ] **Replace arbitrary-email initiation with authenticated source-bound claims**
  - Files: `src/routes/api/builders/$builderId/claim.ts`, `src/routes/api/builders/$builderId/claim.test.ts`, `src/shared/lib/env.ts`, `.env.example`
  - Do: Require session; derive source identity from DB; apply IP and user limits; return a source challenge once or email only the adapter-provided trusted address; hash secrets; supersede older requests. Add `CLAIMABLE_PROFILES_ENABLED` kill switch.
  - Verify: `pnpm test -- 'src/routes/api/builders/$builderId/claim.test.ts' && pnpm type-check`

- [ ] **Make verification transactional and POST-only**
  - Files: `src/routes/api/builders/claim/verify.ts`, `src/routes/api/builders/claim/verify.test.ts`, `src/shared/lib/db/index.ts`
  - Do: Require session, verify hashed/source proof, lock request and canonical claim, atomically consume/upsert, reject replay/conflict/expiry, and stop auto-creating credential accounts. Keep GET temporarily as a non-mutating redirect explaining that the legacy link expired.
  - Verify: `pnpm test -- src/routes/api/builders/claim/verify.test.ts`; run two concurrent verification requests and assert exactly one succeeds.

## Privacy, ownership, and operations

- [ ] **Return an allowlisted public builder DTO**
  - Files: `src/shared/lib/public-builder.ts`, `src/shared/lib/public-builder.test.ts`, `src/routes/api/builders/$builderId.ts`, `src/routes/builders/$builderId.tsx`
  - Do: Select only public columns, join canonical active claim state, zod-serialize it, and exclude row owner IDs, claim owner ID, email, raw metadata, notes, and proof state.
  - Verify: `pnpm test -- src/shared/lib/public-builder.test.ts`; anonymously `curl /api/builders/<fixture-id>` and snapshot the exact keys.

- [ ] **Move owner reads and edits to canonical authorization**
  - Files: `src/routes/api/me/builder/index.ts`, `src/routes/api/me/builder/$builderId.ts`, `src/routes/_dashboard/me/index.tsx`, `src/routes/api/me/builder/claims.test.ts`
  - Do: Resolve all duplicate builder rows through active `builder_claims`; permit only verified owner edits; preserve scraped values separately; show verification/revocation states.
  - Verify: `pnpm test -- src/routes/api/me/builder/claims.test.ts`; cover anonymous, unrelated user, verified owner, revoked owner, and admin.

- [ ] **Gate and aggregate profile-view analytics**
  - Files: `src/routes/api/builders/$builderId/view.ts`, `src/routes/api/builders/$builderId/view.test.ts`, `src/routes/api/me/builder/$builderId/analytics.ts`, `src/routes/api/me/builder/$builderId/analytics.test.ts`, `src/shared/lib/db/schema.ts`, `src/modules/builder-profile/components/BuilderProfilePage.tsx`
  - Do: Write a view only when consent permits; never store IP/fingerprint; expose owner-only aggregates with a minimum cohort threshold and no viewer list.
  - Verify: `pnpm test -- 'src/routes/api/builders/$builderId/view.test.ts' 'src/routes/api/me/builder/$builderId/analytics.test.ts'`; confirm opt-out creates no row.

- [ ] **Add recoverable admin revocation**
  - Files: `src/routes/api/admin/builder-claims/$claimId/revoke.ts`, `src/routes/api/admin/builder-claims/$claimId/revoke.test.ts`, `src/shared/lib/log.ts`
  - Do: Require admin, validate a reason, timestamp revocation, record an audit event, and leave evidence/data intact. Public and owner readers must stop treating the claim as active immediately.
  - Verify: `pnpm test -- 'src/routes/api/admin/builder-claims/$claimId/revoke.test.ts'`; cover non-admin denial and badge disappearance after revocation.

- [ ] **Exercise the complete runtime claim flow**
  - Files: `tests/e2e/claimable-profiles.spec.ts`, `playwright.config.ts`
  - Do: Seed duplicate GitHub rows, complete source challenge as an authenticated user, edit topics/open-to, inspect public DTO/page anonymously, replay the proof, revoke as admin, and verify both duplicates lose active status.
  - Verify: `pnpm exec playwright test tests/e2e/claimable-profiles.spec.ts && pnpm build && pnpm lint && pnpm type-check`
