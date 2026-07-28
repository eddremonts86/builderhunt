# Technical Sandbox — Superseded (plan)

> **Status**: `superseded` — merged into [`work-sample`](../37-work-sample/plan.md)
> **Depends on**: nothing (no work planned here)
> **Blocks**: nothing
> **Reality check**: nothing was ever built (no `sandbox_chats` table, no streaming routes, no terminal UI). See [`spec.md`](./spec.md) for the full supersession rationale.

## No phases

There is no implementation work in this directory. The old phases (persona prompt engine,
SSE streaming handler, retro terminal UI, chat persistence) are discarded, not deferred:

- Persona roleplay of a real builder → **rejected** (fabricated answers attributed to a
  real person; misrepresentation risk).
- Interview-question generation from real code → **delivered by**
  [`work-sample`](../37-work-sample/plan.md) (`suggestedInterviewQuestions`).
- Streaming chat infrastructure → **rejected** (AI platform v1 is single JSON completions;
  see [`ai-expansion`](../20-ai-expansion/spec.md) non-goals).

## Risks / rollback

Not applicable — no code, no rollout. The only ongoing obligation is that any future
revival must be a new plan conforming to `_meta/ai-policy.md`, framed as an analysis
assistant, never a persona.
