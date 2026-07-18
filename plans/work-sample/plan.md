# Plan: Interactive Work Sample Simulator

**Status:** Not yet implemented. Listed as a Team-tier feature ("Work-sample analysis")
in [`billing-shared.ts`](../../src/shared/lib/billing-shared.ts) but there is no
`work_samples` table, no Monaco integration, and no `/challenges` route in the codebase
yet — this plan predates any of that work.

## Goal recap

Build a browser-based Monaco editor coding interface with a virtual filesystem, a streaming AI teammate chat sidebar, and an LLM-powered review engine to evaluate developer submissions based on practical projects.

## Why this is a valuable addition

1. **High-Signal Vetting**: Assessing coding skills on real-world engineering issues is much more accurate than abstract LeetCode algorithms.
2. **Senior Developer Appeal**: Tech professionals appreciate practical, low-friction challenges where they are allowed to discuss ideas with an AI helper, aligning with modern workflows.
3. **Enterprise Sourcing Tier monetization**: Companies are willing to pay premium subscriptions to create and manage custom coding challenges.

## Phases

### Phase 1: Database Setup
- Add migrations for `work_samples` and `work_sample_submissions` tables.
- Establish cascade deletions and foreign keys.

### Phase 2: Virtual File System & Monaco integration
- Install `@monaco-editor/react`.
- Design Virtual File System (VFS) manager in React:
  - State hook managing files map.
  - Tab navigation bar switching between active files (e.g. `index.ts`, `middleware.ts`).

### Phase 3: AI Teammate Chat & Streaming
- Write streaming handler `GET /api/challenges/:id/chat` connecting the sidebar to a Gemini stream.
- Prompt: instruct the model to help the candidate theoretically without outputting full blocks of solution code.

### Phase 4: Evaluation Action (`src/lib/challenges/evaluator.ts`)
- Implement the review function:
  - Aggregate files diff between starter code and submitted code.
  - Call Gemini (`gemini-2.5-flash`) to generate structured JSON scorecards detailing modularity, correctness, and clean coding practices.
  - Store scorecards in `work_sample_submissions`.

### Phase 5: Split-Panel Challenge UI
- Build the `/challenges/$id` view.
- Design:
  - Dark-mode Monaco layout.
  - Left markdown instruction container.
  - Right collapsible chat console drawer.
  - Header countdown timer.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **AI teammate solves the challenge for the user** | High | High | Implement strict system prompt rules. Enforce a daily token limit on teammate chat to prevent endless prompt loops. |
| **No code execution validation** | Medium | Medium | Since code is not executed on our server to prevent sandbox exploits, rely on the LLM's structural inspection. In future versions, compile and run tests client-side in WebAssembly container shells. |

## Rollback plan

- Challenge system is isolated under `/challenges`. Disable routing pointers if Monaco integrations cause memory leaks on low-end visitor devices.
