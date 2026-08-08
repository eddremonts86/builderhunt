# Features bento copy refresh

The existing six bento cards stay. Each gets a one-line copy refresh grounded in the inventory.

## 1. Multi-source discovery

**Headline**: Multi-source discovery
**Subhead**: Federated across 12 communities, with semantic search on top.
**Number**: 12 SOURCES

(Replaces the current copy that says "13 sources". The actual live count is 12:
`src/lib/sources/index.ts`. Semantic search is a search method, not a source. The
"+1" framing is misleading.)

## 2. Recency-weighted scoring

**Headline**: Recency-weighted scoring
**Subhead**: A 7-day decay window. A builder who shipped last week outranks one who shipped last month. We surface people, not history.

## 3. Keyword alerts

**Headline**: Keyword alerts
**Subhead**: Set the filter once. We send an email or RSS ping the moment a new builder matches. No daily digest, just the hits that matter.

(Plan `phase-1/34-smart-alerts` is `partially-implemented` — v1 ships, v2 deferred. This
copy describes v1 honestly.)

## 4. Private notes

**Headline**: Private notes
**Subhead**: Stash private context on any builder. Outreach status, where you met them, why they matter. Only you and your team see them.

## 5. CSV / JSON export

**Headline**: CSV / JSON export
**Subhead**: Export any shortlist to CSV or JSON. Pipe it into Notion, Airtable, your ATS, or a spreadsheet. No lock-in.

## 6. No tracking, no spam

**Headline**: No tracking, no spam
**Subhead**: We don't message builders on your behalf and we don't sell profile data. You find them, you reach out. That is the whole model.

## Sources strip

**Eyebrow**: AGGREGATING ACTIVITY FROM THE PLATFORMS BUILDERS ALREADY USE
**Copy**: GitHub, Reddit, Hacker News, DEV.to, GitLab, Codeberg, Stack Overflow, npm, Hugging Face, Lobsters, Hashnode, SourceHut.
**Footnote**: Plus semantic search across the same 12 communities. We index what people
shipped, not just what they say they did.

## Footer paragraph (small refresh)

> Find active open-source builders across the open web. Track GitHub stars, Hacker News
> comments, and Reddit velocity from one clean dashboard. Plus alerts, notes, and team
> shortlists.

(Adds the three shipped surfaces the current copy leaves out.)

## Acceptance

- "13 sources" appears nowhere in the home page copy.
- Every numeric claim resolves to a `src/` path via `grep -r`.
- Persona variants do not change any line in this section.
- The footer paragraph does not exceed one line on mobile 320.
