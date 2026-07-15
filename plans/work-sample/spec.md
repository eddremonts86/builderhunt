# Feature: Interactive Work Sample Simulator

## Problem

Senior developers despise generic coding assessment tools (such as HackerRank or LeetCode). They find algorithmic puzzles abstract, disconnected from daily engineering work, and frustrating because they don't reflect modern workflows where engineers write code with the aid of AI Copilots.

Companies need a way to propose practical, context-rich assessments ("Work Samples") that developers actually enjoy completing, and that accurately evaluate their problem-solving and collaboration skills.

## Goal

Provide a real-world coding assessment tool ("Work Sample Simulator"). A hiring company defines a coding task based on their real product (e.g. "Add a cache validation header to this middleware, resolving the failing integration test"). 

The builder solves the challenge inside an interactive browser-based Monaco editor, assisted by a dedicated AI Copilot (that acts as a collaborative teammate). The evaluation engine grades their architectural approach, readability, and error handling.

## Non-goals

- **No full container sandboxing (like running untrusted docker environments).** We run lightweight syntax checkers and evaluate the structural solution using LLMs, or mock execution tests in WebAssembly environments, to prevent security exploits.

## User stories

1. **As a recruiter**, I want to link a custom "Work Sample" to my job posting, letting candidates complete it from the profile portal.
2. **As a builder**, when I start a Work Sample, I want a code editor view showing instructions, a folder hierarchy, a terminal mock, and a chat sidebar to discuss problems with the AI teammate.
3. **As a tech lead**, I want to review candidate submissions, showing their final code and an AI-generated scorecard summarizing their modularity, error-handling habits, and speed.

## Technical architecture

### 1. Database Schema
We define two new tables: `work_samples` and `work_sample_submissions`.

```ts
export const workSamples = pgTable('work_samples', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => authUsers.id), // creator company
  title: text('title').notNull(),
  description: text('description').notNull(), // markdown task instructions
  starterCode: jsonb('starter_code').$type<Array<{ path: string; content: string }>>().notNull(), // virtual filesystem
  solutionPattern: text('solution_pattern').notNull(), // instructions for evaluation
  timeLimitMinutes: integer('time_limit_minutes').default(45),
  createdAt: timestamp('created_at').defaultNow(),
})

export const workSampleSubmissions = pgTable('work_sample_submissions', {
  id: text('id').primaryKey(),
  sampleId: text('work_sample_id').notNull().references(() => workSamples.id, { onDelete: 'cascade' }),
  builderId: text('builder_id').notNull().references(() => builders.id),
  submittedCode: jsonb('submitted_code').$type<Array<{ path: string; content: string }>>().notNull(),
  evaluation: jsonb('evaluation').$type<{
    score: number // 0-100
    pros: string[]
    cons: string[]
    detailedReview: string
  }>().notNull(),
  timeTakenSeconds: integer('time_taken_seconds').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
})
```

### 2. Monaco Editor & VFS (Virtual File System)
- Integrate `@monaco-editor/react` in the frontend dashboard view.
- Maintain a Virtual File System state in React state: `Record<string, string>` storing file paths and contents.
- Enable code editing and tab switching.

### 3. AI Teammate & Evaluator
- **Teammate Chat**: A sidebar drawer connected to a streaming API. The LLM gets a system prompt instructing it to act as a senior team member, giving architecture hints but not writing the code for the candidate.
- **Evaluation Action**: When the candidate clicks "Submit Challenge":
  - Package the virtual file system.
  - Send it to Gemini (`gemini-2.5-flash`) along with the `solutionPattern`.
  - The model inspects the diff, scores it based on correctness, readability, and modularity, and outputs the structured review JSON saved inside `work_sample_submissions`.

## UX integration

- Create a specialized layout at `/challenges/$id`.
- The interface splits into three panels:
  - **Left**: Task instructions rendered in clean markdown.
  - **Center**: Monaco Code Editor displaying the active file tab, with code syntax themes.
  - **Right**: Chat console sidebar with the AI teammate.
- At the bottom, a status bar displaying a countdown timer and a "Submit Solution" action button.

## Success metrics

- **Completion Rate**: Senior developers complete Work Samples at a 70% rate, compared to <25% for abstract algorithm challenges, due to the practical, real-world nature of the tasks.
- **Sourcing Efficacy**: Teams skip initial take-home coding rounds in 90% of candidates who pass the Work Sample.
