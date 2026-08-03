# Tenant Cutover Runbook

Canonical mode is blocked by `assessTenantReadiness`. All evidence must correspond to the same
release candidate and database snapshot:

1. Empty install and legacy upgrade migrations pass twice without drift.
2. Personal organizations, memberships, entitlements, builders, and private resources reconcile;
   every source row is migrated, skipped, conflicted, or orphaned exactly once.
3. Zero rows with a null `organization_id` remain on the tenant-private tables
   (`builders`, `saved_queries`, `alerts`, `alert_triggers`, `builder_notes`,
   `onboarding_progress`, `onboarding_selected_builders`). `abuse_signals` is excluded on
   purpose — it is operational telemetry with no owning subject, and a signal raised before
   authentication has no organization to attribute.
4. Zero unresolved rows in `migration_backfill_conflicts`. A conflict means an
   `organization_id` that does not resolve to a real organization, and needs a human
   disposition. A row belonging to a team organization rather than its creator's personal one
   is *not* a conflict: that is the normal shape of shared work, and it stays correct after the
   creator leaves the team.
5. Direct SQL RLS tests pass as the exact app/auth/worker roles, including pool reuse.
6. API tenant A/B, worker isolation, privacy export/deletion, and restore rehearsal pass.
7. Inventory reports zero legacy-only consumers — no read or write that scopes by `user_id`
   without also scoping by `organization_id`, except deliberate account-subject operations
   (privacy export and account deletion, which span every organization by design).

## Why there is no shadow-read observation window

Earlier revisions of this runbook required "shadow reads report zero mismatches for at least
24 hours". That criterion was removed because it could never be satisfied and proved nothing.

Shadow reading compares an old query against a new one on every request and expects them to
agree. Here they are *supposed* to disagree: the legacy read answers "the saved searches I
created" and the canonical read answers "my organization's saved searches". Any organization
with two contributing members diverges permanently and by design, so the mismatch counter can
only reach zero in a deployment where nobody uses a shared workspace — precisely the case the
cutover does not need to be safe for. The machinery was also wired into a single route, with no
write-side caller at all, so it observed a sliver of the system.

Criteria 3, 4 and 7 above replace it: they measure what the `NOT NULL` cutover can actually
fail on.

## Order of operations

1. Take a fresh verified restore point.
2. Run `pnpm db:backfill:resources` (`--dry-run` first). Confirm the reported counts reconcile
   and that conflicts and orphans are zero.
3. Deploy the release carrying `drizzle/0081_wakeful_butterfly.sql`. Its guard aborts with a
   named error listing any table that still holds a null tenant, so a forgotten backfill fails
   fast instead of surfacing as a bare constraint violation on whichever table Postgres reached
   first.
4. ~~Switch one surface at a time from `legacy` to `canonical` via `TENANT_READ_MODE`.~~ **Done and
   retired, 2026-08-03.** Reads are canonical unconditionally; `TENANT_READ_MODE` and
   `TENANT_CANONICAL_READY` no longer exist. There was only ever one surface behind the flag —
   `GET /api/queries` — and its two answers ("the saved searches I created" vs "my organization's")
   diverge by design for any organization with two contributing members, so the flag was not a
   rollback but a second product. Keeping it also made the shared-workspace promise depend on a
   deployment remembering to set a variable.

Rollback before contract is application compatibility: diagnose and migrate forward. There is no read
flag to return to. Do not disable RLS and do not restore owner credentials to the web service.

Legacy drops, organization purge, conflict disposition, and credential cutover require explicit
environment-owner approval plus a fresh verified restore point.
