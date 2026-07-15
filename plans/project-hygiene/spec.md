# Feature: Maintenance & Project Hygiene Checker

## Problem

Star counts and commit volumes only measure popularity and raw activity. They do not reflect **maintenance hygiene and engineering rigor**. A repository with 10k stars could have 500 open issues, ignored Pull Requests, and zero automated tests, indicating a developer who abandons projects or writes chaotic, unmaintainable code.

Recruiters and tech leads need to identify: "Does this builder write production-grade, well-maintained code, or do they only build fragile prototypes?"

## Goal

Provide a repository quality evaluation utility ("Project Hygiene Checker"). This tool queries a builder's repositories to measure:
- **Issue Resolution Velocity**: Average days taken to close public issues.
- **PR Management Hygiene**: Ratio of merged vs. abandoned Pull Requests.
- **Documentation Rigor**: Reviewing README.md length, presence of CONTRIBUTING.md, and license details.
- **CI/CD Automation**: Presence of active pipeline configurations (GitHub Actions, GitLab CI).

These factors compile into a "Hygiene Score" mapped on a builder's profile detail view.

## Non-goals

- **No runtime linting of repository files.** The analyzer checks structural metadata and documentation files; it does not compile or run lint rules on their source files.
- **No private repository scanning.** Only public repository metadata is evaluated.

## User stories

1. **As a recruiter**, in the builder details view, I want to see a "Project Health" tab displaying hygiene metrics (average PR merge time, issue response rates) for their primary repositories.
2. **As a tech lead**, I want to filter builders to only show candidates who maintain projects with active CI/CD (GitHub Actions or GitLab CI) configurations.
3. **As a builder**, I want to see my calculated project hygiene dashboard to check how my open-source projects compare with industry standards.

## Technical architecture

### 1. Project Hygiene Data Schema
Hygiene statistics are stored inside `builders.metadata.projectHygiene`:

```ts
export interface ProjectHygiene {
  globalScore: number                   // 0-100 aggregated hygiene grade
  issueCloseRate: number                // 0-100 (closed issues / total issues)
  averageResolutionDays: number         // average time to resolve issues/PRs
  hasCICD: boolean                      // true if GitHub workflows or GitLab CI files exist
  documentationScore: number            // 0-100 (checks README, CONTRIBUTING, LICENSE)
  lastAnalyzedAt: number
}
```

### 2. Scanning Pipeline
- When a builder's project metrics are calculated:
  - Query repository details:
    - **Issues stats**: `GET /repos/:owner/:repo/issues?state=all&per_page=50` (calculate ratio of closed vs open issues).
    - **PRs stats**: `GET /repos/:owner/:repo/pulls?state=all&per_page=50` (calculate average resolution timeline by comparing `created_at` and `closed_at`).
    - **Files checklist**: Check for the existence of `.github/workflows/` folder, `CONTRIBUTING.md`, `LICENSE`, and `README.md`.
  - Calculate `globalScore`:
    - Issue close rate weight: 30%.
    - PR resolution rate weight: 30%.
    - Documentation presence weight: 20%.
    - CI/CD automation presence weight: 20%.

## UX integration

- Create a "Project Hygiene" bento card layout in the builder details view.
- Design:
  - Circular progress gauges displaying the `globalScore`.
  - Icon indicators for CI/CD pipeline status (active green check vs grey cross).
  - Interactive table showing detailed metrics (stars, open issues, close rate, doc score) per repository.

## Success metrics

- **Talent Quality**: Sourced candidates who score >85 on Project Hygiene receive 50% fewer code quality refactor requests during their first month of employment.
- **Engineering Confidence**: Tech leads trust candidate recommendations significantly more, leading to a 30% reduction in pre-screening stages.
