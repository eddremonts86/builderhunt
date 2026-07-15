# Plan: AI Talent Sourcing Sprints

## Goal recap

Build an asynchronous agentic sourcing pipeline where users can delegate talent searches to background-running agents that locate, screen, and review builders based on code analysis and project history.

## Why this is a valuable addition

1. **Passive Search Leverage**: Traditional talent tools require recruiters to be actively typing. Agentic search runs overnight, gathering and vetting profiles while the user is offline.
2. **Deep Code-Level Vetting**: Normal candidate databases only check tags. By pulling actual repository files and analyzing code style with LLMs, BuilderHunt provides high-integrity code vetting that LinkedIn or conventional search engines cannot match.
3. **Sticky Professional Retention**: Recruiters are willing to pay high subscription tiers for active sourcing reports delivered straight to their inbox.

## Phases

### Phase 1: Database Setup
- Add migrations for `sourcing_sprints` and `sprint_results` tables.
- Establish relationships with `authUsers` and `builders` tables.
- Update global Drizzle schema exports.

### Phase 2: Sourcing Agent Worker (`src/lib/agents/sourcing-worker.ts`)
- Implement a background task queue handler (using a lightweight library like `bullmq` or a native setInterval-based worker for simpler setups).
- Implement the search query generator: prompt LLM to break down candidate persona into search queries (location filters, GitHub topics, StackOverflow tags).
- Write the execution loop: fetch candidate arrays from our sources pipeline, insert raw results, and queue them for vetting.

### Phase 3: Code Vetting Engine (`src/lib/agents/vetting.ts`)
- Implement code fetch utility: download `README.md` and top 3 technical source files (e.g. main engine files in `.ts` or `.rs`) of the candidate's top repositories.
- Define LLM vetting prompt requesting structured scores and suitability review text.
- Save the results inside `sprint_results`.

### Phase 4: UI & Report Page
- Build the `/sprints` route and sub-routes in `src/routes/_dashboard/sprints/`.
- Design the agent progress screen, showing log ticks (e.g. "Scanning GitLab...", "Vetting user @xyz...").
- Render the completed Sprint Report list with expandable AI review panels.

### Phase 5: Verification & Safety
- Mock embedding and completions APIs in unit tests.
- Set strict API rate-limiting sleep cycles inside the worker to prevent GitHub/GitLab API blockages.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **GitHub rate limit blocked during deep searches** | High | High | Implement a 2-second sleep delay between external API calls inside the background worker. Cache search hits aggressively. |
| **High LLM token cost when reading source code** | Medium | Medium | Limit file content payload to the first 4,000 characters per source file. Truncate long repositories and only read technical files. |
| **Worker execution termination due to server restarts** | Medium | Low | Use database-backed task state storage. When the server boots up, auto-resume tasks marked as `running`. |

## Rollback plan

- Keep the entire worker system modular. Sprints can be disabled in the UI by hiding the `/sprints` link, without impacting standard real-time searches.
