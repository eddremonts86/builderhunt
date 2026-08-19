# AI helpers section copy

The five places AI shows up in BuilderHunt today, with the credit cost of each.

## Section header

**Eyebrow**: AI HELPERS
**Headline**: Five places AI helps.

The earlier headline said "Three cost credits, two do not", which is a claim about the ledger that the tiles below no longer make — with the allowances unverified, counting them is arithmetic on numbers nobody can check.
**Subhead**: Every AI action on the platform runs through one credit ledger.

> **No allowance numbers here until somebody names their source.** The earlier draft carried
> "Pro: 140 credits/month, Pro Max: 700, Team: 2100" and none of the three appears in
> `src/shared/lib/billing-shared.ts` or anywhere else `grep -rn` reaches. They may be right and
> written down elsewhere; they are not verifiable from this repository, so they do not ship on a
> landing page. Whoever restores them cites the file.

## Five tiles

### Tile 1: Semantic search

**Status**: SHIPPED
**Plan**: [`phase-1/22-semantic-search`](../../../../implemented/phase-1/22-semantic-search/spec.md) — implemented
**Cost**: Free for everyone
**Headline**: Semantic search
**Copy**: Find builders by what they shipped, not just what they say they did. Embeddings, not a scraper.

### Tile 2: AI sourcing sprints

**Status**: SHIPPED
**Plan**: [`phase-1/41-ai-sourcing-sprints`](../../../../implemented/phase-1/41-ai-sourcing-sprints/spec.md) — implemented
**Cost**: Included in plan; concurrency rendered from `SOURCING_SPRINT_LIMITS` (free 0, pro 3, pro_max 10, team 10) rather than typed
**Headline**: AI sourcing sprints
**Copy**: Background re-runs of saved searches until a result quota. Workers run on the same credit ledger.

### Tile 3: AI outreach copilot

**Status**: SHIPPED
**Plan**: [`phase-1/26-outreach-generator`](../../../../implemented/phase-1/26-outreach-generator/spec.md) — implemented
**Cost**: Included in plan — allowance not stated until its source is named (see the header)
**Headline**: AI outreach copilot
**Copy**: Draft the first note in your voice. Three tones, a frozen fallback rung if the model is busy. You edit before sending.

### Tile 4: AI profile enrichment

**Status**: SHIPPED (claim-gated)
**Plan**: [`phase-1/24-ai-profile-enrichment`](../../../../implemented/phase-1/24-ai-profile-enrichment/spec.md) — implemented
**Cost**: Per-request credit (cost printed before you run it)
**Headline**: AI profile enrichment
**Copy**: Verified claim holders get an evidence-backed persona card. We do not sell it, we do not share it, we do not include it in search ranking.

### Tile 5: AI CV generation and tailoring

**Status**: COMING SOON
**Plan**: [`phase-4/ai-cv-generation-and-tailoring`](../../../../phase-4/ai-cv-generation-and-tailoring/spec.md) — not started
**Cost**: Per-request credit (cost printed before you run it)
**Headline**: AI CV generation and tailoring
**Copy**: Generate a CV from confirmed facts. Tailor it to a job description without inventing experience. The first batch ships to builders; recruiters see only verified builders who opted in.

## Acceptance

- Every tile cites a real plan path.
- Status badges match the plan's `Status` header.
- Tile 5 has the `Coming soon` badge; tiles 1-4 do not.
- The credit costs match the live billing code (verify against
  `src/shared/lib/billing/rate-cards.ts` and `feature-authorization.ts`).
- "Free for everyone" on tile 1 matches `src/routes/api/search/semantic.ts`, which has no
  credit cost.
- The section does not invent AI capabilities that don't exist in the code.
