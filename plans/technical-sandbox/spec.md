# Feature: AI Technical Persona Sandbox

## Problem

Evaluating a developer's technical communication skills and architectural criteria normally requires scheduling an expensive, multi-stage live technical interview. During early-stage sourcing, it is difficult to determine if a developer's engineering philosophy aligns with a team's values without talking to them.

Recruiters and engineering managers lack a low-friction, non-invasive way to probe a developer's technical perspective and project choices before initiating outreach.

## Goal

Provide a virtual technical interview simulator ("Technical Sandbox"). The system reads a builder's public code assets, blog posts, and forum debates, and instructs an LLM to simulate that developer's technical "persona". 

The user can chat with this persona to ask technical questions about their real-world code (e.g. "Why did you select the Actor model instead of locks in your persistent cache library?"). The sandbox replies using the developer's verified codebase patterns and public technical communication style.

## Non-goals

- **No grading or performance scoring.** The sandbox does not issue technical grades; it only simulates discussion.
- **No live interview replacement.** This is an exploratory tool for candidate vetting, not a substitute for human evaluation.

## User stories

1. **As a tech lead**, in the builder details view, I want to open the "Technical Sandbox" and see a console interface simulating the builder's command-line context.
2. **As a tech lead**, I want to choose from a list of pre-configured, context-aware icebreaker questions based on their real repositories (e.g. "Explain the concurrency logic in repo `fast-cache`").
3. **As a tech lead**, I want to chat in real-time, asking custom questions, and receive streaming technical responses explaining their engineering decisions.

## Technical architecture

### 1. Persona Prompt Generation
When the sandbox session is opened for `builderId`:
- Load the developer's complete profiles, project descriptions, languages, readme text files, and key code samples from the database.
- Construct a dynamic roleplay System Prompt:
  ```
  You are roleplaying as [displayName], a software builder who has built [projects list] using [languages]. 
  Your coding style is characterized by [codingStyle] and your core specialties are [specialties].
  
  Instructions:
  - Respond technically, directly, and honestly based ONLY on your public footprint and standard software patterns.
  - Do not exaggerate your achievements. If asked about technologies you haven't used, admit you don't know them or explain how you'd approach them theoretically.
  - Adopt a peer-to-peer technical tone (direct, precise, command-line focused). Avoid pedagogical or polite corporate fluff.
  ```

### 2. Streaming Chat Connection
- Set up a Server-Sent Events (SSE) streaming API route `GET /api/builders/:id/sandbox/chat`.
- Maintain a local session chat history array in the database:

```ts
export const sandboxChats = pgTable('sandbox_chats', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => authUsers.id),
  builderId: text('builder_id').notNull().references(() => builders.id, { onDelete: 'cascade' }),
  messages: jsonb('messages').$type<Array<{ role: 'user' | 'assistant'; content: string }>>().default([]),
  createdAt: timestamp('created_at').defaultNow(),
})
```

- When the user sends a message, append it to `messages`, load the dynamic persona prompt, call the Gemini API (`gemini-2.5-flash` with streaming enabled), and pipe the response chunks to the client. Save the final message back to the DB.

## UX integration

- Implement a full-screen or sliding sidebar modal styled as a developer terminal (dark mode background, green/cyan mono-font text, retro cursor).
- Display a list of quick-start clickable chips:
  - *"Why did you use Drizzle instead of Prisma in builderhunt?"*
  - *"How do you handle API rate limits in your Bluesky connector?"*
- Stream the Markdown text responses directly inside the terminal window, with syntax highlighting active for any code snippets the persona writes.

## Success metrics

- **Engagement**: Tech leads spend an average of 4 minutes chatting with candidates' sandboxes, validating interest before recruiting outreach.
- **Conversion**: Candidates sourced by recruiters who chatted in the sandbox receive 40% higher response rates because the subsequent outreach contains precise technical alignment.
