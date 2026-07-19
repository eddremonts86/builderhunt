# Builder Tracking & `/exports` Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the missing "track a builder" write path (search results → `builders` table) and rebuild `/exports` around the real, now-populated list.

**Architecture:** One new DB unique index, one new shared server helper, three route-handler changes (one new endpoint, one new verb on an existing route, one extension of the search endpoint), one small existing-bug fix in billing limits, and two UI changes (a toggle button in search results, a full rewrite of the exports page).

**Tech Stack:** TanStack Start file-based API routes, Drizzle ORM (Postgres), Zod, React 19, Vitest.

## Global Constraints

- Follow existing route-handler conventions exactly: `export const Route = createFileRoute('/path')({ component: () => null, server: { handlers: { METHOD: async ({ request, params }) => {...} } } })`.
- Auth check pattern: `const session = await auth.api.getSession({ headers: request.headers }); if (!session?.user?.id) return Response.json({ error: 'Unauthorized' }, { status: 401 })`.
- IDs for new rows: `randomId()` from `~/lib/utils` (24-char hex), matching `saved_queries`/`builder_notes`, not `crypto.randomUUID()`.
- Plan-limit-exceeded responses return **402** with `{ error, limit, current, plan, upgradeUrl: '/pricing' }`, matching `src/routes/api/queries/index.ts`.
- DB migrations are generated with `pnpm db:generate`, never hand-written — this repo had a production incident from a hand-desynced `drizzle/meta/_journal.json` (see the `database-migrations` ai-os skill). Verify the journal and a new `NNNN_snapshot.json` file both appear before committing.
- This codebase's Vitest suite (`vitest.config.ts`) only covers `src/lib/**` and `src/shared/**`, and only tests pure/constant logic (see `src/shared/lib/legal.test.ts`, `billing.test.ts`) — no route handler in this repo has a mocked-DB unit test. Follow that convention: write real Vitest tests only for pure helper functions introduced here; verify DB-backed route handlers and UI by running the dev server and testing through the browser (curl for APIs, Playwright-style manual pass for UI), per the ai-os coolify-deploy skill's "always verify in a real browser" rule.

---

### Task 1: Add a unique index to `builders` and generate the migration

**Files:**
- Modify: `src/shared/lib/db/schema.ts:59-86` (the `builders` table definition)
- Generate: `drizzle/NNNN_<name>.sql`, `drizzle/meta/NNNN_snapshot.json`, `drizzle/meta/_journal.json` (via `drizzle-kit generate`, not hand-written)

**Interfaces:**
- Produces: a unique constraint on `builders (user_id, source, source_id)` named `builders_user_source_unique`, which Task 3's `onConflictDoUpdate` targets by column list `[builders.userId, builders.source, builders.sourceId]`.

- [ ] **Step 1: Change the `builders` table to the 3-arg `pgTable` form with a unique constraint**

Current (lines 59-86):
```typescript
export const builders = pgTable('builders', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => authUsers.id),
  source: text('source').notNull(), // github | reddit | hn | devto
  sourceId: text('source_id').notNull(),
  username: text('username').notNull(),
  displayName: text('display_name'),
  avatarUrl: text('avatar_url'),
  bio: text('bio'),
  profileUrl: text('profile_url').notNull(),
  followersCount: integer('followers_count').default(0),
  language: text('language'),
  country: text('country'),
  topics: jsonb('topics').$type<string[]>().default([]),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  firstSeen: timestamp('first_seen').defaultNow(),
  lastSeen: timestamp('last_seen').defaultNow(),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
  // Claimable profile fields (Plan 8)
  isClaimed: boolean('is_claimed').default(false).notNull(),
  claimedByUserId: text('claimed_by_user_id').references(() => authUsers.id, { onDelete: 'set null' }),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  isVerified: boolean('is_verified').default(false).notNull(),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  openToStatus: jsonb('open_to_status').$type<string[]>().default([]).notNull(),
  claimedTopics: jsonb('claimed_topics').$type<string[]>().default([]).notNull(),
})
```

Replace with:
```typescript
export const builders = pgTable(
  'builders',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => authUsers.id),
    source: text('source').notNull(), // github | reddit | hn | devto
    sourceId: text('source_id').notNull(),
    username: text('username').notNull(),
    displayName: text('display_name'),
    avatarUrl: text('avatar_url'),
    bio: text('bio'),
    profileUrl: text('profile_url').notNull(),
    followersCount: integer('followers_count').default(0),
    language: text('language'),
    country: text('country'),
    topics: jsonb('topics').$type<string[]>().default([]),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
    firstSeen: timestamp('first_seen').defaultNow(),
    lastSeen: timestamp('last_seen').defaultNow(),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow(),
    // Claimable profile fields (Plan 8)
    isClaimed: boolean('is_claimed').default(false).notNull(),
    claimedByUserId: text('claimed_by_user_id').references(() => authUsers.id, { onDelete: 'set null' }),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    isVerified: boolean('is_verified').default(false).notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    openToStatus: jsonb('open_to_status').$type<string[]>().default([]).notNull(),
    claimedTopics: jsonb('claimed_topics').$type<string[]>().default([]).notNull(),
  },
  (table) => ({
    userSourceUnique: unique('builders_user_source_unique').on(table.userId, table.source, table.sourceId),
  }),
)
```

(`unique` is already imported at the top of `schema.ts` — no import change needed.)

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected output includes a new file like `drizzle/0007_<two-word-name>.sql` containing:
```sql
CREATE UNIQUE INDEX "builders_user_source_unique" ON "builders" USING btree ("user_id","source","source_id");
```

- [ ] **Step 3: Verify the journal and snapshot were both updated together**

Run: `git status --short drizzle/`
Expected: shows the new `.sql` file, a new `meta/0007_snapshot.json`, and `meta/_journal.json` modified (with a new `entries[]` row for the new migration). If the journal is NOT modified, stop — do not proceed, `drizzle-kit generate` failed to register the migration (this is the exact failure mode that broke production earlier).

- [ ] **Step 4: Apply the migration to the local dev DB**

Run: `pnpm db:migrate`
Expected: ends with `[✓] migrations applied successfully!` and no errors.

- [ ] **Step 5: Verify the index exists**

Run: `docker exec builderhunt-db psql -U postgres -d builderhunt -c "\d builders" | grep unique`
Expected: a line showing `builders_user_source_unique` as a UNIQUE constraint/index.

- [ ] **Step 6: Commit**

```bash
git add src/shared/lib/db/schema.ts drizzle/
git commit -m "feat(db): add unique index on builders(user_id, source, source_id)"
```

---

### Task 2: Shared tracked-builder key helper

**Files:**
- Create: `src/shared/lib/tracked-builders.ts`
- Test: `src/shared/lib/tracked-builders.test.ts`

**Interfaces:**
- Produces: `trackedKey(source: string, sourceId: string): string` (pure), `getTrackedKeySet(userId: string): Promise<Set<string>>` (DB-backed). Both are imported by Task 6 (`/api/search/builders`) and Task 7 (`/api/recommendations`).

- [ ] **Step 1: Write the failing test for the pure key function**

```typescript
// src/shared/lib/tracked-builders.test.ts
import { describe, it, expect } from 'vitest'
import { trackedKey } from './tracked-builders'

describe('trackedKey', () => {
  it('joins source and sourceId with a colon', () => {
    expect(trackedKey('github', '12345')).toBe('github:12345')
  })

  it('produces different keys for different sources with the same sourceId', () => {
    expect(trackedKey('github', '1')).not.toBe(trackedKey('reddit', '1'))
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/shared/lib/tracked-builders.test.ts`
Expected: FAIL — `Cannot find module './tracked-builders'` (file doesn't exist yet).

- [ ] **Step 3: Implement the helper**

```typescript
// src/shared/lib/tracked-builders.ts
import { db } from '~/shared/lib/db/index'
import { builders } from '~/shared/lib/db/schema'
import { eq } from 'drizzle-orm'

export function trackedKey(source: string, sourceId: string): string {
  return `${source}:${sourceId}`
}

/**
 * All (source, sourceId) pairs the given user has already tracked, as a Set
 * of `trackedKey()`-formatted strings. `builders.id` is per-user (each
 * tracker gets their own row for the same external profile), so this is the
 * only reliable "have I already saved this one" check across the app.
 */
export async function getTrackedKeySet(userId: string): Promise<Set<string>> {
  const rows = await db
    .select({ source: builders.source, sourceId: builders.sourceId })
    .from(builders)
    .where(eq(builders.userId, userId))
  return new Set(rows.map((r) => trackedKey(r.source, r.sourceId)))
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/shared/lib/tracked-builders.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/lib/tracked-builders.ts src/shared/lib/tracked-builders.test.ts
git commit -m "feat: add shared tracked-builder key helper"
```

---

### Task 3: `POST /api/builders/track` — save a builder from search

**Files:**
- Create: `src/routes/api/builders/track.ts`

**Interfaces:**
- Consumes: `getTrackedKeySet` not used here directly (this route does its own targeted existence check, not a full-set fetch); `randomId` from `~/lib/utils`; `checkLimit` from `~/shared/lib/billing` (signature: `checkLimit(userId: string, resource: 'savedBuilders' | ...): Promise<{ allowed: boolean; current: number; limit: number; plan: string }>`, already defined).
- Produces: `POST /api/builders/track` — request body matches the fields on a search result (see below); response `{ id: string, tracked: true }` on success, `{ error, limit, current, plan, upgradeUrl }` with status 402 when the free-tier `savedBuilders` limit (50) is reached, `401` unauthenticated, `400` invalid body. Consumed by Task 9 (search UI).

- [ ] **Step 1: Write the route file**

```typescript
// src/routes/api/builders/track.ts
import { createFileRoute } from '@tanstack/react-router'
import { db } from '~/shared/lib/db/index'
import { builders } from '~/shared/lib/db/schema'
import { and, eq } from 'drizzle-orm'
import { auth } from '~/shared/lib/auth/better-auth'
import { randomId } from '~/lib/utils'
import { z } from 'zod'

const TrackBody = z.object({
  source: z.enum([
    'github', 'reddit', 'hn', 'devto', 'lobsters', 'stackoverflow',
    'npm', 'huggingface', 'gitlab', 'codeberg', 'hashnode', 'sourcehut',
  ]),
  sourceId: z.string().min(1),
  username: z.string().min(1),
  displayName: z.string().nullable().optional(),
  avatarUrl: z.string().nullable().optional(),
  bio: z.string().nullable().optional(),
  profileUrl: z.string().min(1),
  followersCount: z.number().nullable().optional(),
  language: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  topics: z.array(z.string()).optional(),
  score: z.number().optional(),
  metadata: z.record(z.unknown()).optional(),
})

export const Route = createFileRoute('/api/builders/track')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 })
          }
          const userId = session.user.id

          const body = await request.json().catch(() => ({}))
          const parsed = TrackBody.safeParse(body)
          if (!parsed.success) {
            return Response.json({ error: 'Invalid body', issues: parsed.error.flatten() }, { status: 400 })
          }
          const data = parsed.data

          const [existing] = await db
            .select({ id: builders.id })
            .from(builders)
            .where(
              and(
                eq(builders.userId, userId),
                eq(builders.source, data.source),
                eq(builders.sourceId, data.sourceId),
              ),
            )
            .limit(1)

          if (!existing) {
            const { checkLimit } = await import('~/shared/lib/billing')
            const limit = await checkLimit(userId, 'savedBuilders')
            if (!limit.allowed) {
              return Response.json(
                {
                  error: `You've reached the ${limit.plan} plan limit of ${limit.limit} saved builders. Upgrade to save more.`,
                  limit: limit.limit,
                  current: limit.current,
                  plan: limit.plan,
                  upgradeUrl: '/pricing',
                },
                { status: 402 },
              )
            }
          }

          const id = existing?.id ?? randomId()
          const [row] = await db
            .insert(builders)
            .values({
              id,
              userId,
              source: data.source,
              sourceId: data.sourceId,
              username: data.username,
              displayName: data.displayName ?? null,
              avatarUrl: data.avatarUrl ?? null,
              bio: data.bio ?? null,
              profileUrl: data.profileUrl,
              followersCount: data.followersCount ?? 0,
              language: data.language ?? null,
              country: data.country ?? null,
              topics: data.topics ?? [],
              metadata: { ...(data.metadata ?? {}), score: data.score ?? null },
            })
            .onConflictDoUpdate({
              target: [builders.userId, builders.source, builders.sourceId],
              set: { lastSeen: new Date(), updatedAt: new Date() },
            })
            .returning()

          return Response.json({ id: row.id, tracked: true })
        } catch (err) {
          console.error('Track builder error:', err)
          return Response.json({ error: 'Failed to track builder' }, { status: 500 })
        }
      },
    },
  },
})
```

- [ ] **Step 2: Start the dev server if it isn't already running**

Run: `pnpm dev:all` (or, if the DB is already up from Task 1, `pnpm dev`)
Expected: server listening on `http://localhost:3010` (per `.env`'s `PORT`/`APP_URL`).

- [ ] **Step 3: Verify manually with curl — unauthenticated request is rejected**

```bash
curl -sS -X POST http://localhost:3010/api/builders/track \
  -H "Content-Type: application/json" \
  -d '{"source":"github","sourceId":"999","username":"test","profileUrl":"https://github.com/test"}' \
  -w "\nHTTP %{http_code}\n"
```
Expected: `HTTP 401`.

- [ ] **Step 4: Verify manually with curl — authenticated track succeeds**

```bash
# Get a session cookie by signing in first
curl -sS -c /tmp/bh-cookies.txt -X POST http://localhost:3010/api/auth/sign-in/email \
  -H "Content-Type: application/json" \
  -d '{"email":"edd_admin@local.com","password":"Passw0rd!234"}' -o /dev/null

# Track a builder using that session
curl -sS -b /tmp/bh-cookies.txt -X POST http://localhost:3010/api/builders/track \
  -H "Content-Type: application/json" \
  -d '{"source":"github","sourceId":"999","username":"octocat","profileUrl":"https://github.com/octocat","score":72,"topics":["rust"]}' \
  -w "\nHTTP %{http_code}\n"
```
Expected: `HTTP 200` with `{"id":"<24-hex-chars>","tracked":true}`.

- [ ] **Step 5: Verify re-tracking the same builder doesn't create a duplicate row**

```bash
docker exec builderhunt-db psql -U postgres -d builderhunt -c \
  "SELECT count(*) FROM builders WHERE source='github' AND source_id='999';"
```
Expected: `1` (run Step 4's curl command a second time first, then this — count must stay 1, not become 2).

- [ ] **Step 6: Commit**

```bash
git add src/routes/api/builders/track.ts
git commit -m "feat: add POST /api/builders/track to save a builder from search"
```

---

### Task 4: `DELETE /api/builders/$builderId` — untrack a builder

**Files:**
- Modify: `src/routes/api/builders/$builderId.ts`

**Interfaces:**
- Produces: `DELETE /api/builders/:builderId` — `200 { success: true }` on success, `401` unauthenticated, `404` if the builder doesn't exist or isn't owned by the caller. Consumed by Task 9 (search toggle) and Task 10 (exports list "Remove" button).

- [ ] **Step 1: Add the DELETE handler**

In `src/routes/api/builders/$builderId.ts`, add `DELETE` alongside the existing `GET`/`PATCH` inside `server.handlers`:

```typescript
      DELETE: async ({ request, params }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 })
          }
          const userId = session.user.id
          const { builderId } = params

          const [existing] = await db
            .select({ id: builders.id, userId: builders.userId })
            .from(builders)
            .where(eq(builders.id, builderId))

          if (!existing || existing.userId !== userId) {
            return Response.json({ error: 'Builder not found' }, { status: 404 })
          }

          await db.delete(builders).where(eq(builders.id, builderId))

          return Response.json({ success: true })
        } catch (err) {
          console.error('Builder delete error:', err)
          return Response.json({ error: 'Failed to delete builder' }, { status: 500 })
        }
      },
```

(No new imports needed — `db`, `builders`, `eq`, `auth` are already imported in this file.)

- [ ] **Step 2: Verify manually — delete the test builder from Task 3**

```bash
BID=$(docker exec builderhunt-db psql -U postgres -d builderhunt -t -c \
  "SELECT id FROM builders WHERE source='github' AND source_id='999';" | tr -d ' ')
curl -sS -b /tmp/bh-cookies.txt -X DELETE "http://localhost:3010/api/builders/$BID" \
  -w "\nHTTP %{http_code}\n"
```
Expected: `HTTP 200` with `{"success":true}`.

- [ ] **Step 3: Verify it's actually gone**

```bash
docker exec builderhunt-db psql -U postgres -d builderhunt -c \
  "SELECT count(*) FROM builders WHERE source='github' AND source_id='999';"
```
Expected: `0`.

- [ ] **Step 4: Verify ownership is enforced (delete someone else's builder → 404, not 500)**

Manually insert a row owned by a different user id, then attempt to delete it as `edd_admin`:
```bash
docker exec builderhunt-db psql -U postgres -d builderhunt -c \
  "INSERT INTO builders (id, user_id, source, source_id, username, profile_url) VALUES ('test-other-owner', 'some-other-user-id', 'github', '888', 'other', 'https://github.com/other');"
curl -sS -b /tmp/bh-cookies.txt -X DELETE "http://localhost:3010/api/builders/test-other-owner" \
  -w "\nHTTP %{http_code}\n"
docker exec builderhunt-db psql -U postgres -d builderhunt -c \
  "DELETE FROM builders WHERE id = 'test-other-owner';"
```
Expected: `HTTP 404` (not deleted), then clean up with the final `DELETE` (which bypasses the app and always succeeds since it's a direct DB call).

- [ ] **Step 5: Commit**

```bash
git add src/routes/api/builders/\$builderId.ts
git commit -m "feat: add DELETE handler to untrack a builder"
```

---

### Task 5: `GET /api/me/builders` — list the current user's tracked builders

**Files:**
- Create: `src/routes/api/me/builders/index.ts`

**Interfaces:**
- Produces: `GET /api/me/builders` → `200` with an array of `{ id, username, displayName, avatarUrl, source, profileUrl, topics, score, lastSeen }`, ordered most-recently-tracked first. `401` unauthenticated. Consumed by Task 10 (exports page list).

- [ ] **Step 1: Write the route file**

```typescript
// src/routes/api/me/builders/index.ts
import { createFileRoute } from '@tanstack/react-router'
import { db } from '~/shared/lib/db/index'
import { builders } from '~/shared/lib/db/schema'
import { desc, eq } from 'drizzle-orm'
import { auth } from '~/shared/lib/auth/better-auth'

export const Route = createFileRoute('/api/me/builders/')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 })
          }
          const userId = session.user.id

          const rows = await db
            .select()
            .from(builders)
            .where(eq(builders.userId, userId))
            .orderBy(desc(builders.lastSeen))

          return Response.json(
            rows.map((b) => ({
              id: b.id,
              username: b.username,
              displayName: b.displayName,
              avatarUrl: b.avatarUrl,
              source: b.source,
              profileUrl: b.profileUrl,
              topics: b.topics ?? [],
              score: typeof b.metadata?.score === 'number' ? b.metadata.score : null,
              lastSeen: b.lastSeen,
            })),
          )
        } catch (err) {
          console.error('List tracked builders error:', err)
          return Response.json({ error: 'Failed to fetch tracked builders' }, { status: 500 })
        }
      },
    },
  },
})
```

- [ ] **Step 2: Verify manually — re-track a builder, then list it**

```bash
curl -sS -b /tmp/bh-cookies.txt -X POST http://localhost:3010/api/builders/track \
  -H "Content-Type: application/json" \
  -d '{"source":"github","sourceId":"999","username":"octocat","profileUrl":"https://github.com/octocat","score":72,"topics":["rust"]}' -o /dev/null

curl -sS -b /tmp/bh-cookies.txt http://localhost:3010/api/me/builders -w "\nHTTP %{http_code}\n"
```
Expected: `HTTP 200` with a JSON array containing one object: `username: "octocat"`, `score: 72`, `topics: ["rust"]`.

- [ ] **Step 3: Commit**

```bash
git add src/routes/api/me/builders/index.ts
git commit -m "feat: add GET /api/me/builders to list tracked builders"
```

---

### Task 6: Annotate search results with `tracked` state

**Files:**
- Modify: `src/routes/api/search/builders.ts`

**Interfaces:**
- Consumes: `getTrackedKeySet`, `trackedKey` from Task 2.
- Produces: each object in the `builders` array of the `POST /api/search/builders` response gains a `tracked: boolean` field (present and accurate when the caller has a session; `false` for everyone when there's no session). Consumed by Task 9.

- [ ] **Step 1: Modify the route**

Current file:
```typescript
import { createFileRoute } from '@tanstack/react-router'
import { searchBuilders } from '~/lib/search'
import { rateLimit, getRateLimitId } from '~/shared/lib/rate-limit'

export const Route = createFileRoute('/api/search/builders')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const rl = await rateLimit('search-builders', getRateLimitId(request), 60, 60)
          if (!rl.allowed) {
            return Response.json(
              { error: 'Too many search requests. Please slow down.' },
              { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.resetMs / 1000)) } },
            )
          }

          const body = await request.json()
          const {
            keywords,
            sources,
            language,
            country,
            page = 1,
            perPage = 30,
          } = body
          const keywordsArray = typeof keywords === 'string'
            ? keywords.split(/[,\s]+/).filter(Boolean)
            : Array.isArray(keywords) ? keywords : []
          const results = await searchBuilders({
            keywords: keywordsArray,
            sources: Array.isArray(sources) ? sources : undefined,
            language,
            country,
            page,
            perPage,
          })
          return Response.json({
            builders: results,
            page,
            perPage,
            hasMore: results.length >= perPage,
          })
        } catch (err) {
          console.error('Search error:', err)
          return Response.json({ error: 'Search failed' }, { status: 500 })
        }
      },
    },
  },
})
```

Replace with:
```typescript
import { createFileRoute } from '@tanstack/react-router'
import { searchBuilders } from '~/lib/search'
import { rateLimit, getRateLimitId } from '~/shared/lib/rate-limit'
import { auth } from '~/shared/lib/auth/better-auth'
import { getTrackedKeySet, trackedKey } from '~/shared/lib/tracked-builders'

export const Route = createFileRoute('/api/search/builders')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const rl = await rateLimit('search-builders', getRateLimitId(request), 60, 60)
          if (!rl.allowed) {
            return Response.json(
              { error: 'Too many search requests. Please slow down.' },
              { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.resetMs / 1000)) } },
            )
          }

          const body = await request.json()
          const {
            keywords,
            sources,
            language,
            country,
            page = 1,
            perPage = 30,
          } = body
          const keywordsArray = typeof keywords === 'string'
            ? keywords.split(/[,\s]+/).filter(Boolean)
            : Array.isArray(keywords) ? keywords : []
          const results = await searchBuilders({
            keywords: keywordsArray,
            sources: Array.isArray(sources) ? sources : undefined,
            language,
            country,
            page,
            perPage,
          })

          const session = await auth.api.getSession({ headers: request.headers })
          const trackedKeys = session?.user?.id
            ? await getTrackedKeySet(session.user.id)
            : new Set<string>()
          const annotated = results.map((b) => ({
            ...b,
            tracked: trackedKeys.has(trackedKey(b.source, b.sourceId)),
          }))

          return Response.json({
            builders: annotated,
            page,
            perPage,
            hasMore: results.length >= perPage,
          })
        } catch (err) {
          console.error('Search error:', err)
          return Response.json({ error: 'Search failed' }, { status: 500 })
        }
      },
    },
  },
})
```

- [ ] **Step 2: Verify manually — signed-in search reflects tracked state**

```bash
curl -sS -b /tmp/bh-cookies.txt -X POST http://localhost:3010/api/search/builders \
  -H "Content-Type: application/json" \
  -d '{"keywords":"rust","sources":["github"],"page":1,"perPage":10}' \
  | python3 -m json.tool | grep -A2 '"tracked"' | head -6
```
Expected: at least one `"tracked": true|false` line present per result (won't necessarily match octocat since that's a fake tracked test entry, not a real search hit — the point is the field exists and is a real boolean, not undefined).

- [ ] **Step 3: Verify signed-out search still works and defaults tracked to false**

```bash
curl -sS -X POST http://localhost:3010/api/search/builders \
  -H "Content-Type: application/json" \
  -d '{"keywords":"rust","sources":["github"],"page":1,"perPage":5}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(all(b['tracked'] is False for b in d['builders']))"
```
Expected: `True`.

- [ ] **Step 4: Run the full test suite to confirm nothing broke**

Run: `pnpm vitest run`
Expected: all existing tests still pass (this file isn't covered by Vitest per the coverage config, but other tests must not regress).

- [ ] **Step 5: Commit**

```bash
git add src/routes/api/search/builders.ts
git commit -m "feat: annotate search results with tracked state"
```

---

### Task 7: De-duplicate the recommendations "already saved" query

**Files:**
- Modify: `src/routes/api/recommendations/index.ts:1-8` (imports), `:154-166` (the inline query)

**Interfaces:**
- Consumes: `getTrackedKeySet`, `trackedKey` from Task 2.

- [ ] **Step 1: Update the imports**

Current (top of file):
```typescript
import { createFileRoute } from '@tanstack/react-router'
import { auth } from '~/shared/lib/auth/better-auth'
import { db } from '~/shared/lib/db/index'
import { builders, savedQueries } from '~/shared/lib/db/schema'
import { desc, eq } from 'drizzle-orm'
import { searchBuilders } from '~/lib/search'
import { rateLimit } from '~/shared/lib/rate-limit'
```

Replace with (drop `builders` from the schema import — no longer referenced directly in this file — and add the shared helper):
```typescript
import { createFileRoute } from '@tanstack/react-router'
import { auth } from '~/shared/lib/auth/better-auth'
import { db } from '~/shared/lib/db/index'
import { savedQueries } from '~/shared/lib/db/schema'
import { desc, eq } from 'drizzle-orm'
import { searchBuilders } from '~/lib/search'
import { rateLimit } from '~/shared/lib/rate-limit'
import { getTrackedKeySet, trackedKey } from '~/shared/lib/tracked-builders'
```

- [ ] **Step 2: Replace the inline query**

Current:
```typescript
          // 5. Exclude builders the user has already saved (via notes or
          //    their own saved list) — we use sourceId+source as the key
          //    since builders.id is per-user
          const userSavedRows = await db
            .select({ id: builders.id, source: builders.source, sourceId: builders.sourceId })
            .from(builders)
            .where(eq(builders.userId, userId))
          const savedKey = new Set(
            userSavedRows.map((b) => `${b.source}:${b.sourceId}`),
          )

          const candidates = Array.from(aggregated.values()).filter(
            (a) => !savedKey.has(`${a.builder.source}:${a.builder.sourceId}`),
          )
```

Replace with:
```typescript
          // 5. Exclude builders the user has already tracked — sourceId+source
          //    is the key since builders.id is per-user (see tracked-builders.ts)
          const savedKey = await getTrackedKeySet(userId)

          const candidates = Array.from(aggregated.values()).filter(
            (a) => !savedKey.has(trackedKey(a.builder.source, a.builder.sourceId)),
          )
```

- [ ] **Step 3: Verify manually — recommendations endpoint still responds**

```bash
curl -sS -b /tmp/bh-cookies.txt http://localhost:3010/api/recommendations -w "\nHTTP %{http_code}\n"
```
Expected: `HTTP 200` (with either `{"recommendations":[],"meta":{"reason":"no_saved_searches"}}` if there are no saved searches for this test account, or a populated list — either is fine, the point is no 500).

- [ ] **Step 4: Run typecheck to confirm the removed `builders` import isn't used anywhere else in the file**

Run: `pnpm type-check`
Expected: no errors (if `builders` were still referenced elsewhere, this would fail with "Cannot find name 'builders'").

- [ ] **Step 5: Commit**

```bash
git add src/routes/api/recommendations/index.ts
git commit -m "refactor: recommendations reuses the shared tracked-builder helper"
```

---

### Task 8: Fix the `savedBuilders` plan limit to count actual tracked builders

**Files:**
- Modify: `src/shared/lib/billing.ts:6` (import), `:119-121` (the `savedBuilders` branch of `checkLimit`)

**Interfaces:**
- No signature change — `checkLimit(userId, 'savedBuilders')` still returns the same `LimitCheck` shape. Only what it counts changes.

- [ ] **Step 1: Understand why this needs fixing**

`PLAN_LIMITS` (in `billing-shared.ts`) defines `savedBuilders: 50` for free plans and the pricing page advertises "50 saved builders" / "Unlimited saved builders". Before this plan, `checkLimit('savedBuilders')` counted rows in `builder_notes` as a stand-in — the only per-user, per-builder table that existed. Now that `POST /api/builders/track` (Task 3) writes directly to `builders`, that's the real signal: a user could track 200 builders and write zero notes and never hit the limit under the old code, or write 50 notes on a single tracked builder and get incorrectly blocked.

- [ ] **Step 2: Update the import**

Current line 6:
```typescript
import { plans, planChanges, planRequests, savedQueries, builderNotes, authUsers } from '~/shared/lib/db/schema'
```

Replace with:
```typescript
import { plans, planChanges, planRequests, savedQueries, builders, authUsers } from '~/shared/lib/db/schema'
```

(`builderNotes` is no longer used anywhere else in this file — confirm with the grep in Step 4 before removing it.)

- [ ] **Step 3: Update the `checkLimit` branch**

Current (around line 119-121):
```typescript
  } else if (resource === 'savedBuilders') {
    const [r] = await db.select({ c: count() }).from(builderNotes).where(eq(builderNotes.userId, userId))
    current = Number(r?.c ?? 0)
```

Replace with:
```typescript
  } else if (resource === 'savedBuilders') {
    const [r] = await db.select({ c: count() }).from(builders).where(eq(builders.userId, userId))
    current = Number(r?.c ?? 0)
```

- [ ] **Step 4: Confirm `builderNotes` has no other usages in this file before removing the import**

Run: `grep -n "builderNotes" src/shared/lib/billing.ts`
Expected: no output (empty) — if there IS other output, keep `builderNotes` in the import list alongside `builders` instead of replacing it.

- [ ] **Step 5: Run the billing tests to confirm the static constants are untouched**

Run: `pnpm vitest run src/shared/lib/billing.test.ts`
Expected: PASS (this file only tests `PLAN_LIMITS` constants, not `checkLimit`, per the repo's DB-test convention — it shouldn't need edits).

- [ ] **Step 6: Verify manually — the limit now reflects tracked builders, not notes**

```bash
curl -sS -b /tmp/bh-cookies.txt http://localhost:3010/api/builders/track \
  -X POST -H "Content-Type: application/json" \
  -d '{"source":"github","sourceId":"999","username":"octocat","profileUrl":"https://github.com/octocat"}' -o /dev/null
docker exec builderhunt-db psql -U postgres -d builderhunt -c \
  "SELECT count(*) FROM builders WHERE user_id = (SELECT id FROM auth_users WHERE email = 'edd_admin@local.com');"
```
Expected: a count ≥ 1, matching however many test-tracks are still in the DB from earlier tasks (exact number doesn't matter — the point is this count is what now gates the limit, not `builder_notes`).

- [ ] **Step 7: Commit**

```bash
git add src/shared/lib/billing.ts
git commit -m "fix: savedBuilders plan limit counts tracked builders, not notes"
```

---

### Task 9: Track/untrack button in search results

**Files:**
- Modify: `src/modules/search/components/SearchPage.tsx`

**Interfaces:**
- Consumes: `POST /api/builders/track` (Task 3), `DELETE /api/builders/:id` (Task 4), the `tracked: boolean` field on search results (Task 6).

- [ ] **Step 1: Extend the local `Builder` interface**

Current (around line 17-33):
```typescript
interface Builder {
  id: string
  kind: BuilderKind
  source: 'github' | 'reddit' | 'hn' | 'devto' | 'lobsters' | 'stackoverflow' | 'npm' | 'huggingface' | 'gitlab' | 'codeberg' | 'hashnode' | 'sourcehut'
  username: string
  displayName?: string
  avatarUrl?: string
  bio?: string
  profileUrl: string
  followersCount?: number
  topics?: string[]
  score?: number
  lastSeen?: string
  language?: string
  country?: string
  metadata?: Record<string, unknown>
}
```

Add two fields (`sourceId` was already present at runtime, just untyped; `tracked` is new from Task 6):
```typescript
interface Builder {
  id: string
  kind: BuilderKind
  source: 'github' | 'reddit' | 'hn' | 'devto' | 'lobsters' | 'stackoverflow' | 'npm' | 'huggingface' | 'gitlab' | 'codeberg' | 'hashnode' | 'sourcehut'
  sourceId: string
  username: string
  displayName?: string
  avatarUrl?: string
  bio?: string
  profileUrl: string
  followersCount?: number
  topics?: string[]
  score?: number
  lastSeen?: string
  language?: string
  country?: string
  metadata?: Record<string, unknown>
  tracked?: boolean
}
```

- [ ] **Step 2: Add a toggle handler in the top-level `SearchPage` component**

Find the `SearchPage` component's other handlers (near `handleSaveSearch`, around line 408) and add:
```typescript
  /* Track / untrack a builder */
  const [trackingIds, setTrackingIds] = React.useState<Set<string>>(new Set())
  const handleToggleTrack = async (builder: Builder) => {
    if (trackingIds.has(builder.id)) return
    setTrackingIds((prev) => new Set(prev).add(builder.id))
    const wasTracked = builder.tracked ?? false
    // Optimistic update
    setResults((prev) => prev.map((b) => (b.id === builder.id ? { ...b, tracked: !wasTracked } : b)))
    try {
      if (wasTracked) {
        const res = await fetch(`/api/builders/${builder.id}`, { method: 'DELETE', credentials: 'include' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
      } else {
        const res = await fetch('/api/builders/track', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source: builder.source,
            sourceId: builder.sourceId,
            username: builder.username,
            displayName: builder.displayName,
            avatarUrl: builder.avatarUrl,
            bio: builder.bio,
            profileUrl: builder.profileUrl,
            followersCount: builder.followersCount,
            language: builder.language,
            country: builder.country,
            topics: builder.topics,
            score: builder.score,
            metadata: builder.metadata,
          }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
      }
    } catch {
      // Revert on failure
      setResults((prev) => prev.map((b) => (b.id === builder.id ? { ...b, tracked: wasTracked } : b)))
    } finally {
      setTrackingIds((prev) => {
        const next = new Set(prev)
        next.delete(builder.id)
        return next
      })
    }
  }
```

Note: `builder.id` here is the *external* result id (e.g. `gh-12345`), not a `builders` table row id — that's fine for the optimistic-update key and for `POST /api/builders/track`'s body, but the `DELETE` call needs the *database* row id, not the external id. Fix this in Step 3.

- [ ] **Step 3: Fix the untrack call to use the real database id**

The `DELETE /api/builders/:id` route (Task 4) expects the `builders` table's own `id`, which is only known after a successful track (`POST /api/builders/track` returns `{ id, tracked: true }`). Store that returned id on the builder object so untrack can use it. Update the interface (Step 1) once more:
```typescript
interface Builder {
  // ...same as Step 1...
  tracked?: boolean
  trackedRowId?: string
}
```
And update `handleToggleTrack` from Step 2 — replace the `if (wasTracked)` branch and the `else` branch's success handling:
```typescript
  const handleToggleTrack = async (builder: Builder) => {
    if (trackingIds.has(builder.id)) return
    setTrackingIds((prev) => new Set(prev).add(builder.id))
    const wasTracked = builder.tracked ?? false
    setResults((prev) => prev.map((b) => (b.id === builder.id ? { ...b, tracked: !wasTracked } : b)))
    try {
      if (wasTracked) {
        if (!builder.trackedRowId) throw new Error('Missing tracked row id')
        const res = await fetch(`/api/builders/${builder.trackedRowId}`, { method: 'DELETE', credentials: 'include' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        setResults((prev) => prev.map((b) => (b.id === builder.id ? { ...b, trackedRowId: undefined } : b)))
      } else {
        const res = await fetch('/api/builders/track', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source: builder.source,
            sourceId: builder.sourceId,
            username: builder.username,
            displayName: builder.displayName,
            avatarUrl: builder.avatarUrl,
            bio: builder.bio,
            profileUrl: builder.profileUrl,
            followersCount: builder.followersCount,
            language: builder.language,
            country: builder.country,
            topics: builder.topics,
            score: builder.score,
            metadata: builder.metadata,
          }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data: { id: string } = await res.json()
        setResults((prev) => prev.map((b) => (b.id === builder.id ? { ...b, trackedRowId: data.id } : b)))
      }
    } catch {
      setResults((prev) => prev.map((b) => (b.id === builder.id ? { ...b, tracked: wasTracked } : b)))
    } finally {
      setTrackingIds((prev) => {
        const next = new Set(prev)
        next.delete(builder.id)
        return next
      })
    }
  }
```

- [ ] **Step 4: Thread the handler down to `PersonResultCard`**

Find `BuilderResultCard` (around line 997) and its call site (around line 788). Update both to pass the handler through:
```typescript
function BuilderResultCard({ builder, query, onToggleTrack, tracking }: { builder: Builder; query: string; onToggleTrack: (b: Builder) => void; tracking: boolean }) {
  if (builder.kind === 'repo') {
    return <ResourceResultCard builder={builder} query={query} />
  }
  return <PersonResultCard builder={builder} query={query} onToggleTrack={onToggleTrack} tracking={tracking} />
}
```
Call site:
```typescript
              <li key={`${builder.source}-${builder.id}`}>
                <BuilderResultCard
                  builder={builder}
                  query={query}
                  onToggleTrack={handleToggleTrack}
                  tracking={trackingIds.has(builder.id)}
                />
              </li>
```

- [ ] **Step 5: Add the Track button to `PersonResultCard`**

Update the function signature and add the button next to "View" (around line 1056 and 1096-1112):
```typescript
function PersonResultCard({ builder, query, onToggleTrack, tracking }: { builder: Builder; query: string; onToggleTrack: (b: Builder) => void; tracking: boolean }) {
```
In the JSX, right before the existing `<a href={builder.profileUrl} ...>View</a>` element, add:
```typescript
              <button
                type="button"
                onClick={() => onToggleTrack(builder)}
                disabled={tracking}
                className={builder.tracked ? 'btn-primary btn-sm rounded-full' : 'btn-secondary btn-sm rounded-full'}
                title={builder.tracked ? 'Remove from your tracked builders' : 'Track this builder'}
                data-testid={`track-button-${builder.id}`}
              >
                <Bookmark className="w-3 h-3" aria-hidden="true" />
                {builder.tracked ? 'Tracked' : 'Track'}
              </button>
```
(`Bookmark` is already imported at the top of `SearchPage.tsx`.)

- [ ] **Step 6: Run type-check**

Run: `pnpm type-check`
Expected: no errors.

- [ ] **Step 7: Verify manually in the browser**

1. Open `http://localhost:3010/search?q=rust`, sign in as `edd_admin@local.com` / `Passw0rd!234` if not already.
2. Confirm each People result now shows a "Track" button next to "View".
3. Click "Track" on one result — button should immediately switch to "Tracked" (filled style).
4. Reload the page and re-run the same search — confirm that same result still shows "Tracked" (proves Task 6's server-side annotation works, not just optimistic local state).
5. Click "Tracked" to untrack — confirm it reverts to "Track".

- [ ] **Step 8: Commit**

```bash
git add src/modules/search/components/SearchPage.tsx
git commit -m "feat: add track/untrack button to search result cards"
```

---

### Task 10: Rewrite `/exports` around the real tracked-builders list

**Files:**
- Modify: `src/modules/dashboard/components/ExportsPage.tsx` (full rewrite)

**Interfaces:**
- Consumes: `GET /api/me/builders` (Task 5), `DELETE /api/builders/:id` (Task 4), `GET /api/export/builders` (existing, unchanged).

- [ ] **Step 1: Write the new component**

```typescript
// src/modules/dashboard/components/ExportsPage.tsx
import * as React from 'react'
import { Download, Bookmark, Trash2, ExternalLink, Search } from 'lucide-react'
import { LinkComponent, ScoreRing } from '~/components/ui'

interface TrackedBuilder {
  id: string
  username: string
  displayName: string | null
  avatarUrl: string | null
  source: string
  profileUrl: string
  topics: string[]
  score: number | null
  lastSeen: string | null
}

export function ExportsPage() {
  const [builders, setBuilders] = React.useState<TrackedBuilder[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [removingId, setRemovingId] = React.useState<string | null>(null)
  const [downloading, setDownloading] = React.useState(false)
  const [downloadMsg, setDownloadMsg] = React.useState<string | null>(null)

  React.useEffect(() => {
    fetch('/api/me/builders', { credentials: 'include' })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then((data: TrackedBuilder[]) => setBuilders(data))
      .catch(() => setError('Failed to load your tracked builders.'))
  }, [])

  const handleRemove = async (id: string) => {
    setRemovingId(id)
    try {
      const res = await fetch(`/api/builders/${id}`, { method: 'DELETE', credentials: 'include' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setBuilders((prev) => (prev ? prev.filter((b) => b.id !== id) : prev))
    } catch {
      setError('Failed to remove that builder. Please try again.')
    } finally {
      setRemovingId(null)
    }
  }

  const handleDownload = async () => {
    setDownloading(true)
    setDownloadMsg(null)
    try {
      const res = await fetch('/api/export/builders', { credentials: 'include' })
      if (!res.ok) {
        setDownloadMsg('Please sign in to download your builders.')
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'builders.csv'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch {
      setDownloadMsg('Download failed. Please try again.')
    } finally {
      setDownloading(false)
    }
  }

  const loading = builders === null && !error
  const count = builders?.length ?? 0

  return (
    <div className="p-8 max-w-3xl mx-auto">
      <h1 className="text-3xl font-bold text-bh-text mb-1">Exports</h1>
      <p className="text-bh-text-muted mb-2">
        Builders you've tracked from search, in one place — download the list as a CSV whenever you want.
      </p>
      <p className="text-sm text-bh-text-dim mb-8">
        Looking to export <em>all your BuilderHunt account data</em> (profile, saved searches, notes) instead?
        That's a different, GDPR-focused export on{' '}
        <LinkComponent to="/settings/privacy" className="text-bh-accent hover:underline">
          Settings → Privacy
        </LinkComponent>.
      </p>

      {error && (
        <div className="card mb-6 border-red-500/30 bg-red-500/5">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {loading && (
        <div className="space-y-3 animate-pulse">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="card h-16 bg-bh-surface/50" />
          ))}
        </div>
      )}

      {!loading && count === 0 && !error && (
        <div className="card text-center py-12">
          <div className="w-12 h-12 rounded-xl bg-bh-accent/10 flex items-center justify-center mx-auto mb-4">
            <Bookmark className="w-6 h-6 text-bh-accent" />
          </div>
          <p className="font-semibold text-bh-text mb-1">No tracked builders yet</p>
          <p className="text-sm text-bh-text-muted max-w-sm mx-auto mb-4">
            Search for builders and click "Track" on the ones you want to keep — they'll show up here, ready to export.
          </p>
          <LinkComponent to="/search" className="btn-primary btn-sm inline-flex items-center gap-2">
            <Search className="w-4 h-4" /> Track your first builder
          </LinkComponent>
        </div>
      )}

      {!loading && count > 0 && (
        <>
          <p className="text-sm text-bh-text-muted mb-3">
            {count} builder{count === 1 ? '' : 's'} tracked
          </p>
          <ul className="space-y-2 mb-6" role="list">
            {builders!.map((b) => (
              <li key={b.id} className="card p-3 flex items-center gap-3" data-testid={`tracked-builder-${b.id}`}>
                {b.avatarUrl ? (
                  <img src={b.avatarUrl} alt="" loading="lazy" className="w-9 h-9 rounded-full shrink-0 object-cover bg-bh-surface" />
                ) : (
                  <div className="w-9 h-9 rounded-full bg-bh-surface flex items-center justify-center text-sm font-semibold text-bh-text shrink-0">
                    {(b.displayName ?? b.username)[0]?.toUpperCase()}
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm text-bh-text truncate">{b.displayName ?? b.username}</p>
                  <p className="text-xs text-bh-text-muted truncate">
                    @{b.username} · {b.source}
                    {b.topics.length > 0 && ` · ${b.topics.slice(0, 3).join(', ')}`}
                  </p>
                </div>
                {b.score != null && <ScoreRing score={b.score} size={32} showLabel={false} />}
                <a
                  href={b.profileUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-ghost btn-sm shrink-0"
                  title="Open profile"
                >
                  <ExternalLink className="w-4 h-4" />
                </a>
                <button
                  type="button"
                  onClick={() => handleRemove(b.id)}
                  disabled={removingId === b.id}
                  className="btn-ghost btn-sm shrink-0 text-red-400"
                  title="Remove from tracked builders"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="card max-w-lg">
        <div className="flex items-center gap-3 mb-4">
          <div className="p-3 rounded-xl bg-bh-accent/10">
            <Download className="w-6 h-6 text-bh-accent" />
          </div>
          <div>
            <p className="font-medium text-bh-text">Export all builders</p>
            <p className="text-sm text-bh-text-muted">Download as CSV</p>
          </div>
        </div>

        {downloadMsg && <p className="text-sm mb-4 text-red-400">{downloadMsg}</p>}

        <button
          onClick={handleDownload}
          disabled={downloading || count === 0}
          title={count === 0 ? 'Track at least one builder first' : undefined}
          className="btn-primary w-full flex items-center justify-center gap-2"
        >
          <Download className="w-4 h-4" />
          {downloading ? 'Preparing...' : 'Download CSV'}
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Run type-check**

Run: `pnpm type-check`
Expected: no errors. If `ScoreRing`'s prop names differ from `score`/`size`/`showLabel`, fix to match `src/components/ui/score-ring.tsx`'s actual exported signature (already confirmed as `{ score, size, showLabel, breakdown }` earlier — should match as-is).

- [ ] **Step 3: Verify manually in the browser — empty state**

1. Sign in as a fresh account (or delete all tracked builders for `edd_admin` first: `docker exec builderhunt-db psql -U postgres -d builderhunt -c "DELETE FROM builders WHERE user_id = (SELECT id FROM auth_users WHERE email='edd_admin@local.com');"`).
2. Open `http://localhost:3010/exports`.
3. Confirm the empty state renders: icon, "No tracked builders yet", and a working "Track your first builder" button linking to `/search`.
4. Confirm the "Download CSV" button is present but disabled.

- [ ] **Step 4: Verify manually in the browser — populated state**

1. Go to `/search`, run a search, click "Track" on 2-3 results.
2. Navigate to `/exports`.
3. Confirm the count line, list of tracked builders (avatar/initials, name, source, topics, score ring, external-link button, remove button) all render correctly.
4. Click "Remove" on one — confirm it disappears from the list immediately and the count updates.
5. Click "Download CSV" — confirm a `builders.csv` file downloads and its contents (open it) match the remaining tracked builders.
6. Confirm the link to `/settings/privacy` in the explanatory text works and lands on the GDPR export page (a different page — proves the two exports are now clearly distinguished).

- [ ] **Step 5: Commit**

```bash
git add src/modules/dashboard/components/ExportsPage.tsx
git commit -m "feat: redesign /exports around real tracked-builders list"
```

---

### Task 11: Full end-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `pnpm vitest run`
Expected: all tests pass, including the 2 new ones from Task 2.

- [ ] **Step 2: Run type-check and lint**

Run: `pnpm type-check && pnpm lint`
Expected: no errors.

- [ ] **Step 3: Full manual browser walkthrough (mandatory per the ai-os coolify-deploy skill's "always verify in a real browser" rule)**

1. Landing page loads.
2. Sign in with `edd_admin@local.com` / `Passw0rd!234` works.
3. `/search?q=react`, People tab: results show "Track" buttons; tracking one flips it to "Tracked" and persists across a page reload + re-search.
4. `/exports`: shows the tracked builder(s), count is correct, CSV download works and its contents match, removing a builder updates the list.
5. `/settings/privacy`: the unrelated GDPR "Export my data" feature still works exactly as before (unaffected by this change) — request an export, confirm it completes and downloads.
6. `/api/recommendations` (via the dashboard's "For you" section, or curl) still returns `200`, not `500`, confirming Task 7's refactor didn't break it.

- [ ] **Step 4: Clean up any leftover manual-test data**

```bash
docker exec builderhunt-db psql -U postgres -d builderhunt -c \
  "DELETE FROM builders WHERE source_id IN ('999', '888');"
```

- [ ] **Step 5: Final commit (if any cleanup files changed) or confirm working tree is clean**

Run: `git status --short`
Expected: empty (everything already committed per-task).
