# Feature: Stack Overflow Integration

> **Status**: `implemented` (verified 2026-07-28)
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: Connector exists at `src/lib/sources/stackoverflow.ts` and is fully
> wired (pipeline, opt-in pill, badge, icon, scoring branch). `STACKOVERFLOW_API_KEY`
> exists in `src/shared/lib/env.ts` and is documented in `.env.example`, and quota exhaustion is no
> longer silent: `warnIfQuotaLow` emits `stackoverflow_quota_low` with `quota_remaining`/`quota_max`
> on every call once the threshold is crossed. Both gaps closed 2026-07-25.

## Problem

Stack Overflow is the canonical registry of technical expertise. Top answerers per tag are
proven experts — a different, stronger signal than commit activity.

## Goal

Index SO experts as `RawBuilder` person records, keyed to the query's technology keywords.

## Delivered

Shipped in `src/lib/sources/stackoverflow.ts` (file header documents the strategy):

- **Better approach than originally specced**: instead of "top 50 global users filtered by
  tag", the connector hits the canonical experts endpoint per query keyword:
  `GET /2.3/tags/{tag}/top-answerers/all_time?site=stackoverflow`, unioned across
  keywords — users matching multiple keywords accumulate score and get a multi-tag boost.
- `TAG_SYNONYMS` map fixes silent-empty lookups (`react` -> `reactjs`, `node` -> `node.js`,
  `golang` -> `go`, etc.) — a real-world pitfall the original spec missed.
- One batch call `GET /2.3/users/{ids}/top-tags` (up to 100 ids) enriches topics.
- Mapping: `id: so-{userId}`, `kind: 'person'`, reputation as `followersCount` (the
  original open question resolved as "reputation"), accept-rate bio,
  `metadata.matchedTags/postScore/postCount/reputation`.
- Filters unregistered users; sorts by tag-specific score, then reputation.
- Optional `STACKOVERFLOW_API_KEY` appended as `key=` (300 req/day/IP without, 10k/day
  with).
- Registered in `src/lib/search.ts` and `SourceName`; opt-in pill (the original
  "off by default due to quota" recommendation was adopted), `StackOverflowIcon`,
  `.badge-stackoverflow`, `stackoverflow` scoring branch in `src/lib/score.ts`
  (multi-tag expert boost + engagement bonus).
- All fetches try/caught to `[]` (mandatory: `search.ts` uses `Promise.all`).

## Remaining gaps (real)

1. **`STACKOVERFLOW_API_KEY` is missing from `.env.example`** — the 300/day unkeyed quota
   is easy to exhaust in production and operators have no pointer to the fix.
2. **Quota exhaustion is silent.** The Stack Exchange API reports `quota_remaining` in
   every response and throttle violations as a 400 body; the connector ignores both, so an
   exhausted key looks identical to "no experts found". A log line is enough.

## Non-goals (unchanged)

Question/answer content; Stack Exchange network sites (Server Fault etc.); real-time
reputation.

## Success metrics

- "kubernetes", "rust" (with the SO pill active) return high-reputation experts whose
  `matchedTags` include the query terms; multi-keyword queries rank multi-tag experts first.
