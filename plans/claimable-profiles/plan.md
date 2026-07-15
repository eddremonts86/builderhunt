# Plan: Claimable Builder Profiles

## Goal recap

Convert BuilderHunt from a one-sided tool (only hunters use it) into a two-sided platform where builders themselves can claim, verify, and enrich their profiles. This unlocks the network-effect flywheel that makes the product defensible.

## Why this is the most strategic feature (and the most expensive)

This is **the** feature that turns BuilderHunt from a tool into a platform. It creates:
- **Defensibility** — once a builder has invested in their profile (topics, open_to, verification), they have switching costs. That's a moat.
- **Data quality** — builders keep their own info fresh. Stale scraped data gets corrected by the source.
- **Acquisition loop** — builders Google themselves, find their profile, claim it, become users. Free acquisition.

But it's also the **most expensive** feature on the list (~5 days, schema changes, email infra, new auth flow, new pages). That's why it's third, not first.

## Phases

### Phase 0: Research (done in plan)

Confirmed: `builders` table exists, auth is Better Auth with email+password, env has `RESEND_API_KEY` slot already.

### Phase 1: Data model

3 changes:
1. **7 new columns on `builders`** (is_claimed, claimed_by, claimed_at, is_verified, verified_at, open_to_status, claimed_topics)
2. **New table `builder_claim_requests`** (token-based email verification)
3. **New table `builder_profile_views`** (analytics + aggregate counts)

Migration applied via `pnpm db:generate && pnpm db:migrate`. **No data backfill** — all new columns default to false / empty.

**Effort:** S (2-3h)

### Phase 2: Public profile page

`/builders/:builderId` — public, no auth.

Critical decision: **the public page already exists** in `src/modules/builder-profile/components/BuilderProfilePage.tsx` (and route `src/routes/_dashboard/builder/$builderId/index.tsx`). But it's behind the `_dashboard` layout, which requires auth.

**Options:**
- (A) Move the page out of `_dashboard` to a public route. Keeps the auth-required "save" actions conditional.
- (B) Create a new public route that mirrors the dashboard one, and deprecate the old one.

**Recommended:** (A) — move the component to `src/routes/builders/$builderId.tsx`. Add conditional CTAs (anonymous → "Claim" or "Sign in to save"; authed → "Save/Note/RSS"; claimed_by_user → "Edit profile"). Remove the old `_dashboard` route.

**Effort:** M (4-6h)

### Phase 3: Claim flow (email verification)

The trust anchor of this feature. Two endpoints:

1. `POST /api/builders/:id/claim` (no auth) — accepts email, sends verification link.
2. `GET /api/builders/claim/verify?token=<token>` (no auth) — validates token, creates user account if needed, marks builder as claimed.

**Why email-only for v1 (no GitHub OAuth):**
- Faster to ship (1 integration vs 2)
- GitHub OAuth requires per-app approval for "user:email" scope
- Email is universal — works for builders not on GitHub (HN-only, Reddit-only, DEV.to-only builders)
- v2 can add GitHub OAuth as a verification strengthener

**Security considerations:**
- Token: 32 bytes random hex, stored hashed
- Expiry: 24h
- One-time use
- Email enumeration: response is always "check your email" regardless of whether the email matches
- Rate limit: 5 claims/day per IP

**Email delivery:** Resend (or console-log in dev). Email contains a single CTA: "Confirm your claim". No marketing.

**Effort:** M (4-6h)

### Phase 4: Builder dashboard

`/me` — auth required, shows the claimed builder's stats.

This is the "come back" loop. Once a builder claims, they have a reason to log in: see who saved them, edit their profile, set "open to" status.

For v1, simple version: "12 people saved you this week, top keywords: rust, async, tokio". Aggregate from `alerts` + `saved_queries` (assuming "saved" is tracked there — verify in schema).

**Effort:** M (4-6h)

### Phase 5: Edit profile

`/me/profile` — auth required, form to update `claimed_topics`, `open_to_status`, and (if scraped bio is empty) `bio`.

Simple PATCH endpoint. No fancy editor. Just chip input for topics, multi-select for open_to, optional textarea for bio.

**Effort:** S (3-4h)

### Phase 6: Polish

- Verified badge (green checkmark with tooltip)
- OG meta tags for public profile pages (great for sharing)
- "Saved by N people" social proof
- Recent activity timeline
- "Less active recently" indicator if `lastSeen > 30 days`

**Effort:** S (3-4h)

### Phase 7: Verification

- Manual: full claim flow, edit profile, verify badge shows up on public page
- Automated: Playwright tests for each path
- Performance: public profile < 200ms, view tracking fire-and-forget

**Effort:** S (3-4h)

### Phase 8: Rollout

- **Soft launch** (1 week): claims enabled, monitor for abuse / disputes
- **In-app banner** for authed users: "Is one of these you? Claim your profile →"
- **Email existing users**: "We indexed N builders. Is one of them you?"
- **Public tweet** when stable

**Effort:** S (1-2h)

## Dependency graph

```
Phase 0 (research) ──> Phase 1 (data model) ──┐
                                              ├──> Phase 2 (public page) ──> Phase 3 (claim) ──> Phase 4 (dashboard) ──> Phase 5 (edit) ──> Phase 6 (polish) ──> Phase 7 (verify) ──> Phase 8 (rollout)
                                                                                                                            └──────────────────────────────────────┘
```

Phase 2 must come before Phase 3 (we need a public page to claim from).
Phase 4 must come before Phase 5 (we need a dashboard before we can edit).

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **Abuse: someone claims another person's profile** | Medium | High | Email verification (must have access to email on profile). v2: disputes + GitHub OAuth verification for stronger proof. |
| **Spam claim requests** | Medium | Medium | Rate limit 5/day/IP. CAPTCHA if abused. |
| **Email deliverability (Resend)** | Low | High | Use Resend's verified domain. SPF/DKIM/DMARC set up. Monitor bounce rate. |
| **Privacy concern: builder's email exposed** | Low | High | Don't display the email anywhere. Only use it to send the claim link. |
| **Builder rejects being indexed** | Medium | Medium | Add "Remove me" button on profile page (no auth required if builder). Soft delete: set `is_public = false`. (v2: full GDPR delete.) |
| **Profile views slow down DB** | Low | Medium | Fire-and-forget insert. No await. Index on `(builder_id, viewed_at DESC)`. |
| **Builder onboarding drop-off** | High | High | Keep claim flow to 2 clicks: enter email → click link. No forced profile completion. |

## Rollback plan

- New columns: nullable / default-false, so removing the column is safe (but not necessary)
- New tables: `DROP TABLE builder_claim_requests CASCADE;` (or just `TRUNCATE`)
- New routes: delete the file, TanStack router auto-removes
- New UI: feature flag `ENABLE_CLAIMABLE_PROFILES=false` to hide the CTA without code rollback

## What this is NOT

- **Not a LinkedIn clone.** No endorsements, no recommendations, no network graph, no feed.
- **Not a profile hosting service.** The builder's canonical profile stays on GitHub/Reddit/etc. BuilderHunt is a discovery layer.
- **Not a recruiter marketplace.** Builders don't apply to jobs here. They just maintain their profile.
- **Not a reputation system.** Verified = "this is the real person". Not = "this person is good".

## What this enables (downstream)

Once claimable profiles work:
1. **GitHub OAuth verification** (v2) — flips to "strongly verified", boosts in search ranking
2. **Public builder directory** (`/builders`) — list of all claimed builders, sortable by topic/country/activity
3. **Disputes & transfers** — "I'm not John Doe, here's proof" / "Transfer this profile to me"
4. **Builder-to-builder intros** — "Other builders in your topic you should know"
5. **Self-service profile deletion** (GDPR)
6. **Direct messages** (v3, only if there's demand) — "John, can I ask you about your async runtime work?"
7. **Profile completeness scoring** — boost search ranking for builders with complete, verified profiles

## Strategic position

This feature is the **most important** of the three, but also the **most expensive** and the **riskiest**. It's the one that, if successful, makes BuilderHunt a platform. If it fails, you've added 5 days of complexity for a feature nobody uses.

**Pre-mortem checklist before starting:**
- Do we have enough indexed builders (>100) for "claim your profile" to be valuable?
- Do we have enough authed users (>50) that the "12 people saved you" stat is non-zero?
- Is the email infrastructure (Resend) actually set up?

If any of these is "no", defer this feature until RSS feeds and proactive discovery have grown the dataset.
