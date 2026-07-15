# Plan: Maintenance & Project Hygiene Checker

## Goal recap

Build a project health evaluation service that queries repository issue metadata, PR resolution times, documentation standards, and CI/CD pipelines, mapping outcomes to an interactive bento panel.

## Why this is a valuable addition

1. **Identifies "Finisher" Candidates**: Traditional platforms cannot distinguish between a developer who writes buggy, abandoned scripts and an engineer who maintains stable open-source products.
2. **Quantifies Coding Rigor**: Evaluating automated test pipelines (CI/CD) and documentation proves a builder has professional production-level discipline.
3. **Enterprise Selling Angle**: Recruiter organizations will pay premium memberships to ensure candidates have verified engineering hygiene profiles.

## Phases

### Phase 1: Database Setup
- Modify `builders` metadata to include the `projectHygiene` schema types.
- Sync migrations on the PostgreSQL database instances.

### Phase 2: Sourcing Scanner Pipeline (`src/lib/hygiene/scanner.ts`)
- Implement fetch handlers querying repository issue and pull request list endpoints.
- Parse file lists to verify `.github/workflows/`, `README.md`, and `CONTRIBUTING.md` presence.
- Write the scoring compiler formula.
- Create tests asserting calculations are correct when API returns empty or zero issues counts.

### Phase 3: Server Action
- Build TanStack Start Server Function `calculateProjectHygiene({ builderId })`.
- Fetch repository details, call scanner pipeline, update database row metadata, and return outcomes.
- Limit scanning requests (only recalculate if `lastAnalyzedAt` is > 15 days old to save API tokens).

### Phase 4: Project Health bento card UI
- Build `src/modules/builder-profile/components/ProjectHygienePanel.tsx`.
- Design visual gauges for score displays.
- Render project list tables displaying individual repository health flags.

### Phase 5: Verification & Safety
- Check rate-limit mitigation: repository issues API calls use cached payloads to avoid running out of Github request quotas.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **Github API rate limits from deep issue searches** | High | High | Restrict query parameters (`per_page=20` instead of downloading full history). Only scan the top 3 repositories by star count. |
| **Outdated statistics** | Medium | Low | Set a cache validation window of 15 days. Update statistics automatically when a profile is claimed. |

## Rollback plan

- Keep the hygiene panel self-contained. Toggle visibility off in UI stylesheets if API queries overload backend request queues.
