# AI helpers section copy

The five places AI shows up in BuilderHunt today, with the credit cost of each.

## Section header

**Eyebrow**: AI HELPERS
**Headline**: Five places AI helps. Three cost credits, two do not.
**Subhead**: Every AI action on the platform runs through one credit ledger. Free plans get none. Pro plans get 140 a month. Pro Max and Team plans get more.

## Five tiles

### Tile 1: Semantic search

**Status**: SHIPPED
**Plan**: `phase-1/22-semantic-search`
**Cost**: Free for everyone
**Headline**: Semantic search
**Copy**: Find builders by what they shipped, not just what they say they did. Embeddings, not a scraper.

### Tile 2: AI sourcing sprints

**Status**: SHIPPED
**Plan**: `phase-1/41-ai-sourcing-sprints`
**Cost**: Included in plan (Pro: 3 concurrent, Pro Max: 10, Team: 10)
**Headline**: AI sourcing sprints
**Copy**: Background re-runs of saved searches until a result quota. Workers run on the same credit ledger.

### Tile 3: AI outreach copilot

**Status**: SHIPPED
**Plan**: `phase-1/26-outreach-generator`
**Cost**: Included in plan (Pro: 140 credits/month, Pro Max: 700, Team: 2100)
**Headline**: AI outreach copilot
**Copy**: Draft the first note in your voice. Three tones, a frozen fallback rung if the model is busy. You edit before sending.

### Tile 4: AI profile enrichment

**Status**: SHIPPED (claim-gated)
**Plan**: `phase-1/24-ai-profile-enrichment`
**Cost**: Per-request credit (cost printed before you run it)
**Headline**: AI profile enrichment
**Copy**: Verified claim holders get an evidence-backed persona card. We do not sell it, we do not share it, we do not include it in search ranking.

### Tile 5: AI CV generation and tailoring

**Status**: COMING SOON
**Plan**: `phase-4/ai-cv-generation-and-tailoring`
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
