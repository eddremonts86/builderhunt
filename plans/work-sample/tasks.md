# Tasks: Interactive Work Sample Simulator

## Phase 1: Database Setup
- [ ] Create database migration for `work_samples` and `work_sample_submissions`
- [ ] Update Drizzle schemas inside `src/shared/lib/db/schema.ts`

## Phase 2: VFS & Monaco editor
- [ ] Install `@monaco-editor/react` package
- [ ] Create VFS helper state manager:
  - [ ] Implement file selection tab components
  - [ ] Implement virtual file addition/editing hooks
- [ ] Integrate Monaco editor container within central grid

## Phase 3: AI Teammate Chat
- [ ] Create streaming route `/api/challenges/:id/chat`
  - [ ] Implement system prompt for technical teammate roleplay
  - [ ] Stream response chunks to the chat drawer sidebar
- [ ] Build chat interface in sidebar

## Phase 4: AI Grading Engine
- [ ] Create `src/lib/challenges/evaluator.ts`
  - [ ] Write diff generator comparing starting code and submitted code
  - [ ] Implement Gemini evaluator prompt checking correctness and clean style
  - [ ] Build submission server action saving grading outcome JSON to DB
  - [ ] Redirect candidates to a "Completed" landing page upon submission

## Phase 5: Split-Panel UI
- [ ] Create route file `src/routes/challenges.$id.tsx`
  - [ ] Implement split-pane layout (instructions, Monaco, teammate sidebar)
  - [ ] Build header bar displaying task title, countdown timer, and submit trigger
- [ ] Test layout responsiveness on various viewport resolutions
