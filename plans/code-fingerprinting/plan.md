# Plan: AI Code-Style Fingerprinting

## Goal recap

Build a code compatibility profiling engine that maps developers' coding signatures based on AST analysis and LLM profiling, allowing recruiters to upload code snippets and find developers with similar style habits.

## Why this is a valuable addition

1. **Deep Code alignment**: No other candidate matching tool looks at actual coding structure and paradigm habits. This represents a highly disruptive feature for recruitment software.
2. **Accelerates Onboarding**: Teams waste time arguing about styling and architecture in PRs. Matching candidates with pre-aligned habits reduces codebase friction.
3. **Interactive UI Hook**: Tech leads love testing code snippets. It provides an immediate interactive hook that drives word-of-mouth adoption.

## Phases

### Phase 1: AST Parser Integration (`src/lib/fingerprint/parser.ts`)
- Implement a parser utility (using lightweight Javascript AST tools like `acorn` or simple regex/line counters for multi-language support).
- Extract structural metrics:
  - Average lines per function.
  - Ratio of comment lines to code lines.
  - Number of exported modules vs. imports.
  - Count of test descriptors (`describe`, `test`, `assert`).

### Phase 2: LLM Profiler (`src/lib/fingerprint/profiler.ts`)
- Combine AST metrics with 3 key code snippets from the builder's repos.
- Invoke Gemini API (`gemini-2.5-flash`) to normalize inputs and output the structured `CodeStyleFingerprint` JSON block.
- Cache the fingerprint in the `builders` table under the `metadata.codeStyleFingerprint` field.

### Phase 3: Distance Vector Query Actions
- Create Server Function `findStyleMatches({ sampleCode })`.
- Within the function:
  - Generate fingerprint for `sampleCode`.
  - Calculate Euclidean distance across the 6 dimensions of the fingerprint vector.
  - Return the top 15 matches sorted by distance ascending.

### Phase 4: Drag & Drop Dashboard UI
- Build the `/fingerprint` dashboard view.
- Create the drop zone with CSS glow animations.
- Display styling radar comparisons for each candidate (comparing sample code metrics against candidate profile).

### Phase 5: Verification & Safety
- Write unit tests validating that the distance calculation correctly handles null or default profiles.
- Set a file size limit (max 500KB) for uploaded samples to avoid overloading the parser.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **Multi-language styling inconsistencies** | High | Medium | Normalize metrics per language. (e.g. do not compare a Python script against a Rust builder's fingerprint directly without language qualifiers). |
| **Parsing syntax errors on invalid code** | Medium | Low | Use try-catch blocks in the parser. If AST parsing fails, fallback to simple regex-based line analysis. |

## Rollback plan

- The fingerprint search is an independent view. Disable the `/fingerprint` link if LLM API usage spikes, leaving traditional search active.
