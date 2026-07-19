# Progress Ledger: Builder Tracking & /exports Redesign

Plan: docs/superpowers/plans/2026-07-19-builder-tracking-and-exports.md
Branch: feat/builder-tracking-exports

- [x] Task 1: Unique index + migration (commit 7863f2e..fbb102e, review clean; required a full drizzle rebaseline after implementer hit a pre-existing snapshot-desync blocker, user-approved)
- [ ] Task 2: Shared tracked-builder key helper
- [ ] Task 3: POST /api/builders/track
- [ ] Task 4: DELETE /api/builders/$builderId
- [ ] Task 5: GET /api/me/builders
- [ ] Task 6: Annotate search results with tracked state
- [ ] Task 7: De-duplicate recommendations query
- [ ] Task 8: Fix savedBuilders plan limit
- [ ] Task 9: Track/untrack button in search results
- [ ] Task 10: Rewrite /exports page
- [ ] Task 11: Full end-to-end verification
