# Tasks: Trust, Claims, and Profile Removal Audit

> **Status**: `implemented` — the profile-removal/global-suppression subsystem (tasks 4-10),
> deferred in the 2026-07-26 pass below, was built in a dedicated follow-up pass the same day
> (see the "Profile-removal subsystem" summary at the bottom).
> **Depends on**: [`audit-performance-qa`](../49-audit-performance-qa/spec.md), [`pricing-and-billing`](../31-pricing-and-billing/spec.md), [`legal-and-compliance`](../04-legal-and-compliance/spec.md), [`claimable-profiles`](../36-claimable-profiles/spec.md)
> **Blocks**: [`waitlist-launch`](../54-waitlist-launch/spec.md)
> **Reality check (2026-07-26)**: The plan's own claim-verification concern ("email ownership
> alone currently marks any builder claim verified") was independently fixed earlier this session
> by `claimable-profiles` — claims now require proving control of the actual external account via
> a bio-published challenge, checked against the real source API. That closes this plan's task 9
> in substance (different file layout than this plan's text assumes, since it predates that work).
>
> **Original reality check (2026-07-19)**: `/pricing`, legal/privacy controls, public profiles, and
> claim email routes are shipped. User PAT entry, a functioning landing alert form,
> source-ownership proof, and global de-indexing are not shipped; the current claim email can be
> controlled by anyone.

- [x] **Disable unsafe claims and remove unsupported public claims**
  - Files: `src/routes/__root.tsx`, `src/modules/landing/components/HomePage.tsx`, `src/modules/landing/components/FAQSection.tsx`, `tests/unit/modules/landing/components/trust-claims.test.ts` (new)
  - Do: A first grep pass with a bad ripgrep `--type` flag falsely reported these as already clean — rechecked properly and found every single one still live: `aggregateRating: 4.8/124` in the root JSON-LD, `"420M+ profiles"`/`"100K+ dev communities"`/`"1M+ articles"` fabricated per-source scale numbers, a hardcoded `"+128 stars / 7d"` chip mislabeled in its own code comment as "one real, live signal", a fabricated 5-star testimonial attributed to an anonymous "Beta user", a "Join Alerts" email-capture form with no submit handler at all, and FAQ/hero copy describing a user-suppliable GitHub personal access token that has no UI anywhere in the app (`GITHUB_TOKEN` is a server-side operator env var). All removed or corrected without inventing replacement data — the source marquee now says "+ 11 more sources" (real count from `SOURCE_NAMES`) instead of fake numbers, the JSON-LD `featureList` names all 15 real sources.
  - Verify: `rg -n "aggregateRating|420M|Join Alerts|personal access token|paid for itself" src` — clean. New `trust-claims.test.ts` (5 tests) source-asserts each of these can never reappear; `pnpm vitest run` — 2134/2144 passing (10 pre-existing skips), `tsc`/`eslint` clean. Live-verified the JSON-LD via the browser's own parsed `<script type="application/ld+json">` — no `aggregateRating` key, `featureList` lists all 15 sources.
  - Note: no `PROFILE_CLAIMS_ENABLED` kill switch was added under that exact name — `claimable-profiles`' `CLAIMABLE_PROFILES_ENABLED` (added this session) already serves the identical purpose for the same claim flow; adding a second, differently-named flag for the same gate would be redundant, not additive.

- [~] **Create and enforce a single product-claims contract** — lighter substitute shipped, not the full abstraction
  - Do: Instead of a new `product-claims.ts` indirection layer duplicating `billing-shared.ts`/`SOURCE_NAMES` (which already are the sources of truth and already feed `/pricing` per earlier `pricing-optimization` work), added the `trust-claims.test.ts` regression guard above directly against the landing components' source. It's narrower than a generic drift-detector for every possible claim, but it durably locks in the exact fixes this pass made.
  - Deferred: a true generic "any displayed number that drifts from a shipped constant fails CI" contract is real, valuable, future work — not attempted here.

- [x] **Publish accurate security and removal guidance**
  - Files: `src/routes/_landing/security.tsx`, `src/routes/_landing/privacy/remove.tsx`, `src/shared/components/Footer.tsx`
  - Do: `/security` states the exact facts spec.md requires (operator-managed credentials only, no user-PAT field anywhere, HTTPS in transit, secrets never rendered/logged, public data may be cached per org, removal vs. deletion are distinct, subprocessors match the privacy policy) and deliberately does **not** claim encryption at rest — no runtime evidence exists for that. `/privacy/remove` is the real two-step request/verify UI (paste a profile URL → get a challenge → paste it into the profile bio → verify), wired to the endpoints below, not a description of a nonexistent process. Footer links added for both.
  - Verify: live-verified in the browser (see subsystem summary below) — both pages render correctly in dark mode with no console errors; `/privacy/remove` end-to-end against the real GitHub API.

- [x] **Add additive request and suppression tables**
  - Files: `src/shared/lib/db/schema.ts` (`profileRemovalRequests`, `profileSuppressions`), `drizzle/0063_dark_gideon.sql`, `drizzle/0064_profile_removal_grants.sql`, `src/shared/lib/env.ts`, `.env.example`
  - Do: Exact request/suppression shapes, status checks, active `(source, source_id)` partial-unique index, expiry index, and comments from `spec.md`; `normalizedProfileUrl` is plaintext on the *request* row (spec.md's own concrete schema — needed for the human-readable audit trail before verification) but only ever stored as a keyed HMAC hash (`normalizedProfileUrlHash`) on the *suppression* row. `PROFILE_REMOVAL_HMAC_KEY`/`PROFILE_REMOVAL_HMAC_KEY_PREVIOUS` added to `env.ts` with a superRefine requiring 64 hex chars and rejecting reuse of `BETTER_AUTH_SECRET` when the feature is enabled; both no-owning-subject tables get GRANT-only access (no RLS), same pattern as `conversion_events`/`status_checks`.
  - Verify: `pnpm db:migrate` applied cleanly; `pnpm vitest run` 2306/2316 passing (10 pre-existing skips); `node scripts/db/verify-migration-integrity.mjs` valid.

- [x] **Build allowlisted source-proof adapters (for removal)**
  - Files: `src/lib/sources/profile-proof.ts` (+test, 18 tests)
  - Do: A structurally separate module from `claim-sources/*` (per spec.md: proves *identity* for opt-out, not *ownership* for claiming) covering github/gitlab/codeberg/devto, each returning the same `sourceId` convention `builders.sourceId` already uses for that source. Hardened beyond `claim-sources/*`: no redirect following (`redirect: 'manual'`), a response-size cap enforced by reading the stream incrementally rather than trusting `Content-Length`, and a bounded fetch timeout. Only `verifyChallenge` calls the upstream API — no separate "resolve identity" call exists, so the *request* endpoint (see below) never touches a third-party host and can't be used to probe whether a username exists.
  - Verify: `pnpm vitest run tests/unit/lib/sources/profile-proof.test.ts` — 18/18 passing, including redirect/oversized-response defenses.

- [x] **Implement privacy-safe removal primitives**
  - Files: `src/shared/lib/profile-removal.ts` (+test, 15 tests), `src/shared/lib/repositories/profile-removal.ts`, `src/shared/lib/profile-suppression.ts` (+test, 5 tests)
  - Do: `normalizeProfileUrl` allowlists exactly `https://<github.com|gitlab.com|codeberg.org|dev.to>/<single-username-segment>`. `generateRemovalChallenge` mints 256 bits of entropy (`randomToken(32)`). `requestProfileRemoval` always returns the same `{kind:'issued', ...}` shape for any valid, supported URL regardless of whether the identity has a pending/verified/no prior record (spec.md's enumeration-resistance requirement); a stale pending request is superseded (marked `rejected`) rather than ever reissuing a lost plaintext challenge. `verifyProfileRemoval` treats a caller-supplied `{requestId, challenge}` matching the stored HMAC hash as the entire authorization check (no session needed — see the module's own comment for why that's sound), then re-checks the source's live bio via `profile-proof.ts`, inserts the suppression, and deletes every matching `builders` row across every organization (`deleteBuildersAcrossOrganizations`, the same `listWorkerOrganizationIds`/`withWorkerOrganization` cross-org sweep pattern `billing-worker.ts`/`alerts-worker.ts` already establish). `profile-suppression.ts` is the read-time enforcement filter (60s in-process cache, invalidated immediately on verify).
  - Verify: `pnpm vitest run tests/unit/shared/lib/profile-removal.test.ts tests/unit/shared/lib/profile-suppression.test.ts` — 20/20 passing against a real disposable Postgres database, including a full request→verify→suppression-inserted→builders-row-deleted round trip.

- [x] **Implement request and verify endpoints (for removal)**
  - Files: `src/routes/api/privacy/profile-removal.ts`, `src/routes/api/privacy/profile-removal/verify.ts`, `scripts/check-route-coverage.mjs`
  - Do: Both deliberately unauthenticated (allowlisted with a stated reason in the route-coverage script — the requester need not have a BuilderHunt account, and possessing the exact challenge is the verify step's own authorization). Request is rate-limited by IP and by IP+profile; verify is rate-limited by IP+requestId, since checking the live upstream bio is the expensive/abusable step.
  - Verify: live-verified in the browser against `https://github.com/octocat` — request issued a real 256-bit challenge; verify made a real call to the GitHub API and correctly reported "could not find the code in your bio yet" (proving the full pipeline end-to-end without needing to control a real account's bio to prove the happy path, which the disposable-DB integration test already covers with a mocked upstream response).

- [x] **Enforce suppression across search and every consumer**
  - Files: `src/lib/search.ts`, `src/routes/api/builders/track.ts`, `src/routes/api/builders/$builderId.ts` (+`src/shared/lib/repositories/public-builders.ts` sourceId fix), `src/routes/api/builders/recent/index.ts`, `src/routes/api/export/builders.ts`
  - Do: `searchBuilders`'s in-memory cache hit, Redis cache hit, and live-fetch paths all filter through `filterSuppressed` before returning — which transitively covers `/api/recommendations`, `/api/feeds/$searchId`, and the alerts worker, since all three call `searchBuilders` rather than duplicating search logic. `track.ts` refuses to track a suppressed `(source, sourceId)`. The public `GET /api/builders/$builderId` route (reads `builder_identities`/`published_builder_profiles`, a separate table from `builders`) now checks `isSuppressed` before returning a published profile.
  - Scope decision: enforcement covers every surface spec.md names by name. It does **not** additionally cascade-delete the canonical `organization_builders`/`builder_identities` rows security-and-multitenancy's still-in-progress dual-write migration is populating in parallel with the legacy `builders` table — doing so would need new DELETE grants/RLS policies on tables owned by that separate, currently-mid-cutover plan (`organization_builders` has a `RESTRICT` FK to `builder_identities`, so a full purge needs a cross-org sweep there too before the identity row itself can go). `listRecentOrganizationBuilders`/`listOrganizationBuilders` (the `/api/builders/recent` and `/api/export/builders` routes) already read-time filter through `filterSuppressed`, so a suppressed identity is invisible on every currently-shipped surface even though its canonical-table row isn't cascade-deleted yet. Revisit once security-and-multitenancy's task 17/18 canonical cutover lands.
  - Verify: `pnpm vitest run tests/unit/lib/search.test.ts` and the full suite — all passing; `tsc --noEmit` clean across every touched file.

- [x] **Add trust runtime gates and redacted metrics** — done 2026-08-03
  - Files: `src/routes/api/admin/metrics/index.ts`, `src/shared/lib/repositories/profile-removal.ts`,
    `tests/unit/security/profile-removal-metrics-redaction.test.ts` (new)
  - Do: Expose removal-request counts by state and by source on the admin metrics endpoint, carrying
    no requester identity, no email and no free-text reason — counts and states only. Refuse to serve
    the block at all while `PROFILE_REMOVAL_ENABLED` is false, so the metric cannot imply a live
    feature.
  - Verify: `pnpm vitest run tests/unit/security/profile-removal-metrics-redaction.test.ts` asserts
    the payload contains counts and no field that could identify a requester, and that the block is
    absent when the flag is off. `pnpm security:route-coverage` still passes.

  **Done 2026-08-03.** `getRemovalRequestMetrics` in `src/shared/lib/repositories/profile-removal.ts` returns
  `byStatus`, `bySource` and `total` — nothing else. `src/routes/api/admin/metrics/index.ts` includes the block
  only when `PROFILE_REMOVAL_ENABLED === 'true'`.

  **Absent, not zero, while the feature is off.** With removals disabled nobody can file one, so an all-zeros
  block would be a lie of implication: a dashboard would render "0 pending" and an operator would conclude the
  queue is empty rather than that the door is shut. Omitting the key is the only answer that cannot be misread.

  **What is deliberately missing, each for its own reason.** No requester identity *including the hashed email*
  — a hash is not anonymous, it is a join key: two systems holding the same hash can be correlated, and an
  operator with a candidate address can confirm a match by hashing it themselves. No profile URL or source id,
  because that pair identifies the person as precisely as a name. No free-text reason: people explain themselves
  in those fields, often about harassment or safety, and that text has exactly one legitimate reader — whoever
  processes the request. No per-request timestamps, since a `createdAt` plus a source narrows a request to one
  person on a quiet day.

  **The test is written as a denial, not a confirmation.** It seeds a row where every field is a recognisable
  canary and requires that none appears anywhere in the serialized payload. A test listing the fields it expects
  would pass forever while a future column joined the aggregate by accident; a test listing the values that must
  never appear fails the moment one does, whatever it is called and however deeply nested. A companion assertion
  pins the *shape* — exactly three keys — so a new field cannot be published without someone deciding it is safe.

  Verified: 4 tests pass; `security:route-coverage` valid (202 routes); `tests/unit/security` and
  `tests/unit/routes/api/admin` together 490 passed; tsc 0, eslint 0.

Moved to [`plans/phase-5/01-production-readiness-audit`](../../phase-5/01-production-readiness-audit/tasks.md)
on 2026-07-29, deliberately not as a checkbox: the maintainer's decision on `PROFILE_REMOVAL_ENABLED`. It waits on a live
deployment and on time passing, so keeping it here made this plan permanently unfinishable while the
work it describes was complete. Phase 5 is the MVP/Beta-to-production gate and is where it belongs.


- [x] **Replace email-only builder verification with source proof** — done, but by an earlier
  plan in this same session (`claimable-profiles`, 2026-07-25/26), not by this pass
  - This plan's task duplicates that work almost exactly (require a matching source-hosted
    challenge before verification; never auto-verify from arbitrary email alone). See
    `plans/phase-1/36-claimable-profiles/tasks.md`'s "Canonical identity and proof" section for the
    real file layout (`src/shared/lib/claim-sources/*`, `src/routes/api/builders/$builderId/claim/verify.ts`)
    and live-verification evidence — different paths than this plan's text assumes, since it
    predates that migration, but the same underlying vulnerability is closed.

## Summary for the unsafe-claims pass (2026-07-26, morning)

The unsafe-claims cleanup (the plan's most publicly visible, most launch-blocking concern —
fabricated rating, fake testimonial, invented scale numbers, dead email form, false PAT guidance)
is done and regression-tested. The claim-verification task was already done by earlier work this
session. The full profile-removal/suppression subsystem was flagged as real, substantial work
deserving a dedicated pass rather than being rushed — see below for that pass.

## Profile-removal subsystem (2026-07-26, dedicated follow-up pass)

Built the entire deferred subsystem: two new tables (GRANT-only, no RLS — no owning tenant),
env-gated HMAC keys with rotation support, source-proof adapters for github/gitlab/codeberg/devto,
the core request/verify service (256-bit challenges, hash-only storage, enumeration-resistant
responses, cross-org `builders` row deletion on verify), a read-time suppression filter wired into
every named consumer surface (search's three paths, track, public profile, recent, exports — with
recommendations/feeds/alerts covered transitively through `searchBuilders`), two public API routes,
and the `/security` + `/privacy/remove` pages. 2306/2316 tests passing (10 pre-existing skips),
`tsc`/`eslint` clean, live-verified in the browser including a real end-to-end call against the
GitHub API. Left off, honestly: a runtime readiness gate and staged rollout (meaningless before a
maintainer decides to turn `PROFILE_REMOVAL_ENABLED` on in production — the flag itself, off by
default, is the safety net until then), and cascade-deleting the separate canonical
`organization_builders`/`builder_identities` tables security-and-multitenancy's still-in-progress
migration is populating in parallel (every currently-shipped surface already read-time filters
those tables too, so nothing is visibly leaked — this is a data-hygiene follow-up, not a
suppression-correctness gap). `product-claims.ts` remains the lighter substitute decided against
in the morning pass (see above) — nothing in this follow-up changed that call.
