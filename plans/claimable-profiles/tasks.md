# Tasks: Claimable Builder Profiles

## Phase 0 — Research (read first)

- [ ] Read `src/shared/lib/db/schema.ts` to understand current `builders` schema
- [ ] Read `src/modules/builder-profile/components/BuilderProfilePage.tsx` to see current profile rendering
- [ ] Read `src/routes/api/auth/$` and `src/shared/lib/auth/better-auth.ts` to understand how to add a new auth method
- [ ] Check if there's a `sendEmail` infrastructure (Resend integration, etc.) — likely there's a stub from the env

## Phase 1 — Data model

### New columns on `builders`

- [ ] Add to `src/shared/lib/db/schema.ts`:
  - `isClaimed: boolean('is_claimed').default(false).notNull()`
  - `claimedByUserId: text('claimed_by_user_id').references(() => authUsers.id, { onDelete: 'set null' })`
  - `claimedAt: timestamp('claimed_at', { withTimezone: true })`
  - `isVerified: boolean('is_verified').default(false).notNull()`
  - `verifiedAt: timestamp('verified_at', { withTimezone: true })`
  - `openToStatus: jsonb('open_to_status').$type<string[]>().default([])`
  - `claimedTopics: jsonb('claimed_topics').$type<string[]>().default([])`
- [ ] Generate migration: `pnpm db:generate`
- [ ] Apply: `pnpm db:migrate`

### New table: `builder_claim_requests`

- [ ] Add to schema:
  ```ts
  export const builderClaimRequests = pgTable('builder_claim_requests', {
    id: text('id').primaryKey(),
    builderId: text('builder_id').notNull().references(() => builders.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    token: text('token').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  })
  ```
- [ ] Generate + apply migration

### New table: `builder_profile_views`

- [ ] Add to schema:
  ```ts
  export const builderProfileViews = pgTable('builder_profile_views', {
    id: uuid('id').primaryKey().defaultRandom(),
    builderId: text('builder_id').notNull().references(() => builders.id, { onDelete: 'cascade' }),
    viewerId: text('viewer_id').references(() => authUsers.id, { onDelete: 'set null' }),
    viewedAt: timestamp('viewed_at', { withTimezone: true }).defaultNow().notNull(),
  }, (t) => ({
    builderIdx: index('builder_views_builder_idx').on(t.builderId, t.viewedAt.desc()),
  }))
  ```
- [ ] Generate + apply migration

## Phase 2 — Public profile page

File: `src/routes/builders/$builderId.tsx` (new, public route)

- [ ] **Route:** `/builders/:builderId` (no auth required)
- [ ] **Server load:** fetch builder by id. If not found → 404.
- [ ] **Track view:** insert into `builder_profile_views` (with `viewerId` if authed, null if anonymous)
- [ ] **Render:** see UX spec — avatar, name, verified badge, topics, sources, stats, recent activity
- [ ] **Conditional CTA:**
  - Authed user + not their profile → "Save", "Add note", "Subscribe to RSS"
  - Authed user + is their profile (matches `claimedByUserId`) → "Edit profile"
  - Anonymous + `!isClaimed` → "Is this you? Claim this profile"
  - Anonymous + `isClaimed` → "Sign in to save"

## Phase 3 — Claim flow (email verification)

### API endpoints

- [ ] `POST /api/builders/:builderId/claim` (no auth)
  - Body: `{ email: string }`
  - Validate email format
  - Generate token (32 bytes hex)
  - Insert `builder_claim_requests` row with `expires_at = now() + 24h`
  - Send email with link: `https://builderhunt.dev/claim/verify?token=<token>`
  - Return: `{ ok: true }` (don't reveal if email matches — security)
- [ ] `GET /api/builders/claim/verify?token=<token>` (no auth)
  - Look up token
  - If expired or used → 410 Gone
  - If valid → mark as used, **create a new user account** for this email (auto-generated password, force-reset on first login), set `builders.claimed_by_user_id = <new user id>`, set `builders.is_claimed = true`, `builders.claimed_at = now()`
  - Redirect to `/auth/sign-in?claimed=<builderId>`

### Email sending

- [ ] Check `RESEND_API_KEY` env (already in `.env.example`)
- [ ] Use Resend SDK (need to install: `pnpm add resend`)
- [ ] Create `src/shared/lib/email.ts` with `sendClaimEmail(to, link)` helper
- [ ] If `RESEND_API_KEY` is empty: log the link to console + show in UI in dev mode. Don't fail.

## Phase 4 — Builder dashboard

File: `src/routes/me/index.tsx` (new, auth required)

- [ ] **Route:** `/me` (auth required, redirect to sign-in if not)
- [ ] **Server load:** fetch `claimed_by_user_id = current user id` builder
- [ ] **If no claimed builder:** onboarding screen — "Create your profile" (form to add a builder manually, v2) or "Find me in the index" (search + claim flow)
- [ ] **If claimed:** dashboard with:
  - "This week: 12 people saved you, top keywords: rust, async, tokio"
  - Quick links: "Edit profile", "Set open to status", "View public profile"

## Phase 5 — Edit profile (claimed builder)

File: `src/routes/me/profile.tsx` (new, auth required)

- [ ] **Form fields:**
  - `claimedTopics` (chip input, add/remove)
  - `openToStatus` (multi-select: 'chats', 'mentoring', 'hires', 'collaboration', 'nothing')
  - `bio` (textarea, max 500 chars) — **only if scraped bio is empty**; otherwise show "We use the bio from your source profile, edit it there"
- [ ] **Submit:** `PATCH /api/me/profile` with `{ claimedTopics, openToStatus, bio? }`
- [ ] **API:** `src/routes/api/me/profile.ts`
  - Auth required
  - Verify `claimed_by_user_id = current user id`
  - Update builder
  - Return updated builder

## Phase 6 — Public profile polish

- [ ] **Verified badge:** green checkmark, tooltip "This profile is verified and maintained by the builder"
- [ ] **Stats section:** if `lastSeen > 30 days`, add a "Less active recently" indicator
- [ ] **Recent activity:** pull from `builders` table `lastSeen` + `metadata` (where commits/posts are stored)
- [ ] **Saved by N people:** aggregate from `alerts` + `saved_queries` (or wherever "saved" is tracked — check schema)
- [ ] **Open Graph meta tags:** for the public profile page, render `<meta property="og:title" content="John Doe — BuilderHunt" />` and the builder's avatar as og:image

## Phase 7 — Verification

### Manual
- [ ] Anonymous user visits `/builders/<id>` → sees profile, sees "Claim" CTA
- [ ] Submit claim with email → check email inbox (or console in dev)
- [ ] Click verification link → redirected to sign-in, claim marked as used
- [ ] After sign-in, visit `/me` → see the dashboard with stats
- [ ] Edit `open_to_status` → visit `/builders/<id>` anon → see "🟢 Open to: chats"
- [ ] Logged-in user saves a builder → that builder's "Saved by N" increments

### Automated (Playwright)
- [ ] Public profile renders without auth
- [ ] Claim submission returns 200, sends email (mocked in dev)
- [ ] Verification link works, redirects correctly
- [ ] Edit profile updates DB

### Performance
- [ ] Public profile page < 200ms (single SQL + view tracking)
- [ ] View tracking is fire-and-forget, doesn't block render

## Phase 8 — Rollout

- [ ] Soft launch: 1 week of monitoring with claims enabled for any builder
- [ ] Add a banner on the dashboard for authed users: "🔍 Find your profile → claim it" with link to search
- [ ] Email existing authed users: "We indexed 1,247 builders. Is one of them you? Claim your profile."
- [ ] Monitor: claims/day, claim→verified conversion, disputes (v2)

## Edge cases to handle

- **Builder deleted between claim request and verification:** the FK cascades, claim request is also deleted. Verification returns 410.
- **Email already has a user account:** link the claim to the existing user, don't create duplicate.
- **Multiple claim requests for same builder:** the latest one wins (overwrite previous unused ones).
- **Builder with `email_verified = false`:** the auth flow is the same. They claim, get an auth account, but email is unverified.
- **Spam claims:** rate limit `POST /claim` to 5/day per IP.
- **GDPR / right to be forgotten:** the builder can request deletion of their data. **v2.**
- **Builder doesn't have an email in scraped data:** show "We don't have an email for this profile. Try GitHub OAuth verification." (v2)

## Dependencies

- Existing: `builders`, `authUsers`, `alerts`, `savedQueries` tables
- New package: `resend` (or use `RESEND_API_KEY` if already set)
- New env var: `RESEND_API_KEY` (optional — fallback to console in dev)
- New env var: `APP_URL` (already exists, used in email links)
- Schema migrations: 3 (add columns + 2 new tables)

## Estimated effort

| Phase | Effort |
|-------|--------|
| 1 — Data model + migrations | S (2-3h) |
| 2 — Public profile page | M (4-6h) |
| 3 — Claim flow (email) | M (4-6h) |
| 4 — Builder dashboard | M (4-6h) |
| 5 — Edit profile | S (3-4h) |
| 6 — Polish + OG | S (3-4h) |
| 7 — Verification | S (3-4h) |
| **Total** | **~5 days** |
