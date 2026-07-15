# Feature: AI Code-Style Fingerprinting

## Problem

Recruiting tools match candidate resumes to job descriptions based on keywords (e.g. "React developer"). However, code style and architectural compatibility are ignored. If an engineering team writes modular, strictly-typed, functional code using Test-Driven Development (TDD), hiring a developer who writes unstructured, untested Object-Oriented code will cause Friction, slow reviews, and low integration.

Hiring managers need a way to answer: "Does this builder write code that looks like our team's codebase?"

## Goal

Provide a code compatibility engine ("Code-Style Fingerprinting"). This will:
- Run a static analysis and LLM-assisted profiling check on a builder's repositories to generate a "Code-Style Vector" (representing metrics like modularity, test-to-code ratio, formatting rigor, and paradigm preference).
- Allow recruiters or tech leads to upload a code sample (e.g., a file from their own codebase) and query the database for builders who share an identical coding signature.

## Non-goals

- **No compilation validation.** The parser does not build or run the uploaded code; it only evaluates stylistic and structural properties.
- **No static security analysis.** This is not a vulnerability scanner (like SonarQube); it is a code-style mapping tool.

## User stories

1. **As a tech lead**, I want to drag and drop a file from my codebase (e.g., a complex controller) and search for candidates whose coding habits (naming, length, comments) match that file.
2. **As a recruiter**, in the builder details view, I want to see a "Code-Style Profile" bento card showing their code distribution (e.g. Functional vs. Object-Oriented, Test Intensity, and Documentation Density).
3. **As a builder**, I want to see my calculated fingerprint to understand how my open-source style is classified by potential employers.

## Technical architecture

### 1. Code-Style Vector Payload
The fingerprint is stored in `builders.metadata.codeStyleFingerprint` as a JSON block:

```ts
export interface CodeStyleFingerprint {
  paradigm: 'functional' | 'oop' | 'pragmatic' // primary coding pattern
  modularityScore: number                       // 0-100 (average function size, class decoupling)
  testIntensity: number                         // 0-100 (ratio of test files to implementation files)
  documentationRatio: number                    // 0-100 (comments density, JSDoc/docstrings usage)
  complexityControl: number                     // 0-100 (average cyclomatic complexity per function)
  namingConsistency: number                     // 0-100 (adherence to naming conventions)
}
```

### 2. Fingerprint Extraction Pipeline
- When a builder's repos are analyzed:
  - Download 5 technical source files across their top 3 repositories.
  - Run a lightweight AST parser (like `esprima` or regex filters) to extract basic stats:
    - Code lines vs. comment lines.
    - Average function length.
    - Test folder matches (`__tests__`, `.test.ts`, `spec.rs`).
  - Feed these stats + source snippets to Gemini API (`gemini-2.5-flash`) to generate the unified `CodeStyleFingerprint` JSON block.

### 3. Match Query Flow
- When a user uploads a code sample (`sample_file.ts`):
  - Send the sample to the parser and LLM to generate its `CodeStyleFingerprint` vector.
  - Query the PostgreSQL database for builders who have the closest Euclidean/Manhattan distance across the metrics:
    ```sql
    SELECT *, 
           (ABS(f.modularity_score - :sampleModularity) + 
            ABS(f.test_intensity - :sampleTest) + 
            ABS(f.complexity_control - :sampleComplexity)) AS distance
    FROM builders
    ORDER BY distance ASC
    LIMIT 15;
    ```

## UX integration

- Create a `/fingerprint` route.
- **Code Uploader Zone**: A clean drag-and-drop file interface featuring subtle micro-animations (e.g. scanning light animations).
- **Match Meter Results**: Candidate list displaying match percentages (e.g., "96% Style Match") alongside a bar comparison chart showing where the candidate matches or diverges from the uploaded sample.

## Success metrics

- **Integration Speed**: New hires matched via Code-Style Fingerprinting merge their first Pull Request 30% faster due to styling and architectural alignment.
- **Recruiter Satisfaction**: Engineering managers rate candidates sourced through the Style Matcher as "highly relevant to the team's coding guidelines" in >80% of hires.
