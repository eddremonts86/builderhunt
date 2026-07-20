# Dependency Security Policy

## Release gate

- Production dependencies must have no known high or critical vulnerabilities.
- `pnpm audit --prod --audit-level high` is a blocking CI and release check.
- Moderate findings require an owner, documented exposure analysis, and a target date.
- Lockfile changes require review; install scripts and new licenses are reviewed before merge.
- Dependabot runs weekly and groups compatible minor/patch updates.

## Exceptions

An exception must identify the advisory, reachable code path, compensating control, owner, expiry,
and removal plan. Expired exceptions block release. Audit output must never include registry tokens.
