# Plan: Code-Contextual Outreach Generator

## Goal recap

Build an interactive copywriting assistant that reads a builder's public code footprint (commits, repos) and writes tailored outreach drafts for recruiters, matching different tones and open roles.

## Why this is a valuable addition

1. **Addresses Sourcing's Biggest Bottleneck**: Finding candidates is only 20% of the job; getting them to reply is 80%. This tool targets the response bottleneck directly.
2. **Unlocks Deep Code Insights**: Traditional sourcing tools only scan LinkedIn headlines. By matching job descriptions to actual codebase structures and commits, BuilderHunt acts as a technical intermediary.
3. **High Virality Hook**: Recruiters will share drafts on social networks (e.g. "Look at this amazing Rust recruiting message this tool wrote for me"), generating organic traffic.

## Phases

### Phase 1: Sourcing Pitch Prompting (`src/lib/ai/pitch.ts`)
- Implement the copywriter utility using the Gemini API.
- Define system instructions for the 3 tones (`casual`, `professional`, `geek`).
- Write template parsers to combine job parameters and builder database columns.
- Test drafts on mock builders to verify they reference specific repositories and commits.

### Phase 2: Server Function & Limits
- Create a TanStack Start Server Function `generateOutreachDraft`.
- Integrate verification: only authenticated recruiters can invoke it.
- Implement rate limits (save request count to the session/database to prevent API spamming).

### Phase 3: UI Editor & Copying
- Create `src/modules/builder-profile/components/OutreachCopilot.tsx` inside the profile module.
- Design a sleek compose interface resembling a modern webmail editor.
- Include interactive sliders/selectors for tone.
- Implement clipboard copying utility with micro-animation transitions.

### Phase 4: Verification & Edge Cases
- Test cases where builders have empty repos: fall back to article references, or show an alert: "No repository data found for this builder; draft will rely on generic bio context."

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **AI hallucinations (referencing files or libraries they didn't write)** | Medium | High | Strict prompt training requiring the model to ONLY reference repositories and languages actually returned in the builder's verified db columns. |
| **High API latency** | Medium | Low | Run the generator asynchronously. Display a simulated progress bar in the compose window during loading. |

## Rollback plan

- Sourcing outreach is a self-contained modal. Disable it in the UI via the `ENABLE_OUTREACH_COPILOT=false` environment setting if LLM billing exceeds thresholds.
