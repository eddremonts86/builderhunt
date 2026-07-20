# Tenant Cutover Runbook

Canonical mode is blocked by `assessTenantReadiness`. All evidence must correspond to the same
release candidate and database snapshot:

1. Empty install and legacy upgrade migrations pass twice without drift.
2. Personal organizations, memberships, entitlements, builders, and private resources reconcile;
   every source row is migrated, skipped, conflicted, or orphaned exactly once.
3. Conflicts contain only identifiers/reason/checksum and have an approved disposition.
4. Shadow reads report zero mismatches for at least 24 hours.
5. Direct SQL RLS tests pass as the exact app/auth/worker roles, including pool reuse.
6. API tenant A/B, worker isolation, privacy export/deletion, and restore rehearsal pass.
7. Inventory reports zero legacy-only consumers.

Switch one surface at a time from `legacy` to `shadow` to `canonical`. Canonical reads or writes are
rejected while readiness is false. Observe denial rate, shadow mismatches, latency, and policy query
plans after each surface.

Rollback before contract is application compatibility: return the affected read flag to `legacy`
or `shadow`, keep dual writes, diagnose, and migrate forward. Do not disable RLS and do not restore
owner credentials to the web service. Validate `NOT VALID` constraints and apply `NOT NULL` only
after zero-null queries and lock budgets pass on production-sized sanitized data.

Legacy drops, organization purge, conflict disposition, and credential cutover require explicit
environment-owner approval plus a fresh verified restore point.

