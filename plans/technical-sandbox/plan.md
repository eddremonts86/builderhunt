# Plan: AI Technical Persona Sandbox

## Goal recap

Build a streaming terminal-style sandbox where users can chat with a builder's AI persona, discussing architectural choices and code structures in real-time.

## Why this is a valuable addition

1. **Revolutionary Recruiting Loop**: Instead of looking at a passive resume, recruiters can *converse* with the candidate's code footprint. This is a massive differentiator that elevates BuilderHunt above basic scrapers.
2. **Deep Technical Vetting**: Engineering managers can test the candidate's architectural choices under pressure before spending time scheduling Zoom calls.
3. **Immersive Design**: A retro dark-theme terminal interface is highly appealing to tech audiences, ensuring premium user retention.

## Phases

### Phase 1: Database Setup
- Create a migration to add the `sandbox_chats` table to store session chat histories.
- Link the table with cascade delete policies.

### Phase 2: Persona Prompt Engine (`src/lib/ai/sandbox.ts`)
- Implement the prompt compiler that aggregates:
  - Repositories, files, and commits metadata.
  - Blog post and social post summaries.
  - AI enrichment details (seniority, strengths, style).
- Combine them into a System Instruction roleplay definition.

### Phase 3: Streaming Server Action
- Set up a streaming route handler using TanStack Start's HTTP handlers (or custom API route using EventStream headers).
- Configure the Gemini SDK client to run stream completions:
  ```ts
  const responseStream = await ai.models.generateContentStream({
    model: 'gemini-2.5-flash',
    contents: [...messages],
    config: { systemInstruction: personaPrompt }
  })
  ```
- Send chunk events to the browser client.

### Phase 4: Retro Terminal Frontend UI
- Create `src/modules/builder-profile/components/TechnicalSandbox.tsx`.
- Design a dark-mode terminal layout:
  - Consolas/Monaco monospace fonts.
  - Interactive CLI inputs.
  - Auto-scrolling logs.
- Parse markdown and code blocks returned by the model stream using React Markdown.

### Phase 5: Verification & Safety
- Write integration tests checking chat history persistence.
- Implement token-size limits (truncate chat context if it exceeds 6,000 tokens to control Gemini pricing).

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **AI persona hallucinates credentials** | High | Medium | Inject strict instruction: "If you don't know the answer or it isn't in your repos, admit it or explain it theoretically. Do not lie." |
| **API Costs from long chat sessions** | Medium | High | Limit chat sessions to a maximum of 20 message rounds per sandbox. Reset logs after 24 hours. |

## Rollback plan

- Keep the sandbox link protected behind the `ENABLE_SANDBOX=false` flag. If disabled, hide the console launcher from the builder card dashboard.
