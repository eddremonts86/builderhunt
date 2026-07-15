# Tasks: AI Technical Persona Sandbox

## Phase 1: Database Setup
- [ ] Create database migration for `sandbox_chats`
- [ ] Add `sandbox_chats` mapping inside `src/shared/lib/db/schema.ts`
- [ ] Configure automatic cascade deletion constraints

## Phase 2: Persona Prompt Compiler
- [ ] Create `src/lib/ai/sandbox.ts`
  - [ ] Implement code and context compiler script
  - [ ] Write system instruction builder for developer persona roleplay
  - [ ] Test system prompt outputs using mock data payloads

## Phase 3: Streaming Route Handler
- [ ] Create API route or Server Function endpoint supporting Server-Sent Events (SSE) streaming
  - [ ] Enforce user session authentication
  - [ ] Stream Gemini API response chunks using `generateContentStream`
  - [ ] Capture stream completions and append final AI message to `sandbox_chats` database row

## Phase 4: Retro Terminal Frontend UI
- [ ] Create `src/modules/builder-profile/components/TechnicalSandbox.tsx`
  - [ ] Design terminal window shell container (dark mode, monospace typography)
  - [ ] Implement quick-start prompt chips based on builder's projects list
  - [ ] Implement input state management with mock prompt runner
  - [ ] Render streaming responses with active Markdown parsing and code snippet highlighting
  - [ ] Add auto-scroll utility to keep cursor in view

## Phase 5: Verification & Safety
- [ ] Test SSE connection performance on local networks
- [ ] Implement strict conversation limits (max 20 messages per session)
