# Technical Sandbox — Superseded (spec)

> **Status**: `superseded` — merged into [`work-sample`](../../implemented/38-work-sample/spec.md)
> **Depends on**: nothing (no work planned here)
> **Blocks**: nothing
> **Reality check**: zero code was ever built for this plan — no `sandbox_chats` table, no persona prompt engine, no streaming routes, no terminal UI. The recruiter-side "understand a candidate's real code before outreach" need it targeted is delivered by [`work-sample`](../../implemented/38-work-sample/spec.md).

## What this plan was

An "AI Technical Persona Sandbox": an LLM would roleplay a specific builder, in a
terminal-styled chat, answering a recruiter's technical questions ("why did you use the
Actor model in fast-cache?") in that builder's simulated voice, grounded in their public
code and posts, with per-session chat history persisted in a `sandbox_chats` table and
streamed over SSE.

## Why it is superseded (rationale, recorded)

1. **The answers would be fabrications attributed to a real person.** The persona's
   architectural explanations are model guesses rendered in the builder's name. Recruiters
   would inevitably treat them as candidate signal — hallucinated interview answers from
   someone who never spoke. That misrepresentation risk is disqualifying on its own, and it
   directly violates the spirit of ai-policy rule 5/6 (external content grounds analysis;
   it does not license impersonation).
2. **It duplicates work-sample's core value with weaker grounding.** The legitimate kernel
   — "probe what a builder's real code demonstrates and what to ask them about it" — is
   exactly what `work-sample-analyze` produces, with evidence citations, as honest
   third-person analysis (`whatItDemonstrates`, `levelSignals`, and especially
   `suggestedInterviewQuestions`, which is this plan's icebreaker-chips idea reborn as
   questions for the _actual human_). Keeping both plans would build the same feature
   twice, once truthfully and once as roleplay.
3. **It contradicts platform reality.** It required streaming responses (excluded from the
   AI platform v1), multi-turn chat sessions with unbounded token growth (the platform's
   cost model is single JSON completions with per-task budgets), and a persisted chat
   table for content of no durable value.

## Decision

- No part of this plan will be implemented as specified.
- Surviving kernel: context-aware interview questions grounded in real code →
  `suggestedInterviewQuestions` in [`work-sample`](../../implemented/38-work-sample/spec.md)'s output schema.
- If interactive Q&A over a builder's code is ever revisited, it must be framed as a
  clearly-labeled _analysis assistant_ ("ask about this repo"), never as the builder's
  persona — and it would be a new plan written against the AI platform's rules at that time.

This directory is kept as the record of the decision (per `_meta/conventions.md`: plans are
history, not just backlog).
