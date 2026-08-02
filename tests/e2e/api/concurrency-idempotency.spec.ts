/**
 * Parallel writes, idempotency keys and claim races (plan 53, task 6).
 *
 * Every other spec in this directory sends one request at a time, which is the one thing production never
 * does. The failures here only exist under concurrency, and they are invisible to sequential tests:
 *
 * - **Check-then-insert.** A handler that reads "does this exist?" and then inserts is correct in every
 *   sequential test and wrong under load — two requests both read "no" before either writes. The fix is a
 *   unique constraint or an advisory lock, and the only way to tell whether one is present is to race it.
 * - **Idempotency keys under retry storms.** A key protects a *replay*, which is sequential. Two deliveries
 *   arriving at once is a different problem, and it is the common one: a double-click, a retrying proxy, two
 *   tabs.
 * - **Repeatability.** A race that produces the right answer once may produce it by luck. Each race below runs
 *   several attempts in parallel rather than two, because two requests frequently serialise by accident.
 *
 * The assertions are all row counts. A concurrency bug's signature is a duplicate, and a duplicate is a
 * database fact — no status code shows it, and both responses usually look fine.
 */
import { expect, test } from 'playwright/test'

import {
  seedActiveSubscription,
  startInterviewHarness,
  stopInterviewHarness,
  type InterviewHarness,
} from '../harness/fixtures/interviews'
import { uniqueId } from '../harness/ids'

let harness: InterviewHarness

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.setTimeout(300_000)
  harness = await startInterviewHarness({ scope: 'race' })
  await seedActiveSubscription(harness, { tier: 'team' })
  await harness.sql`
    insert into billing_seller_profiles (
      version, legal_name, public_business_address, establishment_country,
      support_email, statement_descriptor, country_allowlist, effective_at, created_by_user_id
    ) values (
      1, 'E2E Seller ApS', 'Testvej 1, 2100 København', 'DK',
      'billing@e2e.invalid', 'E2E BUILDERHUNT', '["DK"]'::jsonb, now(), ${harness.owner.userId!}
    )
    on conflict do nothing
  `
})

test.afterAll(async () => {
  await stopInterviewHarness(harness)
})

/**
 * Six, not two.
 *
 * Two concurrent requests often serialise by accident — the second arrives after the first has committed and
 * the race never happens, so the test passes against code that has no protection at all. Six overlapping
 * attempts make the window much harder to miss.
 */
const ATTEMPTS = 6

/** Fires N identical requests with no await between them, so they are genuinely in flight together. */
function race<T>(make: (index: number) => Promise<T>): Promise<T[]> {
  return Promise.all(Array.from({ length: ATTEMPTS }, (_, index) => make(index)))
}

test('the same checkout idempotency key, fired six times at once, creates one attempt', async () => {
  /**
   * The double-click, and the retrying proxy. An idempotency key that only deduplicates sequentially — a read
   * followed by an insert — lets every one of these through, and the customer is charged six times.
   */
  const idempotencyKey = uniqueId('race-checkout')
  const results = await race(() =>
    harness.owner.api!.post('/api/billing/checkout/credits', {
      data: {
        catalogKey: 'starter_300',
        country: 'DK',
        disclosures: {
          renewal: true,
          amount: true,
          interval: true,
          cancellationRefundPolicy: true,
          creditExpiryNonTransferability: true,
          tax: true,
          total: true,
        },
        successUrl: `${harness.baseURL}/settings/billing/return`,
        cancelUrl: `${harness.baseURL}/settings/billing`,
        idempotencyKey,
      },
    }),
  )

  // At least one must have succeeded, or the assertion below would pass vacuously against a broken route.
  const succeeded = results.filter((response) => response.status() < 400)
  expect(succeeded.length, 'no request succeeded, so the count below proves nothing').toBeGreaterThan(0)

  const rows = await harness.sql<{ count: string }[]>`
    select count(*)::text as count from billing_checkout_attempts
    where organization_id = ${harness.organization.organizationId}
      and idempotency_key = ${idempotencyKey}
  `
  expect(rows[0]?.count, 'concurrent requests with one key created multiple checkout attempts').toBe('1')
})

test('tracking the same builder six times at once tracks it once', async () => {
  /**
   * A real double-click path: the Track button. This one is worth racing specifically because the write goes
   * through two tables — `builder_identities` (global) and `organization_builders` (tenant) — and a race that
   * produced two identities would produce two tracked builders that look like different people.
   */
  const sourceId = uniqueId('race-builder').toLowerCase()
  const payload = {
    source: 'github',
    sourceId,
    username: sourceId,
    displayName: 'Race Builder',
    profileUrl: `https://github.com/${sourceId}`,
    followersCount: 10,
    topics: [],
  }

  const results = await race(() => harness.owner.api!.post('/api/builders/track', { data: payload }))
  const succeeded = results.filter((response) => response.status() < 400)
  expect(succeeded.length, 'no track succeeded').toBeGreaterThan(0)

  const identities = await harness.sql<{ count: string }[]>`
    select count(*)::text as count from builder_identities
    where source = 'github' and source_id = ${sourceId}
  `
  expect(identities[0]?.count, 'a race created two identities for one person').toBe('1')

  const tracked = await harness.sql<{ count: string }[]>`
    select count(*)::text as count from organization_builders ob
    join builder_identities bi on bi.id = ob.builder_identity_id
    where ob.organization_id = ${harness.organization.organizationId} and bi.source_id = ${sourceId}
  `
  expect(tracked[0]?.count, 'a race tracked the same builder twice').toBe('1')
})

test.fixme('inviting the same address six times at once leaves one pending invitation', async () => {
  /**
   * **This race is real and currently loses. Measured 2026-08-02: six concurrent invitations to one address
   * produced four pending rows.**
   *
   * `POST /api/organizations/invitations` reads whether a pending invitation exists and then inserts. That is
   * correct in every sequential test — including the one in `organizations-invitations.spec.ts`, which passes
   * — and wrong the moment two requests overlap: they both read "none" before either commits. Nothing in the
   * schema stops it; there is no unique index on (organization, email, pending).
   *
   * The consequence is not cosmetic. **A pending invitation holds a seat**, so four duplicates consume four
   * seats the organization did not buy, and can push it into `member limit` errors for invitations it never
   * knowingly sent. The invitee receives four links, and resend rotates the id, so at most one of them will
   * still work by the time they click.
   *
   * How you get here without trying: a double-click on Invite, a form resubmitted on a flaky connection, or
   * two admins inviting the same new hire in the same minute.
   *
   * Not fixed here — plan 53's rule for these matrices is that a production edit belongs in its own task, and
   * this one has a schema decision in it (a partial unique index on pending invitations versus an advisory
   * lock in the lifecycle service). Carried as a task in
   * `plans/phase-1/53-exhaustive-local-e2e-design/tasks.md`.
   */
  const email = `${uniqueId('race-invite').toLowerCase()}@e2e.invalid`
  const results = await race(() =>
    harness.owner.api!.post('/api/organizations/invitations', { data: { email, role: 'member' } }),
  )
  const succeeded = results.filter((response) => response.status() < 400)
  expect(succeeded.length, 'no invitation succeeded').toBeGreaterThan(0)

  const rows = await harness.sql<{ count: string }[]>`
    select count(*)::text as count from organization_invitations
    where organization_id = ${harness.organization.organizationId}
      and email = ${email}
      and status = 'pending'
  `
  expect(rows[0]?.count, 'a race created duplicate pending invitations').toBe('1')
})

test('creating six lists at once creates six distinct lists', async () => {
  /**
   * The control. Every other test here asserts that concurrency collapses to one; this one asserts it does
   * *not* where it should not. Without it, a handler that silently dropped concurrent writes — over-eager
   * locking, a mistaken unique constraint — would satisfy every assertion above and lose real user data.
   */
  const label = uniqueId('race-list')
  const results = await race((index) =>
    harness.owner.api!.post('/api/lists', {
      data: { name: `${label}-${index}`, description: null, visibility: 'organization' },
    }),
  )

  const created = results.filter((response) => response.status() === 201)
  expect(created.length, 'concurrent distinct writes were dropped').toBe(ATTEMPTS)

  const rows = await harness.sql<{ count: string }[]>`
    select count(*)::text as count from builder_lists
    where organization_id = ${harness.organization.organizationId} and name like ${`${label}-%`}
  `
  expect(rows[0]?.count).toBe(String(ATTEMPTS))
})

test('the same race run twice gives the same answer', async () => {
  /**
   * Repeatability, which is the part a single race cannot establish. A race that passed once may have passed
   * because the requests happened to serialise; running it again with fresh inputs makes that luck repeat.
   *
   * It races builder tracking rather than invitations on purpose. Invitations lose this race today (see the
   * `fixme` above), so using them here would have measured the known defect twice instead of measuring
   * repeatability at all — the first version of this test did exactly that and reported `4` as a repeatability
   * failure, which it was not.
   */
  for (const attempt of [1, 2]) {
    const sourceId = uniqueId(`race-repeat-${attempt}`).toLowerCase()
    await race(() =>
      harness.owner.api!.post('/api/builders/track', {
        data: {
          source: 'github',
          sourceId,
          username: sourceId,
          displayName: 'Repeat Builder',
          profileUrl: `https://github.com/${sourceId}`,
          followersCount: 1,
          topics: [],
        },
      }),
    )
    const rows = await harness.sql<{ count: string }[]>`
      select count(*)::text as count from builder_identities
      where source = 'github' and source_id = ${sourceId}
    `
    expect(rows[0]?.count, `run ${attempt} produced a different outcome`).toBe('1')
  }
})
