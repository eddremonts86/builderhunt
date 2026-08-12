# Feature: Tenant Activity Feed

> **Status**: `implemented` — unblocked 2026-07-29. It still runs *after* `28-shared-resources`, whose
> mutations it records, but that plan is executable now, so this is sequencing rather than a hold
> **Depends on**: [`security-and-multitenancy`](../01-security-and-multitenancy/spec.md), [`team-accounts`](../27-team-accounts/spec.md), [`shared-resources`](../28-shared-resources/spec.md)
> **Blocks**: nothing
> **Reality check**: no event/audit table exists. The previous design resolved organizations from
> actor user IDs, accepted optional organization IDs, and treated best-effort logging as unaudited
> fire-and-forget. The foundation requires server tenant principals, RLS, organization-preserving
> targets, idempotency, redaction, and separate security-audit versus product-activity semantics.

## Goal

Provide a useful Team-visible feed of approved product events inside the active organization without
turning security audit logs into UI content or leaking private payloads. Product activity is tenant-
private and may be retained/pruned; security audit is system-operational, append-only, more strictly
controlled, and never directly rendered to ordinary members.

## Event model

`organization_activity_events` contains organization, id, actor user (nullable after deletion),
event type/version, target type/ID, redacted display metadata, idempotency key, and timestamp. It has
`UNIQUE (organization_id,id)`, unique `(organization_id,idempotency_key)`, keyset index
`(organization_id,created_at DESC,id DESC)`, checked types/versions, RLS, and app-role insert/select
grants but no update. Deletes are worker retention only.

Targets that reference tenant resources carry composite `(organization_id,target_id)` integrity when
the target must remain live. Deletion-history events use a redacted snapshot/checksum rather than a
dangling foreign key. Metadata is validated per event version and never contains note contents,
query keywords, emails, tokens, prompts/responses, contact data, or private enrichment.

Approved v1 types: organization membership joined/removed, shared search created/shared/deleted,
builder tracked/untracked, private-note-added (existence only), list created/item added/removed, and
alert triggered. No view/read events, raw request bodies, or per-keystroke noise.

## Emission and reads

Domain services emit inside the same tenant transaction as the successful mutation when the event is
part of product consistency. Idempotency derives from mutation/request ID plus event type. A failed
activity insert rolls back the product mutation unless the event is explicitly classified as
non-critical observability; silent loss is not allowed for ownership, membership, sharing, export,
or deletion events.

`listOrganizationActivity(tx, principal, cursor, filters)` reads only active organization rows under
RLS with keyset pagination. Client filters never choose organization. DTO formatting is pure and
version-aware. Deleted actors render as a former member; metadata remains minimized.

## Security audit separation

`security_audit_events` belongs to the security foundation and records sensitive authorization/
lifecycle outcomes for owner/support review. The product feed may reference a non-sensitive audit
correlation ID but cannot read the table. Ordinary organization members do not receive security
failure events, IP addresses, user agents, email addresses, or administrative reasons.

## Retention and access

Product activity retains 180 days by default, pruned by a tenant-aware worker role in bounded batches.
Organization entitlement controls UI access without deleting rows on lapse. Owner-authorized export
includes the allowlisted feed; subject/account export includes only the actor's personal audit
references as permitted by privacy policy.

## Acceptance criteria

- Tenant A/B API and direct app-role SQL isolation pass; missing context returns no rows.
- Duplicate/retried mutations produce one activity event; transaction failure produces neither
  mutation nor event.
- Every metadata schema rejects sensitive/unknown fields and public/security audit data never crosses
  into feed DTOs.
- Membership removal invalidates access immediately; switching organizations clears feed cache.
- Retention worker deletes only eligible tenant batches and cannot read unrelated private tables.
- Keyset pagination has no duplicate/skip under equal timestamps and meets the recorded query budget.

## Future

- Realtime updates, user-configurable activity filters/retention, and redacted weekly AI digest after
  the tenant worker and AI policies are implemented.
