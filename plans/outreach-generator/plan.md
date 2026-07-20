# Outreach Generator v2 — AI Upgrade (plan)

> **Status**: `partially-implemented` (v1 shipped; AI upgrade pending)
> **Depends on**: [`ai-expansion`](../ai-expansion/spec.md) (full platform: client ladder, `/api/ai/complete`, `useAICapabilities`, `AIDownloadPrompt`)
> **Blocks**: nothing
> **Reality check**: v1 is live and frozen as the fallback: `src/shared/lib/outreach.ts` (+ `outreach.test.ts`) and `src/modules/builder-profile/components/OutreachCopilot.tsx`. This plan modifies the component and adds one task to the registry — no routes, no schema, no migrations of its own.

## Phases (dependency order — shippable after each)

### Phase 0 — Delivered (v1, keep as-is)

- [x] Rule-based generator with 3 tones and hook cascade — `src/shared/lib/outreach.ts`,
      tests in `outreach.test.ts`.
- [x] Copilot panel UI (job inputs, tone radio, draft, copy) —
      `src/modules/builder-profile/components/OutreachCopilot.tsx`.

### Phase 1 — Register the `outreach-draft` task

Add the task to `src/shared/lib/ai/tasks.ts` per spec.md: local-first, no cache,
allowances `{ free: 10, pro: 100, team: 200 }`, output schema mirroring `OutreachDraft`,
banned-cliché `superRefine`, `<untrusted>` wrapping of bio/topics, `revision` support.
Import `OutreachTone` from `outreach.ts` (single tone source). Registry tests extended.
No UI change yet — task is callable but unused.

### Phase 2 — Wire the generation ladder into the panel

`OutreachCopilot.tsx`: Generate calls `ai('outreach-draft', input)`; catch
`AIUnavailableError` → `generateOutreach()` (v1). Add the mode badge
(on-device / server AI / template) and loading state. Existing testids and layout intact.

### Phase 3 — Revision actions + download UX

Rewrite/Shorten buttons: Chrome Rewriter API when available, else task re-invocation with
`revision`; hidden in template mode. Inline `AIDownloadPrompt` when the panel is open and
the model is `downloadable`.

## Risks

| Risk                                                                 | Likelihood | Impact | Mitigation                                                                                                                              |
| -------------------------------------------------------------------- | ---------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Chrome Prompt/Rewriter output quality varies (small on-device model) | Medium     | Medium | Strict output schema + banned-phrase refine + retry; server tier one rung away; template floor                                          |
| Drafts feel same-y despite AI (cached)                               | —          | —      | Explicitly no caching (`cacheTtlSeconds: null`)                                                                                         |
| Spam generation at scale                                             | Low        | Medium | Free tier 10/day server budget (matches v1's stated limit); on-device generation is self-limiting (user's own machine, no scraping API) |
| Prompt injection via builder bio                                     | Medium     | Low    | `wrapUntrusted` + system rule; output schema blocks URLs > body cap; ephemeral output reviewed by the user before sending               |
| Regression of the shipped v1 panel                                   | Medium     | Medium | v1 lib untouched and tests frozen; component changes are additive; template path exercised in the degradation test                      |

## Rollback

- No persistence, no routes, no migrations — rollback is reverting the `OutreachCopilot.tsx`
  diff and removing the task from the registry; v1 behavior returns exactly.
- Soft kill without deploy: `AI_DISABLED_TASKS=outreach-draft` → the panel silently runs in
  template mode (rung 3), which is precisely today's shipped behavior.
