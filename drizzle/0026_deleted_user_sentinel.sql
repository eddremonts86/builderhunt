-- `organization_builders.creator_user_id` and `sourcing_sprints.creator_user_id`
-- both `references auth_users.id, { onDelete: 'restrict' }` — deliberately,
-- since these are organization-owned resources (visible/manageable by the
-- whole org, not just their creator) and must never silently disappear or
-- lose their audit trail just because the creating account is later deleted.
-- But `hardDeleteAccountSubject` never accounted for this: any real user who
-- had ever tracked a builder or created a sprint in any organization could
-- never have their account hard-deleted — every deletion attempt failed on
-- this FK, forever, with the error only ever reaching a swallowed worker log.
-- Found via scripts/db/verify-api-isolation-local.mjs's checkLegalRunWorker.
--
-- Fix: a permanent sentinel `auth_users` row that `hardDeleteAccountSubject`
-- reassigns these rows to instead of deleting them — preserves the
-- organization's data and the NOT NULL/FK contract, while
-- `resource.creatorUserId === principal.userId` (src/shared/lib/authorization/
-- permissions.ts) never matches this id for any real principal, so a
-- previously-private resource whose creator is gone fails closed (visible
-- only via `visibility = 'organization'`), not open.
insert into auth_users (id, name, email, email_verified, created_at, updated_at)
values ('system-deleted-user', 'Deleted user', 'deleted-user@system.builderhunt.internal', false, now(), now())
on conflict (id) do nothing;
