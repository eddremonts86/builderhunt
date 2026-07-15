# Tasks: AI Code-Style Fingerprinting

## Phase 1: AST Parser Integration
- [ ] Create `src/lib/fingerprint/parser.ts`
  - [ ] Implement line counter for code vs. comments
  - [ ] Implement AST parser (using `acorn` or regex) to count functions and extract average size
  - [ ] Write directory parser to check for test folders
- [ ] Write unit tests verifying parser metrics output under `tests/fingerprint/parser.test.ts`

## Phase 2: LLM Profiling Engine
- [ ] Create `src/lib/fingerprint/profiler.ts`
  - [ ] Design Gemini API prompt to analyze code style and output JSON
  - [ ] Integrate background task to calculate fingerprint during builder imports
  - [ ] Update Drizzle schema metadata type for `builders` table

## Phase 3: Matching Vector Query
- [ ] Implement similarity search query in `src/lib/search.ts`
  - [ ] Write SQL query calculating Euclidean/Manhattan distance across fingerprint metrics
  - [ ] Add distance sorting and pagination handlers
- [ ] Build Server Function `findStyleMatches` to run queries asynchronously

## Phase 4: Drag & Drop UI
- [ ] Create route file `src/routes/_dashboard/fingerprint.tsx`
  - [ ] Build drag-and-drop file uploader zone with CSS file hover states
  - [ ] Build visual "Code Match Meter" list showing candidates
  - [ ] Build radar or bar comparison charts comparing sample code against candidate profiles

## Phase 5: Verification & Safety
- [ ] Test matching relevance with distinct sample files
- [ ] Validate uploader safety limits (max 500KB file restriction)
