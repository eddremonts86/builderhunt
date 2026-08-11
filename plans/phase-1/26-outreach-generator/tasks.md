# Outreach Generator v2 — AI Upgrade (tasks)

> **Status**: `implemented` (v1 + AI upgrade both shipped, 2026-07-20)
> **Depends on**: [`ai-expansion`](../21-ai-expansion/spec.md) (client ladder `ai()`, `/api/ai/complete`, `useAICapabilities`, `AIDownloadPrompt` all implemented)
> **Blocks**: nothing
> **Reality check**: v1 shipped — `src/shared/lib/outreach.ts`, `tests/unit/shared/lib/outreach.test.ts`, `src/modules/builder-profile/components/OutreachCopilot.tsx`. Do not modify `outreach.ts` logic; it is the frozen fallback rung.


## Status reconciliation (2026-08-11)

Moved to `plans/implemented/` on the strength of this, so the folder means one thing: **every task checked,
and `pnpm ci:local` green at 34/34 steps** (6,543 unit tests, 996 e2e) on commit `90527722e`.

Why the status changed: was `complete`, a synonym no gate can read. v1 and the AI upgrade both shipped 2026-07-20.

The eight status values previously in use across phase-1 — `complete`, `done`, `in_progress`, `retired`,
`closed — skipped`, `engineering-complete`, `code-complete-dark`, `pending — implementation-ready` — are
outside the five `scripts/check-phase-readiness.mjs` accepts, and that script only ran against phase-2 and
phase-3. A status no gate reads is a status that drifts, which is how four plans sat at 100% of their tasks
while still labelled `pending`.

Ordered so the panel keeps working after every checkbox.

## Phase 0 — Delivered (record, do not redo)

- [x] **Rule-based outreach generator (v1)**
  - Files: `src/shared/lib/outreach.ts`, `tests/unit/shared/lib/outreach.test.ts`
  - Delivered: `generateOutreach()` with tones `'casual' | 'professional' | 'geek'` and a
    bio → topic → language → followers hook cascade.
- [x] **Outreach Copilot panel (v1)**
  - Files: `src/modules/builder-profile/components/OutreachCopilot.tsx`
  - Delivered: collapsible panel with job inputs, tone radio group, draft render,
    copy-to-clipboard.

## Phase 1 — Task registration

- [x] **Register the outreach-draft task**
  - Files: `src/shared/lib/ai/tasks.ts`
  - Do: Add `outreach-draft` per spec.md: tier `local-first`; input schema (builder public
    fields + job + `tone: z.enum(['casual','professional','geek'])` + optional `revision`);
    output schema `{ subject, body (40–1200 chars), hookSource }` with a `superRefine`
    rejecting banned clichés ("I was impressed by your profile", "exciting opportunity",
    "rockstar", "ninja", "guru", "I came across your profile" — case-insensitive);
    `cacheTtlSeconds: null`; allowances `{ free: 10, pro: 100, team: 200 }`;
    `maxOutputTokens: 400` (**delivered as `900`** — live-tested against the real MiniMax
    API and found 400 truncates mid-`<think>` block on every call, same failure mode as
    the `ping` task; see tasks.ts comment); system prompt per spec (anti-cliché, concrete
    opening hook, <150 words, tone definitions, revision handling, `<untrusted>` rule,
    JSON only); `buildPrompt` wraps `bio` and `topics` with `wrapUntrusted`. Import the
    tone type from `~/shared/lib/outreach` so the enum can never drift from `OutreachTone`
    (delivered via a compile-time exhaustiveness check, not a runtime `satisfies`).
  - Verify: `pnpm type-check`.

- [x] **Test the task definition**
  - Files: `tests/unit/shared/lib/ai/tasks.test.ts`
  - Do: Extend the registry test for `outreach-draft`; assert the output schema rejects a
    body containing "exciting opportunity" and accepts a clean fixture; assert
    `buildPrompt` output wraps a fixture bio in `<untrusted>`; type-level check
    (`satisfies`/`Expect<Equal<...>>` helper) that the zod tone enum equals `OutreachTone`.
  - Verify: `pnpm test tasks.test`.

## Phase 2 — Generation ladder in the panel

- [x] **Switch Generate to the AI ladder with template fallback**
  - Files: `src/modules/builder-profile/components/OutreachCopilot.tsx`
  - Do: Make `handleGenerate` async: build the task input from existing state (builder prop
    already matches the shape; job fields trimmed as today); `const res = await
ai('outreach-draft', input)` → `setDraft(res.output)` and record
    `mode = res.via` (`'local' | 'server'`); on `AIUnavailableError` (any reason) fall back
    to the existing `generateOutreach({...})` call and set `mode = 'template'` plus a short
    reason line for `budget`/`plan` ("Daily AI limit reached — template draft"). Disable
    the button + show a spinner while pending. Keep every existing element and
    `data-testid` unchanged.
  - Verify: In Chrome with the model ready, a draft renders with mode `local`; in Firefox
    with a key set, mode `server`; with `AI_DISABLED=true`, mode `template` and the draft
    still renders. `pnpm test` — v1 `outreach.test.ts` untouched and green.

- [x] **Add the mode badge**
  - Files: `src/modules/builder-profile/components/OutreachCopilot.tsx`
  - Do: Small pill next to the draft's "Message" label: `on-device` / `server AI` /
    `template`, `data-testid="outreach-mode"`; template mode includes the reason line when
    present. Reuse existing pill/badge classes.
  - Verify: Badge reflects each path from the previous task's matrix.

## Phase 3 — Revision actions + download UX

- [x] **Add Rewrite and Shorten actions**
  - Files: `src/modules/builder-profile/components/OutreachCopilot.tsx`
  - Do: Two ghost buttons under the draft (`data-testid="outreach-rewrite"` /
    `"outreach-shorten"`), hidden when `mode === 'template'`. Handler: if
    `getAICapability('rewriter') === 'available'`, use
    `Rewriter.create({ length: 'shorter' })`-style call on `draft.body` (subject and
    hookSource preserved, result length still clamped to 1200); otherwise re-invoke
    `ai('outreach-draft', { ...input, revision: { previousBody: draft.body, instruction } })`
    through the same ladder (template fallback here keeps the previous draft and shows a
    toast-level note instead). Spinner state per button.
  - Verify: In Chrome, Shorten visibly shortens the body; in Firefox it round-trips via the
    server; in template mode the buttons don't render.

- [x] **Show the model download prompt inside the panel**
  - Files: `src/modules/builder-profile/components/OutreachCopilot.tsx`
  - Do: When the panel is open and `useAICapabilities()` reports `needsDownload`, render
    `<AIDownloadPrompt />` (from `src/shared/components/AIDownloadPrompt.tsx`) above the
    Generate button. Generation is not blocked — server/template rungs work meanwhile.
  - Verify: Fresh Chrome profile shows the prompt in the open panel; after download,
    generation switches to mode `on-device`; non-Chromium browsers never show it.

- [x] **Degradation matrix verification pass**
  - Files: none
  - Do: Verify all rungs end-to-end: (a) Chrome + model → local; (b)
    `bh-ai-prefer-server=1` → server; (c) free user's 11th draft of the day → template with
    budget note; (d) `AI_DISABLED_TASKS=outreach-draft` → template, no badge errors, no
    console errors; (e) copy button works in every mode.
  - Verify: Matrix passes; `pnpm test && pnpm type-check && pnpm lint` green.
