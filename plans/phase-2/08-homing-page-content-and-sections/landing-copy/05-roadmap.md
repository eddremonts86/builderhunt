# Roadmap section copy

Eight plans on the public roadmap. Each is one line: `Plan name — one-line why — Coming soon`.

## Section header

**Eyebrow**: COMING SOON
**Headline**: What we are shipping next.
**Subhead**: Eight plans on the public roadmap. Each item links to the full specification. When a plan lands, the badge is removed and the section is one row shorter.

## Eight items

1. **Hiring Pipeline Kanban** — Stage your tracked builders. New, Reviewed, Contacted, In conversation, Hired. With per-stage owners and a quiet-card alert. (`phase-4/hiring-pipeline-kanban`)

2. **Why This Match (Evidence Panel)** — See exactly which signal pushed a builder to the top of your results. Activity recency, profile completeness, source-specific scoring, all itemized. (`phase-4/match-evidence-panel`)

3. **Saved Search Health** — Know which of your saved searches are still returning fresh matches and which have gone quiet. Re-rank, retire, or tune. (`phase-4/saved-search-health`)

4. **Look-alike Sourcing** — From any builder you already trust, find more like them. One HNSW query, zero AI calls. Self-hit suppression. (`phase-4/look-alike-sourcing`)

5. **AI CV Generation and Tailoring** — Generate a CV from confirmed facts. Tailor it to a job description without inventing experience. Every fact has a source link. (`phase-4/ai-cv-generation-and-tailoring`)

6. **Solutions Intelligence** — Paste a brief. Get up to three evidence-backed Human, AI, and Hybrid solution routes, with a fit score and a fit risk. (`phase-1/43-solutions-intelligence`)

7. **Co-Shipping Collaboration Graph** — See who has shipped with who. Find your next hire by the people they have shipped with before, not just the keywords they use. (`phase-4/collaboration-graph`)

8. **Browser Extension Overlay** — Get match scores and notes on any builder profile across the open web, without leaving the tab. (`phase-4/browser-extension-overlay`)

## Acceptance

- Every item cites a real plan path. A `grep -lR '<plan-dir>' plans/phase-4/` returns the
  expected directory.
- The order matches the priority list in `spec.md` (the plan author can re-order, but
  every commit must re-order by the same priority logic).
- The badge "Coming soon" is the section-level eyebrow, not inline per item. Inline badges
  create visual noise.
- The section ends with a "See the full roadmap" link to `/roadmap` (existing route).
- Item count stays at 8 in the final commit. Items past the cap move to the public roadmap.
