# Data Classification and Ownership

Classes are `global-public`, `account-subject`, `tenant-private`, and `system-operational`. Public
means intentionally publishable through an allowlisted DTO, not unrestricted table access. Account
subject data follows the authenticated person across organizations. Tenant-private data always uses
organization ownership after migration. Operational tables are inaccessible to the web role unless
an explicitly reviewed view or command is listed.

| Table | Class | Canonical owner | Public fields | Retention / transition |
| --- | --- | --- | --- | --- |
| auth_users | account-subject | user `id` | none | account lifetime + legal hold |
| auth_sessions | account-subject | `user_id` | none | expiry + short operational window |
| auth_accounts | account-subject | `user_id` | none | account lifetime; tokens secret |
| auth_verifications | account-subject | identifier subject | none | expiry + short abuse window |
| self_managed_profiles | account-subject | `owner_user_id` | handle, display_name, headline, bio, location, languages, services, topics, updated_at — **only when `visibility` is public or unlisted and `deleted_at` is null** | account lifetime; a soft-deleted profile is purged after the 30-day handle hold |
| self_managed_attachments | account-subject | via `profile_id` → profile owner | kind, title, description, mime_type, size_bytes, duration_seconds, uploaded_at — never `storage_key` | profile lifetime; the stored object must be deleted with the row |
| self_managed_handle_reservations | account-subject | `reserved_by_user_id` | none | seven days from reservation; expired rows swept |
| organizations | tenant-private | organization `id` (tenant root) | name/slug/logo only to authorized contexts | organization lifetime |
| organization_members | tenant-private | `organization_id` | none | membership + audit window |
| organization_invitations | tenant-private | `organization_id` | none | expiry + abuse/audit window |
| organization_entitlements | tenant-private | `organization_id` | none | financial/organization lifecycle |
| organization_plan_changes | tenant-private | `organization_id` + actor | none | financial/audit schedule |
| builder_identities | global-public | provider `(source, source_id)` | reviewed provider identity fields | provider/source lifecycle |
| builder_source_snapshots | system-operational | `builder_identity_id` | none | bounded version history |
| organization_builders | tenant-private | `organization_id` | none | organization lifecycle |
| builder_claims | account-subject | `subject_user_id` + source evidence | verification status only through reviewed DTO | claim/audit schedule |
| published_builder_profiles | global-public | verified identity + publisher | opt-in profile fields | until unpublish/revocation + audit |
| builders | tenant-private (legacy mixed model) | currently `user_id`; split required | none from this table after split | dual-write then contract |
| saved_queries | tenant-private | `organization_id` NOT NULL (`drizzle/0081`) | none | organization lifetime |
| alerts | tenant-private | `organization_id` NOT NULL (`drizzle/0081`) | none | organization lifetime |
| alert_triggers | tenant-private | `organization_id` NOT NULL (`drizzle/0081`) | none | configured alert history window |
| builder_notes | tenant-private | `organization_id` NOT NULL (`drizzle/0081`) | none | organization lifetime |
| builder_claim_requests | account-subject | claimant + source evidence | none; token must be hashed | expiry + abuse window |
| builder_profile_views | system-operational | measured builder + optional viewer subject | aggregates only | bounded analytics window |
| onboarding_progress | tenant-private | `organization_id` NOT NULL (`drizzle/0081`) | none | organization lifetime |
| incidents | global-public | platform | reviewed incident DTO | permanent status history |
| changelog | global-public | platform | reviewed published entry | permanent |
| roadmap_items | global-public | platform | reviewed roadmap DTO | permanent |
| roadmap_votes | account-subject | `user_id` | aggregate only | account/item lifetime |
| public_surface_indexing | system-operational | platform | none directly; its effect is the public robots meta / robots.txt / sitemap | permanent config, one row per surface |
| user_consents | account-subject | `user_id` | none | legal retention schedule |
| data_export_requests | account-subject | `user_id` | own status only; payload never public | payload expires promptly |
| deletion_requests | account-subject | `user_id` | own status only | legal/audit schedule |
| plans | account-subject (legacy entitlement) | currently `user_id`; target organization entitlement | none | compatibility window |
| plan_changes | system-operational (legacy) | affected user + admin actor | none | financial/audit schedule |
| plan_requests | account-subject (legacy) | `user_id`; target organization | none | support/audit schedule |
| user_devices | account-subject | `user_id` | none | rolling device-recognition window |
| account_risk | account-subject | `user_id` | none; stage never app-writable | until account closure |
| seat_usage_daily | tenant-private | `organization_id` (+ `user_id` seat) | none | rolling daily-quota window |
| session_signals | system-operational | correlation only (`session_id_hash`, no FK) | none | bounded investigation window |
| abuse_signals | system-operational | correlation only (`user_id`/`organization_id`, no FK) | none | append-only; bounded investigation window |

The schema contains **95 tables** as of 2026-07-27 (`grep -c '= pgTable(' src/shared/lib/db/schema.ts`
— re-derive it rather than trusting this number, which has been stale before). This table does not
yet have a row for every one of them: `pnpm db:audit-schema` currently reports ~53 unclassified
tables and exits non-zero, so it cannot be used as a release gate until that backlog is cleared.
Adding the missing rows is tracked work, not an oversight to rediscover.

The tenant-column half of the cutover is **done**: `organization_id` is `NOT NULL` on all seven
tenant-private tables (`drizzle/0081_wakeful_butterfly.sql`). Reads went canonical on 2026-08-03 and the
`TENANT_READ_MODE`/`TENANT_CANONICAL_READY` switch was removed with them — see
`docs/operations/tenant-cutover.md` step 4. What remains is the contract phase: dropping the legacy
`user_id` columns and the `plans`/`plan_requests` tables. `builders` and the legacy plan surfaces stay
marked as transition findings until that lands.

Authorization must never depend on `metadata`, `payload`, `topics`, `keywords`, selections, or other
JSON fields. Future tables must be added here before their migration is accepted and must document
owner key, DTO fields, retention, indexes, constraints, RLS policy, and introducing plan.



### Account-subject tables that strangers read

`self_managed_profiles` is the first table in this document that is keyed on a person **and** served
to the public. Every other account-subject row here has `none` in the public-fields column, and the
RLS shape that goes with it — owner-only, keyed on `app.user_id` — is what `0171_user_preferences`
established.

Copying that shape onto a profile table would be wrong in a way that looks right: these rows are read
at `/u/<handle>`, so owner-only makes every public profile invisible and the failure reads as "no
profiles exist" rather than as a policy. The migration therefore pairs an owner policy with a
public-read policy scoped to `visibility in ('public','unlisted') and deleted_at is null`.

`unlisted` is publicly readable at the row level on purpose — it means reachable by anyone holding
the link. Excluding it from *search* is the route's job, because a policy cannot tell a direct visit
from a listing.

An attachment's `storage_key` is never public. It is a path into object storage, and publishing it
makes the bucket's layout guessable from the outside.


## Table capabilities are an authorization surface

A `TableCapability` (`src/shared/lib/table/capability.ts`) is not a UI convenience. Its `sortable`,
`filterable`, `searchable` and `groupable` entries decide **which columns a client can reach**, and
nothing else does: there is no path from a request to an `ORDER BY` that does not go through
`sortable`, and none to a `WHERE` that does not go through `filterable` or `searchable`. A column id
arriving from a client is a string, and a string that reaches an `ORDER BY` unchecked is an injection
surface — which is why an id absent from the descriptor is a 400 rather than a query.

Two consequences for anyone changing one:

- **Adding an entry widens what a client may ask about a table.** A `filterable` column on a table
  whose rows carry another tenant's data still cannot cross the boundary — RLS and the emitted
  `organization_id` predicate are both in the way — but it can make a column *queryable* that the
  classification above may not intend to expose, one probe at a time.
- **`searchable` reaches text.** `ILIKE` over a column puts its contents behind a free-text box, so a
  column holding anything from the "restricted" rows of the tables above does not belong there.

`ProviderCapability`, in the same file, is the non-SQL sibling: a federation of third-party APIs has
no columns to allowlist, so it declares what it *can* serve and why no column allowlist applies.
`scripts/check-table-surfaces.mjs` is the gate that every grid on screen names one or the other.
