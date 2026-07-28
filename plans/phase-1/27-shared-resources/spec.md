# Feature: Shared Searches and Builder Lists

> **Status**: `blocked`
> **Depends on**: [`security-and-multitenancy`](../01-security-and-multitenancy/spec.md), [`team-accounts`](../26-team-accounts/spec.md)
> **Blocks**: [`activity-feed`](../28-activity-feed/spec.md)
> **Reality check**: saved queries, tracked builders, and notes are user-scoped today; no list tables
> exist. The former design used nullable organization stamps and per-user builder snapshots. The
> security foundation instead supplies mandatory tenant ownership, global builder identities,
> organization tracking associations, composite tenant FKs, active context, and RLS.

## Goal

Deliver the Team promise of shared saved searches and builder lists entirely inside the active
organization boundary, while retaining creator attribution and explicit private/team visibility.
Tenant ownership is `organization_id`; `created_by_user_id` is attribution/permission metadata, not
scope.

## Data model

- `saved_queries` is tenant-owned. It carries `organization_id`, creator, and visibility
  `private | organization`. Private means visible to creator plus permitted admins; organization
  means visible to current members.
- Normalized `saved_query_keywords` and `saved_query_sources` preserve tenant identity with composite
  FKs. Alerts referencing a query include the same organization in their composite FK.
- `builder_lists` is tenant-owned with creator, visibility, name, description, timestamps, and
  `(organization_id,id)` candidate key.
- `builder_list_items` carries `organization_id`, `list_id`, `builder_identity_id`, adder, and time;
  composite FKs guarantee list and global builder association are valid for the tenant. It does not
  duplicate provider display snapshots or reference another user's tracking row.
- Private builder notes stay tenant data with creator-private visibility by default; shared comments
  remain out of scope.

The active organization entitlement gates Team sharing. Switching organizations changes the entire
repository context; no `mine OR organizationId` query crosses organizations.

## Authorization

| Action                                   | creator | member | admin                       | owner                       |
| ---------------------------------------- | ------- | ------ | --------------------------- | --------------------------- |
| Read organization-visible resource       | yes     | yes    | yes                         | yes                         |
| Read another creator's private resource  | no      | no     | policy-defined support only | policy-defined support only |
| Create search/list/item                  | yes     | yes    | yes                         | yes                         |
| Edit/delete own resource                 | yes     | n/a    | yes                         | yes                         |
| Edit/delete another member's shared item | no      | no     | yes                         | yes                         |
| Change visibility                        | creator | no     | yes                         | yes                         |

All decisions use the foundation permission service and tenant transaction. APIs never accept an
authoritative organization ID, import the global DB client, or return ORM rows.

## Alert and tracking semantics

Sharing a search does not subscribe teammates. A member may create their own alert from an
organization-visible query; the alert and query share organization identity, while recipient user is
explicit. Query keyword snapshots let existing opted-in alerts continue if sharing changes, subject
to documented retention.

A list item references the canonical global builder identity. `trackedByMe` is derived from the
active organization's `organization_builders` association plus user attribution where the product
needs personal state. Adding to a list never publishes the builder, modifies a claim, or imports
tenant-private enrichment into global identity.

## API and UX

- `/api/queries`: tenant-scoped list/create/update/delete using private/organization visibility.
- `/api/lists` and `/api/lists/$listId`: list CRUD from tenant repositories.
- `/api/lists/$listId/items`: canonical builder identity item CRUD.
- Search save dialog and dashboard show private/organization visibility and creator attribution.
- Search result/profile cards add a canonical identity to a selected organization list.
- `/lists` and `/lists/$listId` render organization-scoped lists/items and permission-aware actions.

Every client cache key starts with the active organization key and clears on organization switch as
defined by `team-accounts`.

## Security requirements

- Mandatory `organization_id`, candidate keys, composite tenant FKs, indexes, and RLS `USING`/
  `WITH CHECK` on all private tables.
- Tenant A/B direct-SQL and API tests for list/search/alert/item IDs and spoofed organization input.
- Private creator resources return consistent non-enumerating errors to other members.
- Public RSS does not reuse private query IDs; `rss-feeds` must use an explicit revocable public feed
  capability or publication record before a tenant query can be exposed.
- Exports require tenant permission and explicit DTOs; notes/private enrichment never appear in list
  output.
- Audit events redact query/list contents and record only allowed metadata.

## Acceptance criteria

- Two members in organization A share searches/lists as authorized; B cannot read, mutate, reference,
  export, or infer them through API or direct app-role SQL.
- Switching organizations replaces visible searches/lists and cached results without leakage.
- PostgreSQL rejects cross-tenant alert→query and list-item→list references.
- Sharing creates no alert/email; each recipient opts in independently.
- Global builder identity remains deduplicated while list/tracking/private artifacts remain tenant-
  isolated.
- All security foundation, Team, migration, RLS, static, build, and runtime gates pass.

## Future

- Shared comments, contact-state workflow, list export, numeric list limits, and redacted AI team
  digest after the core collaboration boundary is proven.
