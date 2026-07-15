# Tasks: Code-Contextual Outreach Generator

## Phase 1: AI Pitch Service
- [ ] Create `src/lib/ai/pitch.ts`
  - [ ] Implement LLM prompt builder supporting 3 tones (casual, professional, geek)
  - [ ] Write safety validations to prevent referencing non-existent repositories
  - [ ] Build parser to inject job details (title, company, description)
- [ ] Write unit tests verifying generated drafts under `tests/ai/pitch.test.ts`

## Phase 2: Server Handler & Quotas
- [ ] Create TanStack Start Server Function `generateOutreachDraft`
  - [ ] Enforce user session authentication
  - [ ] Implement database/redis request quota limit checks (e.g. max 10 requests per day)
  - [ ] Return subject and body JSON payload

## Phase 3: Copilot UI Panel
- [ ] Create `src/modules/builder-profile/components/OutreachCopilot.tsx`
  - [ ] Build collapsible panel layout in the builder detail sheet
  - [ ] Add job input text boxes and tone radio buttons
  - [ ] Build the drafting card with mail composer theme
  - [ ] Integrate copy-to-clipboard button with visual tick status change

## Phase 4: Safety & Fallbacks
- [ ] Test LLM fallback when builder profile lacks repository metadata (ensure it falls back to parsing their bios or blog article taglines)
