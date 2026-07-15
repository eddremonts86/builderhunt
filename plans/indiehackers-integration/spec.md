# Feature: IndieHackers Integration

## Why (short)

IndieHackers es la comunidad de founders bootstrapped. Sus users son devs que **construyen productos** y comparten revenue/metrics. Es una clase DIFERENTE de builder: no solo programador, sino entrepreneur técnico. Si tu usuario busca "bootstrapped SaaS" o "indie developer", IndieHackers es donde están.

## API summary

- **Public API**: NONE
- **Data source**: scrape `https://www.indiehackers.com/`
- **Auth**: requires login (free account)
- **Scraping risk**: ToS unclear, site has anti-bot

## Why honorable mention (not top pick)

- **No public API** — has to be scraping, which is fragile
- **Smaller user base** (~200k, but most are lurkers)
- **Different audience** than the rest of BuilderHunt's targets
- **Hard to maintain**: any site redesign breaks the scraper

## Effort

**L (1+ semana)**. No API, scraping required, fragile. Plus auth flow.

## Recommendation

**Skip unless the user specifically asks for "founders" as an audience.** Even then, the cost is high for low return.

Better alternatives if you want founder signal:
- **Crunchbase API** (paid, but proper data)
- **Product Hunt API** (free, has maker profiles)
- **Twitter/X** (where founders tweet, but API is paywalled)
- **LinkedIn** (closed, scraping ToS)

None of these are easy. IndieHackers scraping is probably the lowest-effort option, but it has long-term maintenance cost.

## Better path

If you need founder signal, **let users self-tag** as "founder" or "indie hacker" in their profile. Add a filter. Skip the integration.
