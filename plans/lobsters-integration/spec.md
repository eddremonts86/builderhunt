# Feature: Lobsters Integration

## Problem

HN ya está indexado pero es broad — política, jobs, "Ask HN", crypto, todo. **Lobsters** es el complemento perfecto: comunidad small-but-high-signal centrada en programming, security, distributed systems, languages, unix. Los users de Lobsters son devs senior con criterio técnico. Si un usuario busca "distributed systems" o "PL theory", Lobsters es donde están los matches de mayor calidad.

## Goal

Indexar Lobsters users públicos con la misma calidad de signal que HN:
- Username, karma (proxy for quality)
- Tags de los stories que comenta (proxy for interests)
- Recent activity (último story submitted)
- Bio (la mayoría tienen)

## Non-goals

- **No es scraping de stories.** Solo users. Stories y comments son dominio de HN ya.
- **No es full-text del bio.** El bio es típicamente 1-2 frases, lo guardamos tal cual.
- **No es invite-only signal.** Lobsters es invite-only, pero los profiles son públicos. La integración es sobre los profiles, no sobre el sistema de invites.

## API summary

- **Base URL**: `https://lobste.rs/`
- **Auth**: none required (public read API)
- **Endpoints clave**:
  - `GET /hottest.json` — top 25 stories (hottest last 3 days)
  - `GET /newest.json` — newest stories
  - `GET /search?q=X` — HTML search (use a parser, no JSON endpoint for user search)
  - `GET /u/:username.json` — single user details (HTML, not JSON)
- **Rate limit**: no documented limit, but be polite (cache aggressively)
- **OpenAPI spec**: https://github.com/api-evangelist/lobsters

**Important caveat**: Lobsters does NOT have a JSON search API for users. We have to scrape the HTML search or iterate from `/hottest.json` + `/newest.json` to collect users, then fetch `/u/:username.json` (or scrape `/u/:username`) for details. The latter is also HTML, not JSON.

This is a real constraint. See "Open questions".

## User stories

1. **Como usuario**, al buscar "compilers" en BuilderHunt, quiero ver devs activos en Lobsters sobre ese tema, junto a los de HN/GitHub/Reddit/DEV.to.
2. **Como usuario**, en `/search`, quiero toggle "Lobsters" en los sources.
3. **Como usuario**, las tarjetas de Lobsters deben distinguirse visualmente (color rojo Lobsters: `#AC130D`).

## Success metrics

- **Primary**: % of saved searches with at least 1 Lobsters result. Target: 20% (lower than HN because Lobsters is smaller).
- **Secondary**: CTR from Lobsters is ≥ 80% of HN's CTR. Lobsters users are high-quality, so the bar is high.
- **Quality guardrail**: dismiss rate < 30% (Lobsters should be the highest-signal source).

## Open questions

- **Search-by-keyword from JSON?** Not available. Two options:
  - (a) Iterate `/hottest.json` + `/newest.json` (last N stories), extract `submitter_user.username`, fetch each user's details, filter by bio match. Limited to "active users" only.
  - (b) Scrape `/search?q=X` HTML for user results. More results but fragile to layout changes.
  - **Recommended**: (a) for v1. Sample 100 hottest + 100 newest stories → unique users → fetch each → filter by bio match. Cache aggressively (5-10min).
- **Bio scraping required?** The `/u/:username` page has the bio but no JSON. We'll need to parse HTML (use a simple regex or DOM parser like `cheerio` / `linkedom`).
  - Alternative: just use `username` and `karma`, skip bio. Lower signal but no scraping.
  - **Recommended**: scrape bio. Quality matters more than simplicity here.
- **Tags as topics?** The user has a "frequent tags" page (`/u/:username/tags`) that lists tags they've submitted. This is gold. Scrape it.
  - **Recommended**: yes, scrape. Adds ~30 lines of code.

## Out of scope (this iteration)

- Stories / comments / threads
- Invite tracking
- Tag-based discovery (browse all users in tag X)
