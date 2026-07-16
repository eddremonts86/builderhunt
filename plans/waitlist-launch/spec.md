# Feature: Waitlist & Launch (Viral Pre-Launch)

## Problem

BuilderHunt está construido pero no tenemos audiencia. Lanzar al vacío = 0 signups.

Si abrimos sin tracción:
1. **No hay feedback loop** para iterar
2. **No hay social proof** para convertir
3. **No hay momentum** para marketing posterior
4. **Damos la impresión de "proyecto muerto"** desde día 1

## Goal

Sistema de waitlist con mecánica viral:
- **Landing page** con countdown + email signup
- **Referral mechanism**: cada user trae 1-3 amigos (viral coefficient > 1)
- **Position in queue**: cuanto más refieres, más arriba
- **Early access tiers**: tier 1 = primeros 100, tier 2 = siguientes 500, etc.
- **Launch**: cuando lleguemos a 1000 signups, abrimos

**Target**: 1000 emails en 30 días, 200K en 6 meses

## Non-goals (v1)

- **No es Product Hunt launch automation.** Manual launch el día 0
- **No es Hacker News front-page strategy.** v1: post when ready
- **No es paid ads.** v1: organic only (Twitter, dev.to, Reddit)
- **No es a closed beta.** Open waitlist, public landing
- **No es referral rewards.** The reward is "skip the queue" + "Pro free for 1 year" for top referrers

## User stories

1. **Como visitante**, quiero ver la propuesta de valor y dejar mi email
2. **Como visitante**, quiero ver "estás #1247 en la cola" — me da transparencia
3. **Como user en la waitlist**, quiero un link compartible que me dé más posiciones cuando alguien lo usa
4. **Como top referrer**, quiero ser reconocido (badge, free Pro, etc.)
5. **Como admin**, quiero ver la waitlist entera, export a CSV, segmentar

## Landing page (`/` for unauthenticated)

**Above the fold**:
```
BuilderHunt
Find active developers across 12 sources in 30 seconds.

[ Email ]  [ Get early access ]

"You're #1247 in line · 247 builders already waiting"
```

**Below the fold**:
- Value prop: 12 sources, real-time, daily picks
- Social proof: "247 builders waiting" / "X devs signed up this week"
- How it works: 3-step explainer
- Screenshots / GIFs
- FAQ

## Referral mechanism

Each waitlist signup gets a unique referral code (8 chars, base62).
- Referred user gets +5 positions
- Referrer gets +3 positions per signup (capped to prevent gaming)
- After 10 referrals: Pro for 1 year free
- After 25 referrals: lifetime Pro
- Top 10 referrers (when launching): announced in launch post, "BuilderHunt Founding Member" badge

**Sharing UX**:
- After signup, show big "Share to skip the line" panel
- Pre-filled tweet: "Just joined the BuilderHunt waitlist. Find active devs across 12 sources: [link]"
- Pre-filled LinkedIn: "..."
- Copy link button
- "Invite 3 friends to skip 100 positions"

## Data model

**New table: `waitlist`**

```sql
CREATE TABLE waitlist (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  referral_code text NOT NULL UNIQUE,
  referred_by text REFERENCES waitlist(id),  -- the waitlist id, not email
  position int NOT NULL,  -- calculated on insert and on each referral
  status text NOT NULL DEFAULT 'pending',  -- 'pending' | 'invited' | 'active'
  source text,  -- 'twitter' | 'hn' | 'direct' | 'referral:CODE'
  utm jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now()
);
CREATE INDEX idx_waitlist_referral_code ON waitlist(referral_code);
CREATE INDEX idx_waitlist_referred_by ON waitlist(referred_by);
```

**Position calculation**:
- On insert: `position = current_count + 1` (FIFO)
- On referral signup: `UPDATE waitlist SET position = position - 3 WHERE id = ?` (referrer goes up 3 spots)

**Referral code generation**:
- `randomId()` is 24 hex chars; we want 8 chars base62
- New helper: `randomReferralCode()` returns 8 chars from `0-9A-Za-z`

## API endpoints

- `POST /api/waitlist/signup` — { email, referralCode? } → returns position + referral code
- `GET /api/waitlist/status?code=X` — returns position + referral count
- `GET /api/waitlist/stats` — public, returns count + top referrers
- `POST /api/waitlist/admin/export` — admin only, CSV export

## UX flow

### Signup

1. Visit `/` → see landing
2. Enter email → POST /api/waitlist/signup
3. If referred: +5 positions
4. Show "You're #1247" with referral link
5. Pre-filled social share buttons
6. Confirmation email: "Welcome to the waitlist, your position is #1247. Share to climb: [link]"

### Status page (`/waitlist?code=X`)

- Your position
- Number of signups
- Number of referrals
- Top referrers (anonymized: "Builder #42, 12 referrals")
- Estimated launch date
- Share buttons

## Launch day

When we hit 1000 signups (or decide to launch):
- Email all waitlist: "BuilderHunt is live! Your account is ready. Sign in with the email you used."
- For top 10 referrers: also grant "Founding Member" Pro for 1 year
- For 25+ referrals: lifetime Pro
- ProductHunt, HN, Twitter, dev.to launch posts

## Marketing channels (organic, v1)

1. **Twitter/X** — thread about the problem, screenshots, link
2. **dev.to** — "I built a 12-source developer search engine" (cross-posted from blog)
3. **Hacker News** — "Show HN: BuilderHunt" (when ready)
4. **Reddit** — r/programming, r/webdev, r/ExperiencedDevs (Show HN-style post)
5. **Indie Hackers** — share progress, get feedback
6. **ProductHunt** — launch day
7. **LinkedIn** — for the B2B angle (recruiters)
8. **Dev communities** — Discord servers (IndieHackers, Laravel, etc.)

## Pre-launch content

Blog posts (cross-posted to dev.to):
1. "Why I built BuilderHunt" (founder story)
2. "How to find good developers as a solo founder" (SEO)
3. "The 12 sources I use to find developers" (SEO + value)
4. "Building a 12-source search engine in TanStack Start" (technical, dev audience)
5. "How I ranked 10,000 developers by activity" (technical)

## Email sequences

**Welcome** (immediate):
"Welcome to BuilderHunt! Your position is #1247. Share your link to skip 100 spots."

**After 7 days** (if no referrals):
"You're still at #1247. Quick reminder: your referral link is [link]. Just 3 friends to skip 100 spots."

**After 30 days** (if 0 referrals):
"We've added 200 new people to the waitlist this week. We're getting close to launch. Your position: #1247."

**Launch day** (when we hit 1000 or decision):
"BuilderHunt is live! Sign in with this email. (If you were top 10 referrers, you have 1 year Pro free.)"

## Analytics

Track:
- `waitlist_signup` (email, source, referred_by)
- `waitlist_referral` (referrer, new_signup_id)
- `waitlist_share` (channel: twitter, linkedin, copy)
- `waitlist_position_check` (code)
- `waitlist_to_signup_conversion` (waitlist_id, user_id, days_to_convert)

## Success metrics

- **Primary**: # of waitlist signups. Target: 1000 in 30 days, 5000 in 90 days
- **Secondary**: Viral coefficient (avg referrals per signup). Target: > 0.5 (each user brings 0.5 others)
- **Tertiary**: Conversion rate (waitlist → active user). Target: > 40%
- **Guardrail**: Email bounce rate < 5%
- **Viral velocity**: Doubling time. Target: < 14 days

## Out of scope (v1)

- Paid acquisition (FB ads, Google ads)
- Influencer partnerships
- Press outreach (manual, post-launch)
- Conference sponsorships
- Custom landing pages per traffic source
- A/B testing landing page copy
- Multi-language landing (English v1)

## Open questions

- **Threshold for "launch"**: 1000 signups? Or just "when ready"? My take: 500 signups is enough validation, launch earlier rather than later
- **Referral rewards cost**: lifetime Pro is expensive if a referrer is hyperactive. Cap to 5 lifetime Pro grants (so they can gift 5 of their friends). Or no cap.
- **Position display**: showing position to user can be discouraging. Counter: showing "you've moved up 3 spots!" is encouraging. Make it positive.

## Dependencies

- New tables: `waitlist`
- New package: none (built-in)
- New env vars: `LAUNCH_NOTIFY_EMAIL`, `RESEND_FROM_ADDRESS`
- New background jobs: position recalculation (when referrals are made)
- New email templates: 5 (welcome, reminder, launch, etc.)

## Estimated effort

| Phase | Effort |
|-------|--------|
| 1 — Landing page | M (4-6h) |
| 2 — Waitlist API + table | S (2-3h) |
| 3 — Referral mechanism | M (4-6h) |
| 4 — Email sequences | S (3-4h) |
| 5 — Status page | S (2-3h) |
| 6 — Launch email | S (2-3h) |
| 7 — Marketing content (5 blog posts) | L (1-2 weeks) |
| 8 — Launch day coordination | S (1 day) |
| **Total** | **~2-3 weeks** |
