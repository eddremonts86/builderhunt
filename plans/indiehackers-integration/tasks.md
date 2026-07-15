# Tasks: IndieHackers Integration

> **Note: skip unless you really need founder signal**. No public API, scraping is fragile, effort is high.

## Why this plan is short

There's no good path. Each option has significant downsides:

## Option A: Scrape the public site
- [ ] Set up Puppeteer or Playwright
- [ ] Login with a test account
- [ ] Scrape user profiles from `/people?query=X`
- [ ] Parse HTML (no JSON API)
- [ ] Handle pagination, anti-bot
- [ ] **Effort: 1+ week**. Fragile to site redesigns.

## Option B: Scrape the public leaderboard
- [ ] `/leaderboard` is public, has top users
- [ ] No auth needed
- [ ] Limited to top 100, no keyword search
- [ ] **Effort: 3-4 days**. Useful for "top founders" but not for keyword search.

## Option C: Skip and use a tag system
- [ ] Add a `tags` field to `builders.metadata` JSONB
- [ ] User can tag a builder as "indie hacker" / "founder" / "bootstrapped"
- [ ] Filter by tag in search
- [ ] **Effort: 1-2 days**. Lower quality but no maintenance.

## Recommendation

**Do option C** (self-tagging) before considering A or B. If users complain "I can't find founders", then consider B (leaderboard scrape) as a small feature.

## Estimated effort (if you do it)

- Option A: L (1+ week)
- Option B: M-L (3-5 days)
- Option C: S (1-2 days)
