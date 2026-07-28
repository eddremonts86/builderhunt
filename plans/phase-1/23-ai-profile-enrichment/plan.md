# AI Profile Enrichment — Developer Persona Card (plan)

> **Status**: `partially-implemented` (Phases 1, 2, 4 shipped 2026-07-20; Phase 3 claim-hook deferred, see tasks.md)
> **Depends on**: [`ai-expansion`](../20-ai-expansion/spec.md) (Phases 1–3 of the AI Platform: registry, cache, budget, `minimaxChat`)
> **Blocks**: nothing
> **Reality check**: Builds on `BuilderProfilePage.tsx`, the claim verify flow (`src/routes/api/builders/claim/verify.ts`), and `builders.metadata` jsonb. Owns the `metadata.aiEnrichment` key. No schema migration needed.

## Phases (dependency order — shippable after each)

### Phase 1 — Pure enrichment lib + task registration

`src/shared/lib/ai/enrichment.ts` (or `src/lib/enrichment/` if it grows): zod schemas
(`builderAIEnrichmentModelSchema`, `builderAIEnrichmentSchema`), `hasEnrichableContent`,
`buildEnrichInput(builderRow)`, freshness check `isEnrichmentFresh(artifact)`. Register the
`profile-enrich` task in `src/shared/lib/ai/tasks.ts` (server-only, 30 d TTL, allowances
per spec). Full vitest coverage of the pure parts. Nothing user-visible.

### Phase 2 — API endpoints

`GET /api/builders/$builderId/enrichment` (ownership check → DB-cached → threshold →
platform pipeline → `jsonb_set` persist) and
`POST /api/builders/$builderId/enrichment/refresh` (claimed-owner/admin, hourly rate limit).
Verified with curl before any UI exists.

### Phase 3 — Claim hook

Fire-and-forget refresh after successful claim verification in
`src/routes/api/builders/claim/verify.ts` — logged, never blocks or fails the claim response.

### Phase 4 — PersonaCard UI

`PersonaCard.tsx` in `src/modules/builder-profile/components/`, wired into
`BuilderProfilePage.tsx`: skeleton → card / insufficient placeholder / budget-note states,
refresh button gated to claimed-owner/admin, hidden when AI is disabled or unconfigured.

## Risks

| Risk                                               | Likelihood | Impact | Mitigation                                                                                                          |
| -------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------- |
| Hallucinated seniority/strengths damage trust      | Medium     | High   | Evidence-only system prompt, `mid` default under uncertainty, visible "AI-generated" disclaimer, no numeric scoring |
| Prompt injection via bios/READMEs                  | Medium     | Medium | `wrapUntrusted` on all external fields + standing system-prompt rule (platform-provided)                            |
| Duplicate MiniMax spend across per-user rows       | High       | Low    | Platform Redis cache keyed on canonical input dedupes identical profiles across users                               |
| `metadata` shape drift breaks highlight extraction | Medium     | Low    | `buildEnrichInput` is defensive (zod-parses unknown metadata, skips silently) and unit-tested per source shape      |
| Detail-page latency on cold generation             | Medium     | Low    | Card loads async after page render (skeleton); page never blocks on the LLM                                         |

## Rollback

- No migrations: rollback is code-only. Remove the two endpoints, the claim hook, and
  `PersonaCard.tsx`; stale `metadata.aiEnrichment` blobs are inert data (harmless to leave,
  or clear with a one-off `UPDATE builders SET metadata = metadata - 'aiEnrichment'`).
- Soft kill without deploy: `AI_DISABLED_TASKS=profile-enrich` — endpoints 503, card hides.
