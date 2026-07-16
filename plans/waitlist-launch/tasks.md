# Tasks: Waitlist & Launch

## Phase 0 — Research

- [ ] Check existing `src/routes/_landing/` for inspiration
- [ ] Read `src/shared/lib/email.ts` (already built for claim flow) — reuse for waitlist emails
- [ ] Decide: use existing landing page (modify) or new landing?
- [ ] Set up `RESEND_FROM_ADDRESS` (e.g., `hello@builderhunt.dev`)

## Phase 1 — Data model

- [ ] Add `waitlist` table to schema
- [ ] Add `randomReferralCode()` helper to `src/lib/utils.ts` (8 chars base62)
- [ ] Generate + apply migration

## Phase 2 — Waitlist API

File: `src/routes/api/waitlist/signup.ts` (new, POST)

- [ ] Body: `{ email: string, referralCode?: string }`
- [ ] Validate email
- [ ] If referralCode provided, look up the referrer
- [ ] Generate unique referral code
- [ ] Insert row in `waitlist` with position = current_count + 1
- [ ] If referred: bump referrer's position by -3
- [ ] Send welcome email
- [ ] Return `{ position, referralCode, totalSignups }`

File: `src/routes/api/waitlist/status.ts` (new, GET)

- [ ] Query: `?code=X`
- [ ] Returns `{ position, totalSignups, referralCount, shareLinks }`

File: `src/routes/api/waitlist/stats.ts` (new, GET)

- [ ] Public
- [ ] Returns `{ totalSignups, topReferrers (anonymized), launchedAt }`

## Phase 3 — Landing page

File: `src/routes/_landing/index.tsx` (modify existing)

- [ ] Above the fold: title, value prop, email form
- [ ] Below: 3-step explainer, screenshots, FAQ
- [ ] "You're #N in line" live counter (auto-refresh every 30s)
- [ ] Footer with legal links

## Phase 4 — Signup modal

After form submit:
- Modal: "You're #1247! Share to climb"
- Pre-filled tweet button
- Pre-filled LinkedIn button
- Copy link button
- Close button (back to landing)

## Phase 5 — Status page

File: `src/routes/waitlist.tsx` (new, public)

- [ ] Reads `?code=X` from URL
- [ ] Shows: position, total signups, your referrals, top referrers
- [ ] Share buttons
- [ ] "Estimated launch" countdown

## Phase 6 — Email sequences

File: `src/shared/lib/email-templates/waitlist-welcome.tsx`

- [ ] Welcome email with referral link
- [ ] Pre-header: "Welcome to the BuilderHunt waitlist!"

File: `src/shared/lib/email-templates/waitlist-reminder.tsx`

- [ ] After 7 days no referrals
- [ ] "Quick reminder: 3 friends = 100 spots"

File: `src/shared/lib/email-templates/waitlist-launch.tsx`

- [ ] When we launch
- [ ] "BuilderHunt is live! Sign in."

**Cron jobs** to send:
- `scripts/jobs/waitlist-reminders.ts`: daily, finds waitlist rows > 7 days old with 0 referrals, sends reminder
- `scripts/jobs/waitlist-launch.ts`: one-time, sends launch email when triggered

## Phase 7 — Launch trigger

File: `scripts/jobs/check-launch.ts`

- [ ] Daily, count `waitlist` rows
- [ ] If >= 500 (configurable), trigger launch
- [ ] Send launch email to all waitlist
- [ ] Open registration (already open, but publicize)

## Phase 8 — Marketing content

Blog posts (cross-posted to dev.to):

1. **"I built a 12-source developer search engine"** — founder story + technical
2. **"How to find good developers as a solo founder"** — SEO, value-first
3. **"The 12 sources I use to find developers in 30 seconds"** — listicle
4. **"How I ranked 10,000 developers by activity"** — technical depth
5. **"Building a TanStack Start app in public"** — dev audience

Each post:
- 1000-2000 words
- 2-3 code snippets
- 1-2 screenshots
- CTA to waitlist
- SEO keywords

## Phase 9 — Social media launch kit

**Twitter thread** (8-10 tweets):
- Problem
- Existing solutions and gaps
- BuilderHunt value prop
- 12 sources screenshot
- "Try it" link
- Founder bio

**LinkedIn post** (B2B angle):
- Recruiters spend hours
- BuilderHunt indexes 12 sources
- "Free during beta"

**HN Show post**:
- "Show HN: BuilderHunt – Find active developers across 12 sources"
- Honest about what it is
- "Looking for feedback on X and Y"

## Phase 10 — Verification

### Manual
- [ ] Visit /, see landing
- [ ] Enter email, see position
- [ ] Click referral link in different browser, see position +5
- [ ] Share buttons pre-fill correctly
- [ ] Status page works

### Automated
- [ ] Playwright: signup flow end-to-end
- [ ] Position calculation is correct
- [ ] Referral dedup (same email twice = 1 entry)

### Analytics
- [ ] PostHog events fire correctly
- [ ] Email open rate > 30%
- [ ] Referral share rate > 10%

## Phase 11 — Rollout

- [ ] Soft launch to friends + early waitlist (50-100 people)
- [ ] Get feedback, iterate
- [ ] Public launch: 1 tweet thread + 1 dev.to + 1 HN
- [ ] Goal: 1000 signups in 30 days
- [ ] Goal: viral coefficient > 0.5

## Edge cases

- **Duplicate email**: unique constraint, return existing entry's data (no error)
- **Spam signups**: rate limit 5/hour per IP, CAPTCHA after 3
- **Disposable emails**: blocklist (mailinator, tempmail, etc.)
- **Position gap on referral**: when someone refers, we need to renumber positions. Use UPDATE with ORDER BY created_at
- **Launch before threshold**: admin can manually trigger launch
- **Referrer deleted their email**: still counts as referral

## Dependencies

- New tables: 1 (`waitlist`)
- New package: none
- New env vars: `LAUNCH_NOTIFY_EMAIL`, `RESEND_FROM_ADDRESS`
- New background jobs: 3 (reminders, launch trigger, launch email)
- Marketing: 5 blog posts (1-2 weeks content work)

## Estimated effort: 2-3 weeks
