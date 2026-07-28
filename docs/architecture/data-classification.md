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
tenant-private tables (`drizzle/0081_wakeful_butterfly.sql`). What remains is the contract phase —
dropping the legacy `user_id` columns — and flipping reads to canonical mode (`TENANT_READ_MODE`
still defaults to `legacy`). `builders` and the legacy plan surfaces stay marked as transition
findings until then.

Authorization must never depend on `metadata`, `payload`, `topics`, `keywords`, selections, or other
JSON fields. Future tables must be added here before their migration is accepted and must document
owner key, DTO fields, retention, indexes, constraints, RLS policy, and introducing plan.
