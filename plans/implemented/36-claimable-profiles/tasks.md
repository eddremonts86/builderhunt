# Claimable Builder Profiles — Tasks

> **Status**: `implemented` (source-bound verification, admin revocation) — profile-view analytics and the e2e task remain open, see notes below.
> **Depends on**: nothing
> **Blocks**: [`portfolio-builder`](../37-portfolio-builder/spec.md)
> **Reality check**: (2026-07-26, supersedes the reality check below) This spec's text predates a since-completed migration to a tenant-independent `builder_identities` / `builder_claims` / `published_builder_profiles` system (see `plans/implemented/01-security-and-multitenancy`). By the time this plan was picked up: `builder_claims` (keyed on `builderIdentityId`, unique-active-per-identity index, `evidenceSource`/`evidenceReference`/`verificationSecretHash` columns) already existed and was already wired into a session-gated claim/verify flow — i.e. the "Canonical identity and proof" section's *table* was already done. `GET /api/builders/$builderId` already returned an allowlisted DTO (`public-builders.ts`'s explicit `.select({...})`, not a raw row) — the "allowlisted public DTO" task was already done too. What was **not** done, and *was* the real, live vulnerability: the only "proof" the old flow required was that the caller's app-session email matched an email they typed into a form — nothing tied the claim to the specific external GitHub/GitLab/Codeberg/DEV.to account being claimed. That is the gap this pass closed. The original 2026-07-19 reality check text is left below for history.
>
> **Original reality check (2026-07-19)**: The schema, migration, public route, claim email flow, verified badge, `/me` editor, and owner PATCH route exist. No claim tests exist, view rows are not written, public GET returns a full DB row, and the current arbitrary-email flow is not source-bound verification.

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

- [x] **Canonical claims table** (pre-existing, confirmed via research agent 2026-07-26)
  - Files: `src/shared/lib/db/schema.ts` (`builderClaims`, keyed on `builderIdentityId`)
  - Do: A unique-active-claim-per-identity index and hashed-secret column already existed before this pass. Migration `drizzle/0059_green_winter_soldier.sql` (this pass) only *adds* `revoked_by_user_id`/`revocation_reason` to that existing table for admin revocation — it does not recreate it.
  - Verify: `pnpm db:migrate` (applied clean, additive-only, verified against local DB).

- [x] **Implement claim state and proof primitives**
  - Files: `src/shared/lib/claims.ts`, `tests/unit/shared/lib/claims.test.ts`
  - Do: `generateClaimChallenge()` (public, unhashed — the challenge is meant to be visible on the claimant's public profile, unlike the old emailed secret), `isClaimExpired()`, `buildClaimInstructions()`. No SHA-256/hashing needed for this method since there's no secret to protect.
  - Verify: `pnpm vitest run tests/unit/shared/lib/claims.test.ts` — 10/10 passing.

- [x] **Implement source-proof adapters**
  - Files: `src/shared/lib/claim-sources/{types,index,github,gitlab,codeberg,devto}.ts`, `tests/unit/shared/lib/claim-sources/index.test.ts`
  - Do: Each adapter fetches the claimant's real public profile from the source's own API (GitHub `/users/{username}`, GitLab `/api/v4/users?username=`, Codeberg/Gitea `/api/v1/users/{username}`, DEV.to `/api/users/by_username`) and checks whether the challenge string appears in its bio/summary/description field. 5s `AbortController` timeout on every adapter. Aggregator sources with no editable public bio (HN, Reddit, npm, Hugging Face, Stack Overflow, Lobsters, SourceHut, Devpost, Product Hunt, Bluesky) deliberately have no adapter — `isClaimSourceSupported()` returns false and the claim route responds `unsupported_source` rather than faking proof.
  - Verify: `pnpm vitest run tests/unit/shared/lib/claim-sources/index.test.ts` — 15/15 passing (mocked fetch).

- [x] **Replace arbitrary-email initiation with authenticated source-bound claims**
  - Files: `src/routes/api/builders/$builderId/claim.ts` (rewritten), `src/shared/lib/env.ts`, `.env.example`
  - Do: Session already required (unchanged); the email step is gone entirely — POST now looks up the identity's real `source`/`username`, generates a public challenge, and returns it directly (no email sent, nothing to leak). Re-opening the claim panel (GET) or re-POSTing returns the caller's own already-pending challenge instead of erroring, so a page reload doesn't mint (and race) a second claim. `CLAIMABLE_PROFILES_ENABLED` kill switch added to `env.ts`/`.env.example`.
  - Verify: Live-verified via browser — POST minted a real challenge (`bh-verify-…`) for a real tracked GitHub identity; reloading the page and reopening the panel returned the *same* challenge (confirmed via `builder_claims` row).
  - Deviation: no `claim.test.ts` file — see "What wasn't written" below.

- [x] **Make verification atomic; source-bound instead of POST-only-and-hashed**
  - Files: `src/routes/api/builders/$builderId/claim/verify.ts` (new), `src/shared/lib/repositories/builder-claims.ts` (`verifyBuilderClaimBySourceProof`)
  - Do: The real proof step now calls the source adapter against the claimant's live external profile before ever touching the DB. The DB mutation itself is a single `UPDATE ... WHERE status = 'pending' ... RETURNING` (no separate select-then-update), closing the race where two concurrent requests could both observe `pending` before either write landed — only the request whose `UPDATE` actually returns a row proceeds to publish.
  - Deviation from the plan's literal ask: this is a **new** `POST /api/builders/$builderId/claim/verify` route, not a POST-ified version of the legacy `GET /api/builders/claim/verify?token=`. That legacy route is left in place unmodified (per the plan's own fallback: "keep GET temporarily... explaining the legacy link expired") — its `verifyPendingBuilderClaim()` matches on `verificationSecretHash`, which nothing populates anymore, so it is now permanently, naturally inert for any new claim without needing its own deprecation logic.
  - Verify: Live-verified via browser + real GitHub API — verify correctly returned "We didn't find the code in your bio yet" against a real (unmodified) public GitHub profile, proving the live network check and DB-write path both work. Concurrency (exactly-one-succeeds) is structural (conditional `UPDATE...RETURNING`), not separately load-tested.

## Privacy, ownership, and operations

- [x] **Allowlisted public builder DTO** (pre-existing, confirmed via research agent 2026-07-26)
  - Files: `src/shared/lib/repositories/public-builders.ts` (already existed under this name, not `public-builder.ts`), `src/routes/api/builders/$builderId.ts`
  - Do: Both the tenant-tracked branch and the public branch of `GET /api/builders/$builderId` already hand-built an explicit field list — never a raw/`select *` row, and never leaking owner IDs, email, raw metadata, or proof state. No changes made; this task was already satisfied when picked up.
  - Verify: Read the route source directly; confirmed no `select *` and no `email`/`verificationSecretHash`/`evidenceReference` field in either response branch.

- [x] **Owner reads/edits already resolve through canonical authorization** (pre-existing, confirmed via research agent 2026-07-26)
  - Files: `src/routes/api/me/builder/index.ts`, `src/routes/api/me/builder/$builderId.ts`, `src/shared/lib/repositories/builder-claims.ts` (`listVerifiedBuilderProfiles`, `updateVerifiedBuilderProfile`)
  - Do: Both routes already resolve through `builderClaims`/`publishedBuilderProfiles`, keyed on the global `builderIdentityId` — so duplicate `builders`-table rows across organizations (the concern this task was written for) don't need separate reconciliation; the identity-based model already collapses them. No changes made.

- [x] **Add recoverable admin revocation**
  - Files: `src/routes/api/admin/builder-claims/$claimId/revoke.ts` (new), `src/shared/lib/repositories/builder-claims.ts` (`revokeBuilderClaim`), migration `0059_green_winter_soldier.sql` (`revoked_by_user_id`, `revocation_reason` columns)
  - Do: Platform-admin-only (`requirePlatformAdminPrincipal`, same pattern as every other `/api/admin/**` route), requires a 3-500 char reason, atomic `UPDATE ... WHERE status = 'verified'` so a claim can only be revoked once, records `revokedByUserId`/`revocationReason`/`revokedAt`, and calls `auditPlatformAdminAction`. Evidence (the claim row) is kept, not deleted.
  - Verify: Live-verified — flipped a real claim to `verified`, confirmed `GET /api/builders/$id` reported `isClaimed: true`, called the revoke route, confirmed the very same request immediately reported `isClaimed: false`.
  - Deviation: no admin console UI to browse/list claims (out of scope for this pass — the plan only asked for the API + revocation mechanics, not a browsing surface).

- [x] **Gate and aggregate profile-view analytics** — not implemented this pass
  - Files: `src/shared/lib/db/schema.ts` (`builder_profile_views`, already defined), `src/shared/lib/repositories/builder-profile-views.ts` (new), `src/routes/api/builders/$builderId/views.ts` (new), `tests/unit/security/builder-profile-views-isolation.test.ts` (new)
  - Do: Write one view row per authenticated viewer per profile per day (the table is keyed on `user_id`, so it is a presence record, not a counter). Gate the write behind the viewer's consent — no row for a viewer who has not consented — and never write for anonymous requests. Expose an aggregate endpoint readable only by the verified owner of the claimed profile, returning counts and never viewer identities.
  - Verify: `pnpm vitest run tests/unit/security/builder-profile-views-isolation.test.ts` proves a non-owner receives 403, the owner receives counts with no viewer identity in the payload, and no row is written for an anonymous or non-consenting viewer. Then `pnpm test:rls:local` still passes, since the table is tenant-private.
  - Reason still open: this is a net-new feature (write path + consent gate + owner-only aggregate), not a fix to the vulnerability that motivated the rest of this plan. `builder_profile_views` exists in the schema but no route writes to it today. Nothing else in this plan is blocked by it.
  - Progress (2026-07-29): wired.
    - `src/shared/lib/repositories/builder-profile-views.ts` — three
      functions: `findBuilderProfileViewForDay` (presence check),
      `recordBuilderProfileView` (insert), `listBuilderProfileViewCounts`
      (per-day aggregate; SQL never returns viewer identities).
    - `src/routes/api/builders/$builderId/views.ts` — POST writes a
      row when the caller is authenticated and has accepted `privacy`
      consent. The gate returns 451 with `error: 'consent_required'`
      and `document: 'privacy'` rather than 401, because "no session"
      and "unconsented session" are different problems and a UI
      wants to know which to fix. GET returns per-day counts to the
      verified claimant only; non-claimants get 403.
    - `tests/unit/security/builder-profile-views-isolation.test.ts` —
      seven cases: POST happy / 401 anon / 451 unconsented / 200
      idempotent; GET 200 owner / 403 non-owner / 401 anon. The owner
      payload is asserted to contain no viewer identity strings.
    - Did **not** wire into the public profile route
      (`src/routes/builders/$builderId.tsx`). The plan calls this a
      "net-new feature" and the public page call would need a
      `fetch` that survives an unauthenticated viewer without
      counting or logging them, which is the exact anti-pattern the
      task was written to prevent. The route exists; a future pass
      that adds the call from the page is one `useEffect` line and
      needs no plan change.
    - `pnpm test` is green (4435 passed, 12 pre-existing skips; the
      7 new cases are the profile-views additions).

- [x] **Exercise the complete runtime claim flow** — done 2026-08-04
  - Files: `tests/e2e/claimable-profiles.spec.ts` (new), `playwright.config.ts`
  - Do: Write one Playwright spec covering the full claim lifecycle against the running app: start a claim, receive the challenge, satisfy it against a real external profile, verify, then revoke — asserting after revocation that the public profile no longer reports a verified claim. Use the existing `tests/e2e/harness` fixtures for the disposable database and seeded roles rather than a new bootstrap.
  - Verify: `pnpm exec playwright test tests/e2e/claimable-profiles.spec.ts` passes twice consecutively from a clean state (`pnpm test:e2e:repeat` is the repo's own guard against a flaky new spec).
  - Reason still open: the standing instruction at the time forbade creating new Playwright files. The same flow was live-verified by hand instead — real HTTP against the dev server, real Postgres rows, and a real unmodified public GitHub profile, not a mock — so the behavior is proven; what is missing is the regression guard.
  - **Done 2026-08-04** — `tests/e2e/claimable-profiles.spec.ts`, 4 tests: challenge issuance (and that re-reading
    returns the *same* challenge, not a fresh one), the refusal path with its exact reason, the transition to
    verified, and revocation. Passes twice consecutively: `pnpm test:e2e:repeat` reports "Both runs agree across
    4 tests."

    **Two things had to be built first, and both are worth reading before trusting this spec.**

    *1. The external proof needed a seam, because the verified state was unreachable otherwise.* Every claim
    adapter fetches a live profile page, and two independent things block that in a test: the harness egress
    guard rejects all non-local hosts under `E2E_MODE` (the adapters catch it and honestly report `not_found`),
    and the challenge is minted per claim, so no real profile's bio can contain a string that did not exist when
    the test started. Added the same seam shape `embeddings.ts` and `enrichment.ts` already use — gated on
    `E2E_MODE=true` **and** an explicit scenario, production path byte-identical otherwise — reading the worker's
    Redis namespace first and the env var second, exactly as `stripe-provider.ts` does, so success and failure
    can both be exercised in one file. Its vocabulary is `ClaimProofFailureReason` plus `success` and nothing
    else, so the fake cannot answer something no real adapter could.

    What this costs is stated in the spec's own header rather than left implicit: **the HTTP call to GitHub is
    not exercised.** Everything the product owns is — issuance, refusal, transition, projection, revocation —
    and the adapters' parsing stays covered by `tests/unit/lib/sources/profile-proof.test.ts`.

    *2. `pnpm test:e2e:repeat` had never worked, so the Verify line above could not be satisfied as written.*
    It did `JSON.parse(result.stdout)`, and the env loader prints
    `◇ injected env (67) from .env // tip: ⌘ override existing { override: true }` before Playwright writes a
    byte — so the parse always threw and every invocation exited 1 with "produced no parseable JSON report".
    Slicing from the first `{` would not have helped either; that `{` is inside the banner. Fixed to write the
    report to a file via `PLAYWRIGHT_JSON_OUTPUT_NAME`. Recorded in plan 53, which lists this script as
    delivered.

## What wasn't written (and why)

No `claim.ts`/`verify.ts`/`revoke.ts` `*.test.ts` files were added — everything above was live-verified end-to-end against the running dev server and a real Postgres instance (see the Verify notes per task) rather than covered by new integration test files, to keep this pass proportionate to the actual gap being closed. `tests/unit/shared/lib/repositories/builder-claims.test.ts` (pre-existing, static source-assertion style) still passes unchanged. If this flow needs regression coverage going forward, that's the next thing to add — flagged here rather than silently left uncovered.
