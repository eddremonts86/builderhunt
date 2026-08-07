import { authUsers } from '~/shared/lib/db/schema'

import { defineTableCapability, registerTableCapability } from '../capability'

/**
 * The platform-admin user list.
 *
 * `listPlatformUsers` returned **every user in the system** — the worst entry in the phase-1 audit,
 * and the one `admin/users.tsx` then filtered in the browser. That filter is why bounding this read
 * is not only a performance change: searching the loaded 50 for an email and finding nothing is a
 * different answer from searching all of them, and the page gave the first while looking like it
 * gave the second.
 *
 * So `email` and `name` are `searchable`, which puts the `ILIKE` in Postgres over the whole table.
 *
 * No `organizationColumn`: this is a platform surface that lists users across every workspace,
 * reached through `platformTablePageHandler`. Plan tier is deliberately **not** sortable or
 * filterable — it is not a column on `auth_users`, it is composed per user by
 * `getPlatformUserBillingSummary` from a Postgres function. Sorting by it would mean sorting the
 * loaded page, which is the exact wrongness this phase removes.
 */
export const PLATFORM_USERS_TABLE = 'platform_users'

export const platformUsersCapability = registerTableCapability(defineTableCapability({
  table: PLATFORM_USERS_TABLE,
  sortable: {
    // Backed by `auth_users_created_id_idx`.
    createdAt: { column: authUsers.createdAt },
    // Backed by `auth_users_name_id_idx`.
    name: { column: authUsers.name },
  },
  filterable: {},
  groupable: [],
  searchable: [authUsers.name, authUsers.email],
  tiebreaker: authUsers.id,
  defaultSort: [{ id: 'createdAt', dir: 'desc' }],
}))
