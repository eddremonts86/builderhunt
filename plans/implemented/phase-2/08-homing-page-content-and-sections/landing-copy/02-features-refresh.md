# Features bento copy refresh

The existing six bento cards stay. Each gets a one-line refresh grounded in the inventory.

> **Verified 2026-08-18.** Every claim below was resolved against the code. Three in the previous
> draft were wrong and are recorded at the bottom rather than quietly replaced.

## 1. Multi-source discovery

**Headline**: Multi-source discovery
**Subhead**: One federated search across every public source we index, with semantic search on top.
**Number**: **interpolated, never typed** — `SEARCH_SOURCE_COUNT` from
`src/shared/lib/search-connectors.ts` (13 today).

The count is the one number on this page that has already gone stale across nine surfaces at once.
It is a constant precisely so copy reads the registry that decides it; a card that renders
`{SEARCH_SOURCE_COUNT} sources` cannot drift, and one that renders `13 SOURCES` will.

## 2. Recency-weighted scoring

**Headline**: Recency-weighted scoring
**Subhead**: Somebody who shipped today outranks somebody who shipped last month. We surface people,
not history.

Deliberately no number. `src/lib/score.ts` is a five-step ladder — under a day scores 30, under a
week 22, under a month 12, under 90 days 5, under a year 1 — not the "7-day decay window" the earlier
draft claimed. Describing the shape in prose survives a retune of the steps; quoting one step does not.

## 3. Keyword alerts

**Headline**: Keyword alerts
**Subhead**: Set the filter once. We tell you the moment a new builder matches.

Email alerts are a paid action (`402` without `paidActionsAllowed`); the free plan gets the feed link.
The card must not promise email without that qualifier — the segmented investing page states it
explicitly and this card should not contradict it.

## 4. Private notes

**Headline**: Private notes
**Subhead**: Stash private context on any builder — outreach status, where you met, why they matter.
Only your workspace sees them.

## 5. CSV / JSON export

**Headline**: CSV / JSON export
**Subhead**: Export any shortlist to CSV or JSON. Pipe it into Notion, Airtable, your ATS, or a
spreadsheet. No lock-in.

## 6. No tracking, no spam

**Headline**: No tracking, no spam
**Subhead**: We do not message builders on your behalf and we do not sell profile data. You find them,
you reach out.

## Sources strip

**Eyebrow**: AGGREGATING ACTIVITY FROM THE PLATFORMS BUILDERS ALREADY USE
**Copy**: rendered from `IMPLEMENTED_SEARCH_CONNECTORS`, not typed. Today that is GitHub, Hacker News,
DEV.to, Reddit, Lobsters, Stack Overflow, npm, Hugging Face, GitLab, Codeberg, Devpost, Product Hunt
and Bluesky.
**Footnote**: Semantic search runs across the same sources. We index what people shipped, not just
what they say they did.

A hand-written list is the same defect as a hand-written count, one row lower: the previous draft
still listed **Hashnode** and **SourceHut**, retired on 2026-08-04 by `drizzle/0143` and `drizzle/0144`,
and omitted Devpost, Product Hunt and Bluesky.

## What the earlier draft got wrong

- **"Federated across 12 communities" / "12 SOURCES"** — it is 13, and it must not be a literal at all.
  The draft even argued *for* the wrong number, reasoning that "semantic search is a search method,
  not a source" against a "13" it assumed was `12 + 1`. The 13 is thirteen connectors.
- **"`src/lib/sources/index.ts`"** — no such file. The registry is `src/shared/lib/search-connectors.ts`.
- **"A 7-day decay window"** — `score.ts` is a five-step ladder, not a decay window.

## Acceptance

- No source count appears as a literal anywhere in the rendered copy.
- Every numeric claim resolves to a `src/` path via `grep -r`.
- Persona variants do not change any line in this section.
- The sources strip renders from the registry, so retiring a connector updates the page.
