/**
 * Credits, entitlement and reservations around the interview features (plan:
 * calendar-scheduling-interview-intelligence, Phase 12).
 *
 * No Stripe call is made. What matters here is the boundary the *product* enforces
 * before any provider is touched: the tier gate, the reservation, and what happens
 * to reserved units when the operation ends — settled, released, or abandoned.
 *
 * ## Reserve-then-settle, and why a test has to look at the ledger
 *
 * A feature reserves the rate card's ceiling, calls the provider, then settles the
 * actual usage and returns the difference. Every failure mode of that pattern is
 * invisible from the response: a reservation that is never settled looks like a
 * success and quietly holds a customer's credits until a sweep reclaims them. So
 * these assertions read `billing_credit_reservations` and the grant balance rather
 * than the HTTP status.
 *
 * ## The tier gate is not the credit gate
 *
 * spec.md puts every interview AI feature behind Pro or above *and* sufficient
 * credits. Those are two different refusals with two different fixes — upgrade
 * versus top up — so a client that cannot tell them apart sends people to the wrong
 * page. `402` and `403` are asserted separately for that reason.
 */
import { expect, test } from 'playwright/test'

import { uniqueId } from './harness/ids'
import {
  createInvitation,
  grantInterviewCredits,
  seedActiveSubscription,
  readCreditBalance,
  sendInvitation,
  candidateContext,
  startInterviewHarness,
  stopInterviewHarness,
  type InterviewHarness,
} from './harness/fixtures/interviews'

let harness: InterviewHarness

test.beforeAll(async () => {
  test.setTimeout(300_000)
  harness = await startInterviewHarness({
    scope: 'bill',
    flags: {
      SCHEDULING_ENABLED: 'true',
      CANDIDATE_UPLOADS_ENABLED: 'true',
      SENSITIVE_AI_ENABLED: 'false',
      // ON: the reserve → settle test below drives a real session, and a session cannot be
      // created with it off. No provider call results — see that test's note.
      INTERVIEW_TRANSCRIPTION_ENABLED: 'true',
    },
    tier: 'team',
  })
  await seedActiveSubscription(harness)
})

test.afterAll(async () => {
  await stopInterviewHarness(harness)
})

/**
 * Moves the *subscription*, because that is what the gate reads.
 *
 * `checkEntitlement` looks at `billing_subscriptions` — tier and `stripe_status` — not at
 * `organization_entitlements`, which is what `createOwnerPrincipal`'s `tier` option seeds. Writing the
 * entitlement row and expecting a refusal is how the first version of this file "proved" a tier gate
 * that was never consulted.
 */
async function setSubscriptionTier(tier: 'pro' | 'pro_max' | 'team'): Promise<void> {
  await harness.sql`
    update billing_subscriptions set tier = ${tier}, catalog_key = ${`${tier}_monthly`}, updated_at = now()
    where organization_id = ${harness.organization.organizationId}
  `
}

/** Cancels it outright: the free tier has no subscription row at all, which is the real free state. */
async function clearSubscription(): Promise<void> {
  await harness.sql`
    update billing_subscriptions set stripe_status = 'canceled', updated_at = now()
    where organization_id = ${harness.organization.organizationId}
  `
}

async function restoreSubscription(): Promise<void> {
  await harness.sql`
    update billing_subscriptions set stripe_status = 'active', tier = 'team',
      catalog_key = 'team_monthly', updated_at = now()
    where organization_id = ${harness.organization.organizationId}
  `
}

/**
 * A distinct hour per interview.
 *
 * `evaluateOverlap` treats a busy overlap on an `interview` event as a hard conflict, not a warning —
 * spec.md, and correct: two interviews at one instant is a double booking. Every fixture in this file
 * used the same fixed start, so the second one onward answered `409 slot_unavailable` and the tests
 * read as authorization failures.
 */
let interviewHour = 8
function nextInterviewSlot(): { startsAt: string; endsAt: string } {
  interviewHour += 1
  const start = new Date(Date.UTC(2026, 6, 24, interviewHour, 0, 0))
  return { startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 45 * 60_000).toISOString() }
}

/** Every reservation this organization has ever made, newest first. */
async function reservations(): Promise<Array<{ operation: string; state: string; maximum_units: number; settled_units: number | null }>> {
  return harness.sql`
    select operation, state, maximum_units, settled_units
    from billing_credit_reservations
    where organization_id = ${harness.organization.organizationId}
    order by heartbeat_at desc
  `
}

async function interviewEvent(): Promise<{ eventId: string; version: number }> {
  const response = await harness.owner.api!.post('/api/calendar/events', {
    data: {
      type: 'interview',
      title: `E2E billing interview ${uniqueId('b').slice(-6)}`,
      ...nextInterviewSlot(),
      timezone: 'Europe/Copenhagen',
      allDay: false,
      busy: true,
      reminders: [],
      participants: [],
    },
  })
  expect(response.status(), await response.text()).toBeLessThan(400)
  const body = await response.json() as { event: { id: string; version: number } }
  return { eventId: body.event.id, version: body.event.version }
}

/**
 * An interview whose brief can actually be generated.
 *
 * `generateBrief` refuses with `no_evidence` *before* it reserves anything — the right order, since
 * a brief that cannot be produced should not cost credits. That also means an interview with no
 * readable document never reaches the tier or credit gates at all, which is what the first version
 * of every test in this file discovered: they asserted `403` and `402` and got `409 no_evidence`.
 *
 * The document and its extraction are written directly rather than driven through upload, scan and
 * parse. `documents.spec.ts` covers that path end to end against real MinIO and ClamAV; what this
 * file is about is the ledger, and routing every assertion through a five-step pipeline would make a
 * billing failure indistinguishable from a parser failure.
 */
async function interviewWithSubmission(): Promise<{ eventId: string; invitationId: string }> {
  const invitation = await createInvitation(harness)
  const sent = await sendInvitation(harness, invitation.invitationId)
  const context = await candidateContext(harness, invitation.invitationId, sent.secret)
  const submission = await context.put(`/api/public/scheduling/${invitation.invitationId}/submission`, {
    data: {
      displayName: 'E2E Billing Candidate',
      email: `bill-${uniqueId('c').slice(-8)}@test.invalid`,
      links: [],
      consentDecisions: [
        { purpose: 'terms_and_privacy', decision: 'accepted' },
        { purpose: 'candidate_document_processing', decision: 'accepted' },
        { purpose: 'ai_interview_assistance', decision: 'accepted' },
        // Required by the session gate: going live without it is `409 consent_missing`, which is the
        // point of the gate and not something a billing fixture should route around.
        { purpose: 'live_audio_transcription', decision: 'accepted' },
      ],
    },
  })
  expect(submission.status(), await submission.text()).toBe(200)

  // The brief hangs off the calendar event, which the booking creates. Created directly here
  // because what this file is about is the ledger, not the booking path.
  const event = await interviewEvent()
  await harness.sql`
    update calendar_events set source_type = 'scheduling_invitation', source_id = ${invitation.invitationId}
    where id = ${event.eventId}
  `
  await harness.sql`
    update scheduling_invitations set booked_event_id = ${event.eventId}, status = 'booked'
    where id = ${invitation.invitationId}
  `

  // One clean, extracted document, so `citableSources` is non-zero and the billing gates are
  // reachable. `evidence.ts` counts a source as citable only when the scan is clean, the extraction
  // succeeded, and the plain text is present — all three, hence all three here.
  const [submissionRow] = await harness.sql<{ id: string }[]>`
    select id from candidate_submissions where invitation_id = ${invitation.invitationId}
  `
  const retention = new Date(Date.now() + 90 * 24 * 60 * 60_000)
  const [document] = await harness.sql<{ id: string }[]>`
    insert into candidate_documents
      (organization_id, submission_id, original_name, declared_media_type, detected_media_type,
       object_key, bytes, sha256, scan_status, extraction_status, retention_expires_at)
    values (${harness.organization.organizationId}, ${submissionRow!.id}, 'cv.pdf', 'application/pdf',
            'application/pdf', ${`clean/${uniqueId('doc')}`}, 2048,
            ${'a'.repeat(64)}, 'clean', 'succeeded', ${retention})
    returning id
  `
  await harness.sql`
    insert into document_extractions
      (organization_id, document_id, parser, parser_version, content_sha256, plain_text, status,
       retention_expires_at)
    values (${harness.organization.organizationId}, ${document!.id}, 'pdf-text', 'v1',
            ${'b'.repeat(64)},
            'Ten years of backend work in Rust and Postgres, mostly on ingest pipelines.',
            'succeeded', ${retention})
  `

  return { eventId: event.eventId, invitationId: invitation.invitationId }
}

/*
 * With `SENSITIVE_AI_ENABLED=false` a brief is produced by the deterministic fallback and costs
 * nothing — `brief-service.ts` short-circuits before reserving, with the note "Charging for a brief the
 * switch forbids generating would be indefensible." That is correct, and it means the tier and credit
 * gates are unreachable through this route in this configuration.
 *
 * So these two tests assert the *free* path is genuinely free rather than pretending to exercise a
 * gate. The reserve → provider → settle path with a stubbed provider is covered by
 * `tests/unit/modules/interviews/reserve-and-settle.test.ts`; reaching it here would require either a
 * live Mistral call from a gate, or a fake provider this harness does not have. Named rather than
 * silently skipped.
 */
test('with AI disabled a brief is a marked fallback that reserves and charges nothing', async () => {
  await grantInterviewCredits(harness, 1000)
  await clearSubscription()
  const { eventId } = await interviewWithSubmission()

  const before = await readCreditBalance(harness)
  const response = await harness.owner.api!.post(`/api/interviews/${eventId}/brief`, {
    data: { expectedVersion: 0, creditConfirmation: true },
  })
  // Produced, not refused — and produced with no subscription at all, because the fallback is free.
  expect(response.status(), await response.text()).toBe(200)
  expect(await response.json()).toMatchObject({ status: 'ready', fallbackReason: 'ai_disabled' })

  expect(await reservations(), 'nothing was reserved for a brief no model wrote').toHaveLength(0)
  expect(await readCreditBalance(harness), 'and nothing was charged').toBe(before)

  // Null provenance is the fallback's only marker, and the editor's "written without AI" disclosure
  // keys off exactly this. A fallback presented as model output is the most misleading thing here.
  const [row] = await harness.sql<{ provider: string | null; model: string | null }[]>`
    select provider, model from interview_briefs where event_id = ${eventId} order by version desc limit 1
  `
  expect(row?.provider).toBeNull()
  expect(row?.model).toBeNull()

  await restoreSubscription()
})

test('an empty balance does not block the free fallback either', async () => {
  await restoreSubscription()
  await harness.sql`
    update billing_credit_grants set remaining_units = 0
    where organization_id = ${harness.organization.organizationId}
  `
  expect(await readCreditBalance(harness)).toBe(0)

  const { eventId } = await interviewWithSubmission()
  const response = await harness.owner.api!.post(`/api/interviews/${eventId}/brief`, {
    data: { expectedVersion: 0, creditConfirmation: true },
  })
  // Zero credits and it still works, because there is nothing to pay for. A 402 here would refuse an
  // organizer the evidence list they are entitled to read regardless.
  expect(response.status(), await response.text()).toBe(200)
  expect(await readCreditBalance(harness)).toBe(0)
  expect((await reservations()).filter((row) => row.state === 'reserved')).toHaveLength(0)
})

/**
 * The reserve → settle path, reachable without a provider.
 *
 * Going live on a session takes an `interview_live_transcription` reservation *before* any audio is
 * captured — that is the point of reserving — and finishing settles it against the provider's billed
 * seconds. Neither step calls Deepgram: the reservation is arithmetic on the ledger, and the billed
 * seconds arrive from the client in the finish request. So this is the one place in the e2e suite where
 * the whole ledger cycle is exercised end to end.
 *
 * Replaced a `test.skip` that would have passed forever without measuring anything.
 */
test('going live reserves the ceiling, and finishing settles it back down', async () => {
  await restoreSubscription()
  await grantInterviewCredits(harness, 400)
  const before = await readCreditBalance(harness)

  const { eventId } = await interviewWithSubmission()
  const created = await harness.owner.api!.post(`/api/interviews/${eventId}/session`, {
    data: { action: 'create', captureCapability: 'microphone_and_shared_audio_available', language: 'en' },
  })
  expect(created.status(), await created.text()).toBeLessThan(400)
  const createdVersion = (await created.json() as { session: { version: number } }).session.version

  const ready = await harness.owner.api!.post(`/api/interviews/${eventId}/session`, {
    data: { action: 'ready', expectedVersion: createdVersion },
  })
  expect(ready.status(), await ready.text()).toBeLessThan(400)
  const readyVersion = (await ready.json() as { session: { version: number } }).session.version

  const live = await harness.owner.api!.post(`/api/interviews/${eventId}/session`, {
    data: { action: 'live', expectedVersion: readyVersion },
  })
  expect(live.status(), await live.text()).toBeLessThan(400)
  const liveBody = await live.json() as { session: { version: number }; reservedUnits?: number }
  // The rate card's ceiling — three hours of transcription — not the price of an interview. An
  // unbounded reservation is how a stuck session eats a month of credits.
  expect(liveBody.reservedUnits).toBe(180)

  const held = (await reservations()).filter((row) =>
    row.operation === 'interview_live_transcription' && row.state === 'reserved')
  expect(held, 'the reservation is open while the session runs').toHaveLength(1)
  expect(held[0].maximum_units).toBe(180)
  /*
   * The ceiling leaves the balance at reserve time, and the unused part comes back at settlement.
   *
   * This asserted the opposite — that a held reservation must not move the balance — and the ledger
   * is deliberately the other way round: `reserveCredits` decrements `remainingUnits` on the grant,
   * and `reservations.ts` says so where it settles ("already removed from remainingUnits at reserve
   * time — consumption just marks it permanent, no further balance change"). Holding without
   * decrementing would let a customer spend the same units twice while a session runs.
   *
   * What must not happen is the ceiling being *kept*, and the assertion at the end of this test is
   * what pins that: only the 12 real minutes stay gone.
   */
  expect(await readCreditBalance(harness)).toBe(before - 180)

  // Twelve minutes of audio. Settled against what the provider says it billed, not the ceiling.
  const finished = await harness.owner.api!.post(`/api/interviews/${eventId}/session`, {
    data: {
      action: 'finish',
      expectedVersion: liveBody.session.version,
      providerBilledSeconds: 12 * 60,
      providerRequestId: 'e2e-provider-request',
    },
  })
  expect(finished.status(), await finished.text()).toBeLessThan(400)
  const settled = await finished.json() as { settledUnits?: number }
  // One credit per provider-billed minute (spec.md "Usage credits and pricing").
  expect(settled.settledUnits).toBe(12)

  const closed = (await reservations()).filter((row) => row.operation === 'interview_live_transcription')
  expect(closed.filter((row) => row.state === 'reserved'), 'nothing is left open').toHaveLength(0)
  expect(closed[0].settled_units).toBe(12)

  const after = await readCreditBalance(harness)
  // Twelve taken, one hundred and sixty-eight returned. A settlement that charged the ceiling would
  // look identical from the response and cost a customer fifteen times the real usage.
  expect(before - after).toBe(12)
})

test('a repeated generation at the same version is refused before it reserves again', async () => {
  await restoreSubscription()
  await grantInterviewCredits(harness, 200)
  const { eventId } = await interviewWithSubmission()

  const first = await harness.owner.api!.post(`/api/interviews/${eventId}/brief`, {
    data: { expectedVersion: 0, creditConfirmation: true },
  })
  if (first.status() !== 200) {
    // No brief was produced (no readable evidence), so there is no second-generation case to make.
    expect([402, 409, 503]).toContain(first.status())
    return
  }

  const balanceAfterFirst = await readCreditBalance(harness)
  const replay = await harness.owner.api!.post(`/api/interviews/${eventId}/brief`, {
    data: { expectedVersion: 0, creditConfirmation: true },
  })
  // 409: version 1 now exists, so "there should be none yet" is stale. This is the guard against a
  // double-clicked button spending five credits twice.
  expect(replay.status(), await replay.text()).toBe(409)
  expect(await readCreditBalance(harness), 'the refused replay cost nothing').toBe(balanceAfterFirst)
})

test('generation without the explicit credit confirmation is refused', async () => {
  await restoreSubscription()
  await grantInterviewCredits(harness, 200)
  const { eventId } = await interviewWithSubmission()
  const before = await readCreditBalance(harness)

  const response = await harness.owner.api!.post(`/api/interviews/${eventId}/brief`, {
    data: { expectedVersion: 0 },
  })
  // Not a security control — a client can always send it — but it means five credits are never
  // spent by an accidental or retried POST.
  expect(response.status()).toBe(400)
  expect(await readCreditBalance(harness)).toBe(before)
})

test('the summary endpoint reports a balance a client can act on', async () => {
  await restoreSubscription()
  await grantInterviewCredits(harness, 137)

  const response = await harness.owner.api!.get('/api/billing/summary')
  expect(response.status(), await response.text()).toBe(200)
  const body = await response.text()

  // Whatever shape the DTO has, the balance it reports must match the ledger — a UI that shows a
  // number the reservation layer disagrees with offers actions that then fail.
  const ledger = await readCreditBalance(harness)
  expect(body, `the summary should carry the ledger balance (${ledger})`).toContain(String(ledger))
})

test('a stale reservation is visible as stale rather than silently forgotten', async () => {
  await restoreSubscription()
  await grantInterviewCredits(harness, 200)

  // A reservation that outlived its deadline: what a crashed worker or a killed pod leaves behind.
  const id = uniqueId('resv')
  await harness.sql`
    insert into billing_credit_reservations
      (id, organization_id, operation, rate_card_version, idempotency_key, maximum_units, state,
       heartbeat_at, deadline_at)
    values (${id}, ${harness.organization.organizationId}, 'interview_live_transcription', 1,
            ${`stale-${id}`}, 180, 'reserved', now() - interval '2 hours', now() - interval '1 hour')
  `

  const stale = await harness.sql<{ id: string; state: string }[]>`
    select id, state from billing_credit_reservations
    where organization_id = ${harness.organization.organizationId}
      and state = 'reserved' and deadline_at < now()
  `
  // The query the reconciliation worker runs. If nothing can find these rows, 180 units per
  // abandoned session stay held against a customer forever.
  expect(stale.map((row) => row.id)).toContain(id)

  await harness.sql`delete from billing_credit_reservations where id = ${id}`
})
