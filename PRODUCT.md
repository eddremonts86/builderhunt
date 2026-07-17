# Product

## Register

product

## Users

- Open-source maintainers filling co-maintainer slots
- Founders sourcing early technical hires
- Recruiters / talent partners running targeted searches
- DevRel & community teams finding active voices in a topic

They land here mid-workflow (searching, saving, checking daily picks), on desktop, often with a dashboard open alongside other tabs. The job: find people who are visibly *shipping* right now across GitHub, Reddit, Hacker News, and DEV.to — not read another static profile.

## Product Purpose

BuilderHunt aggregates public developer activity, scores it for recency, and lets a user save a search, get alerted the moment a new match appears, and act on a shortlist (export, note, outreach) without babysitting timelines. Success = a saved search someone re-runs weekly because it keeps surfacing people worth their time.

## Brand Personality

Warm, premium, ordered. Terracotta + cream over a dark-dev-tool-generic base — the interface should feel like a well-run studio dashboard, not a hacker terminal. Confident numbers (large serif/display figures), calm surfaces, restrained motion. Currently mid-migration from a dark, minimal-technical theme to this warmer premium-light direction (see recent `style(theme)` commits) — new UI should target the new direction, not the old one.

## Anti-references

- Generic dark SaaS dev-tool chrome (flat navy, monospace-everywhere, neon accents)
- Cluttered admin sidebars that just grow a flat list of links forever
- Cold, purely functional enterprise-admin aesthetics with no warmth

## Design Principles

- Consolidate, don't stack — new sections earn a place in the nav by replacing/grouping, not appending another list item
- Numbers are the hero, chrome is quiet — data (scores, counts, stats) gets weight; navigation and controls stay light
- Warmth lives in accent + type + surface tone, not in gimmicks — no gradient text, no glass-for-its-own-sake
- Admin is a mode, not a wing — admin-only tools should feel like a toggled view, not a permanently-visible sixth of the nav

## Accessibility & Inclusion

WCAG AA contrast minimum (already a stated goal in the existing token comments) for all repainted surfaces; reduced-motion alternative for any new nav transition.
