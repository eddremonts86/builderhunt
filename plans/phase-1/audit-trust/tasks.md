# Tasks: Trust, Claims, and Profile Removal Audit

> **Status**: `partially-implemented` — unsafe-claims cleanup done; the profile-removal
> subsystem (tasks 4-10) is a large, novel, security-critical feature not attempted this pass
> (see summary at the bottom).
> **Depends on**: [`audit-performance-qa`](../audit-performance-qa/spec.md), [`pricing-and-billing`](../pricing-and-billing/spec.md), [`legal-and-compliance`](../legal-and-compliance/spec.md), [`claimable-profiles`](../claimable-profiles/spec.md)
> **Blocks**: [`waitlist-launch`](../waitlist-launch/spec.md)
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
  - Files: `src/routes/__root.tsx`, `src/modules/landing/components/HomePage.tsx`, `src/modules/landing/components/FAQSection.tsx`, `src/modules/landing/components/trust-claims.test.ts` (new)
  - Do: A first grep pass with a bad ripgrep `--type` flag falsely reported these as already clean — rechecked properly and found every single one still live: `aggregateRating: 4.8/124` in the root JSON-LD, `"420M+ profiles"`/`"100K+ dev communities"`/`"1M+ articles"` fabricated per-source scale numbers, a hardcoded `"+128 stars / 7d"` chip mislabeled in its own code comment as "one real, live signal", a fabricated 5-star testimonial attributed to an anonymous "Beta user", a "Join Alerts" email-capture form with no submit handler at all, and FAQ/hero copy describing a user-suppliable GitHub personal access token that has no UI anywhere in the app (`GITHUB_TOKEN` is a server-side operator env var). All removed or corrected without inventing replacement data — the source marquee now says "+ 11 more sources" (real count from `SOURCE_NAMES`) instead of fake numbers, the JSON-LD `featureList` names all 15 real sources.
  - Verify: `rg -n "aggregateRating|420M|Join Alerts|personal access token|paid for itself" src` — clean. New `trust-claims.test.ts` (5 tests) source-asserts each of these can never reappear; `pnpm vitest run` — 2134/2144 passing (10 pre-existing skips), `tsc`/`eslint` clean. Live-verified the JSON-LD via the browser's own parsed `<script type="application/ld+json">` — no `aggregateRating` key, `featureList` lists all 15 sources.
  - Note: no `PROFILE_CLAIMS_ENABLED` kill switch was added under that exact name — `claimable-profiles`' `CLAIMABLE_PROFILES_ENABLED` (added this session) already serves the identical purpose for the same claim flow; adding a second, differently-named flag for the same gate would be redundant, not additive.

- [~] **Create and enforce a single product-claims contract** — lighter substitute shipped, not the full abstraction
  - Do: Instead of a new `product-claims.ts` indirection layer duplicating `billing-shared.ts`/`SOURCE_NAMES` (which already are the sources of truth and already feed `/pricing` per earlier `pricing-optimization` work), added the `trust-claims.test.ts` regression guard above directly against the landing components' source. It's narrower than a generic drift-detector for every possible claim, but it durably locks in the exact fixes this pass made.
  - Deferred: a true generic "any displayed number that drifts from a shipped constant fails CI" contract is real, valuable, future work — not attempted here.

- [ ] **Publish accurate security and removal guidance** — not attempted
  - Files: `src/routes/_landing/security.tsx`, `src/routes/_landing/privacy/remove.tsx`
  - Reason: writing a `/privacy/remove` page describing a removal *process* honestly requires the removal *system* (tasks below) to exist first — publishing instructions for a flow that isn't built would itself be a false claim, the exact failure mode this plan exists to prevent. A `/security` page describing current real practices (operator-managed tokens, no user-PAT collection, standard TLS/at-rest storage) could be written independently, but wasn't reached this pass. Also skips `e2e/trust-copy.spec.ts` (new Playwright file, forbidden this session).

- [ ] **Add additive request and suppression tables**
  - Files: `src/shared/lib/db/schema.ts`, `drizzle/0001_profile_suppressions.sql`, `drizzle/meta/_journal.json`, `drizzle/meta/0001_snapshot.json`, `src/shared/lib/env.ts`, `.env.example`, `.env.production.example`
  - Do: Add the exact request/suppression shapes, status checks, active `(source, source_id)` uniqueness, expiry index, FK/delete behavior, and comments from `spec.md`; store only keyed hashes for email/challenge/normalized URL. Require a dedicated 32-byte `PROFILE_REMOVAL_HMAC_KEY` when removal is enabled and support current/previous key IDs for safe rotation.
  - Verify: `pnpm db:migrate` succeeds twice; schema tests reject duplicate active suppressions and plaintext-sensitive columns; the previous app version still boots against the additive schema.

- [ ] **Add additive request and suppression tables** — not attempted
- [ ] **Implement privacy-safe removal primitives** — not attempted
- [ ] **Build allowlisted source-proof adapters (for removal)** — not attempted
- [ ] **Implement request and verify endpoints (for removal)** — not attempted
- [ ] **Enforce suppression across search and every consumer** — not attempted
- [ ] **Add trust runtime gates and redacted metrics** — not attempted
- [ ] **Roll out source by source without weakening enforcement** — not attempted

Reason for all seven above: together these are a full profile-removal/global-suppression
subsystem — new tables with keyed-hash secrets and rotating HMAC keys, its own source-proof
adapters (distinct from `claim-sources/*`, which prove account *ownership* for claiming rather
than *identity* for opt-out removal), request/verify API endpoints, and enforcement wired into
every read path that can surface a builder (live search, three cache layers, tracking, export,
feeds, alerts). This is comparable in size to the `claimable-profiles` work done earlier this
session — arguably larger, since it must be correct for *every* consumer, not one flow — and is
genuinely new, security- and privacy-critical infrastructure, not a copy/proof-adapter fix. It
deserves a dedicated, focused pass rather than being rushed as one item among several plans in a
single long session. Not attempted; flagged honestly rather than half-built.

- [x] **Replace email-only builder verification with source proof** — done, but by an earlier
  plan in this same session (`claimable-profiles`, 2026-07-25/26), not by this pass
  - This plan's task duplicates that work almost exactly (require a matching source-hosted
    challenge before verification; never auto-verify from arbitrary email alone). See
    `plans/phase-1/claimable-profiles/tasks.md`'s "Canonical identity and proof" section for the
    real file layout (`src/shared/lib/claim-sources/*`, `src/routes/api/builders/$builderId/claim/verify.ts`)
    and live-verification evidence — different paths than this plan's text assumes, since it
    predates that migration, but the same underlying vulnerability is closed.

## Summary for this pass (2026-07-26)

Of the plan's ~10 tasks: the unsafe-claims cleanup (the plan's most publicly visible, most
launch-blocking concern — fabricated rating, fake testimonial, invented scale numbers, dead
email form, false PAT guidance) is done and regression-tested. The claim-verification task was
already done by earlier work this session. The full profile-removal/suppression subsystem (7
tasks) is real, substantial, and honestly deferred — it's a security-critical feature on the
scale of `claimable-profiles`, not a quick copy fix, and this session's scope (no new e2e,
CI/CD edits need confirmation) also blocks several of its verify steps regardless.
