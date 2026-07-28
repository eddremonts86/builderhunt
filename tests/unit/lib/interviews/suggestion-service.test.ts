/**
 * Real disposable Postgres, real billing platform, fake provider.
 *
 * The claims worth testing are about *restraint*: that a proposal leaves no row, that a throttled request
 * does not reach the billing platform, that two clicks produce one provider call, and that every failure
 * comes back looking like the prepared questions rather than an error. All four are invisible in the happy
 * path and every one of them is the difference between a usable panel and a liability.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mockEnv = vi.hoisted(() => ({
  SENSITIVE_AI_ENABLED: 'true' as 'true' | 'false',
  INTERVIEW_TRANSCRIPT_RETENTION_DAYS: 90,
  CREDIT_FIRST_PAYER_CAP_UNITS: 100000,
}))
vi.mock('~/shared/lib/env', () => ({ env: mockEnv }))

const { createDisposableTestDatabase } = await import('~/shared/lib/db/create-disposable-test-database')
const schema = await import('~/shared/lib/db/schema')
const { grantCredits } = await import('~/shared/lib/billing/credits')
const service = await import('~/lib/interviews/suggestion-service')
const { insertBriefVersion } = await import('~/shared/lib/repositories/interviews')
const { AIParseError, AIProviderError } = await import('~/shared/lib/ai/errors')

let db: PostgresJsDatabase
let drop: () => Promise<void>

const ORG = 'sug-org'
const OWNER = 'sug-owner'
const NOW = new Date('2027-10-01T09:00:00.000Z')
const FAR_FUTURE = () => new Date(Date.now() + 365 * 24 * 60 * 60_000)

let sequence = 0
const uniqueId = (prefix: string) => `${prefix}-${(sequence += 1)}`

let eventId = ''
let sessionId = ''
const principal = { organizationId: ORG, userId: OWNER, role: 'owner', requestId: 'r1' } as never

/** Three prepared questions, ordered critical → technical → general by the service. */
const briefContent = {
  candidateSummary: 'Backend engineer with cache work.',
  relevantEvidence: [{ claim: 'Rewrote a cache.', sourceIds: ['doc:1'], confidence: 'high' as const }],
  informationGaps: [],
  contradictions: [],
  questionGroups: [
    { category: 'general' as const, question: 'Walk me through your background.', rationale: 'Opener.', sourceIds: [] },
    { category: 'critical' as const, question: 'Explain the cache rewrite rollout sequence.', rationale: 'Dates disagree.', sourceIds: ['doc:1'] },
    { category: 'technical' as const, question: 'How did you measure tail latency improvements?', rationale: 'Claimed numbers.', sourceIds: ['doc:1'] },
  ],
}

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('suggestion_service')
  db = disposable.db
  drop = disposable.drop

  await db.insert(schema.organizations).values({ id: ORG, name: 'Org', slug: ORG })
  await db.insert(schema.authUsers).values({
    id: OWNER, name: 'Owner', email: 'sug@test.invalid', emailVerified: true, createdAt: NOW, updatedAt: NOW,
  })
  const customerId = uniqueId('cus')
  await db.insert(schema.billingCustomers).values({
    id: customerId, organizationId: ORG, livemode: false,
    stripeCustomerId: `cus_${customerId}`, createdAt: NOW, updatedAt: NOW,
  })
  await db.insert(schema.billingSubscriptions).values({
    id: uniqueId('sub'), organizationId: ORG, customerId, livemode: false,
    catalogKey: 'pro_monthly', tier: 'pro', interval: 'monthly', catalogVersion: 1,
    stripeSubscriptionId: uniqueId('ssub'), stripeStatus: 'active', providerSyncedAt: NOW,
    createdAt: NOW, updatedAt: NOW,
  })

  const [calendar] = await db.insert(schema.userCalendars).values({
    organizationId: ORG, ownerUserId: OWNER, name: 'Cal', timezone: 'UTC', isDefault: true,
  }).returning({ id: schema.userCalendars.id })
  const [event] = await db.insert(schema.calendarEvents).values({
    organizationId: ORG, calendarId: calendar.id, ownerUserId: OWNER, type: 'personal', status: 'scheduled',
    title: 'Interview', startsAt: NOW, endsAt: new Date(NOW.getTime() + 3_600_000),
    timezone: 'UTC', allDay: false, busy: true,
  }).returning({ id: schema.calendarEvents.id })
  eventId = event.id
}, 180_000)

afterAll(async () => { await drop() })

beforeEach(async () => {
  await db.delete(schema.interviewSuggestions)
  await db.delete(schema.transcriptSegments)
  await db.delete(schema.interviewSessions)
  await db.delete(schema.interviewBriefs)
  await db.delete(schema.billingCreditAllocations)
  await db.delete(schema.billingLedgerEntries)
  await db.delete(schema.billingCreditReservations)
  await db.delete(schema.billingCreditGrants)
  await db.transaction((tx) => grantCredits(tx, {
    grantId: uniqueId('grant'), ledgerEntryId: uniqueId('entry'), organizationId: ORG,
    source: 'promotional', units: 500, expiresAt: FAR_FUTURE(), idempotencyKey: uniqueId('idem'),
  }))
  mockEnv.SENSITIVE_AI_ENABLED = 'true'

  const [session] = await db.insert(schema.interviewSessions).values({
    organizationId: ORG, eventId, ownerUserId: OWNER, state: 'live',
    captureMode: 'remote_call', language: 'en', provider: 'deepgram',
    consentNoticeVersion: 'v1', captureCapability: 'microphone_and_shared_audio_available',
    startedAt: NOW, heartbeatAt: NOW, retentionExpiresAt: FAR_FUTURE(),
  }).returning({ id: schema.interviewSessions.id })
  sessionId = session.id
  service.clearSuggestionThrottle(sessionId)
})

async function seedBrief() {
  await db.transaction((tx) => insertBriefVersion(tx as never, {
    organizationId: ORG, eventId, ownerUserId: OWNER,
    content: briefContent, evidenceManifest: [{ id: 'doc:1', kind: 'document', label: 'cv.pdf' }],
    provider: 'mistral', model: 'mistral-medium-2604', promptVersion: '1',
    status: 'active', retentionExpiresAt: FAR_FUTURE(),
  }))
}

async function seedSegments(count = 3, textFor: (n: number) => string = (n) => `Segment ${n} about caching.`) {
  const ids: string[] = []
  for (let n = 1; n <= count; n += 1) {
    const [row] = await db.insert(schema.transcriptSegments).values({
      organizationId: ORG, sessionId, providerSegmentId: `req:0:${n}`, sequence: n,
      speakerEstimate: n % 2 === 0 ? 'speaker_b' : 'speaker_a',
      text: textFor(n), startsMs: n * 1_000, endsMs: n * 1_000 + 900,
      retentionExpiresAt: FAR_FUTURE(),
    }).returning({ id: schema.transcriptSegments.id })
    ids.push(row.id)
  }
  return ids
}

async function session(overrides: Record<string, unknown> = {}) {
  const [row] = await db.select().from(schema.interviewSessions)
  return { ...row, ...overrides } as never
}

/**
 * Validates the way the real boundary does.
 *
 * `src/shared/lib/ai/mistral.ts` uses `safeParse` and throws `AIParseError`. A fake that called `.parse()`
 * would throw a `ZodError` instead, and the service's classification of bad-output-versus-outage would be
 * tested against a shape production never produces.
 */
function validateLikeProvider<T>(schema: { safeParse: (value: unknown) => { success: boolean; data?: T } }, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new AIParseError('sensitive provider returned output that failed validation')
  return result.data as T
}

/** A provider that cites whatever segment ids it was given, which is what a well-behaved one does. */
function goodProvider(calls: { count: number }) {
  return async (input: { prompt: string; schema: { safeParse: (value: unknown) => { success: boolean; data?: unknown } } }) => {
    calls.count += 1
    const segmentId = /\[([0-9a-f-]{36})\]/.exec(input.prompt)?.[1]
    const topicId = /\[(topic:\d+)\]/.exec(input.prompt)?.[1] ?? 'topic:1'
    return {
      output: validateLikeProvider(input.schema as never, {
        questions: [{
          id: 'q1', topicId, question: 'What changed about tail latency after the rewrite?',
          rationale: 'They mentioned the rewrite without the outcome.',
          segmentIds: segmentId ? [segmentId] : [],
        }],
      }),
      provider: 'mistral' as const,
      model: 'mistral-medium-2604',
      usage: { promptTokens: 200, completionTokens: 80 },
      durationMs: 4,
    }
  }
}

const run = (overrides: Record<string, unknown> = {}) => db.transaction(async (tx) => service.suggestFollowups(
  tx as never,
  principal,
  { session: await session(), now: NOW, complete: goodProvider({ count: 0 }) as never, ...overrides },
))

describe('a proposal writes nothing', () => {
  it('returns suggestions and leaves the table empty', async () => {
    await seedBrief()
    await seedSegments()
    const outcome = await run()
    expect(outcome.kind).toBe('suggested')
    // spec.md: ephemeral unless explicitly saved or used. A table of every rejected question about a named
    // candidate is a record of impressions nobody agreed to keep.
    expect(await db.select().from(schema.interviewSuggestions)).toHaveLength(0)
  })

  it('records a row only when the organizer acts', async () => {
    await seedBrief()
    const [segmentId] = await seedSegments()
    const outcome = await run()
    const suggestion = outcome.suggestions[0]

    await db.transaction(async (tx) => service.recordSuggestionAction(tx as never, principal, {
      session: await session(), suggestion, action: 'used', retentionExpiresAt: FAR_FUTURE(),
    }))
    const rows = await db.select().from(schema.interviewSuggestions)
    expect(rows).toHaveLength(1)
    expect(rows[0].state).toBe('used')
    expect(rows[0].evidenceSegmentIds).toEqual([segmentId])
    expect(rows[0].promptVersion).toBe('1')
  })

  it('records a dismissal, because a rejected question should not come back', async () => {
    await seedBrief()
    await seedSegments()
    const outcome = await run()
    await db.transaction(async (tx) => service.recordSuggestionAction(tx as never, principal, {
      session: await session(), suggestion: outcome.suggestions[0], action: 'dismissed', retentionExpiresAt: FAR_FUTURE(),
    }))
    const rows = await db.select().from(schema.interviewSuggestions)
    expect(rows[0].state).toBe('dismissed')
  })

  it('numbers recorded suggestions without colliding', async () => {
    await seedBrief()
    await seedSegments()
    const outcome = await run()
    for (const action of ['used', 'saved', 'dismissed'] as const) {
      await db.transaction(async (tx) => service.recordSuggestionAction(tx as never, principal, {
        session: await session(), suggestion: outcome.suggestions[0], action, retentionExpiresAt: FAR_FUTURE(),
      }))
    }
    const rows = await db.select().from(schema.interviewSuggestions)
    // The sequence comes from the current maximum inside the INSERT, so three clicks in one second do not
    // collide on the unique index.
    expect(rows.map((row) => row.sequence).sort()).toEqual([0, 1, 2])
  })

  it('moves a recorded suggestion between states', async () => {
    await seedBrief()
    await seedSegments()
    const outcome = await run()
    const saved = await db.transaction(async (tx) => service.recordSuggestionAction(tx as never, principal, {
      session: await session(), suggestion: outcome.suggestions[0], action: 'saved', retentionExpiresAt: FAR_FUTURE(),
    }))
    const changed = await db.transaction(async (tx) => service.changeSuggestionState(tx as never, principal, {
      session: await session(), suggestionId: saved.id, action: 'used',
    }))
    expect(changed?.state).toBe('used')
  })

  it('answers null for a suggestion that was never recorded', async () => {
    // The organizer dismissing an ephemeral proposal is the normal case, not an error.
    const changed = await db.transaction(async (tx) => service.changeSuggestionState(tx as never, principal, {
      session: await session(), suggestionId: '00000000-0000-4000-8000-000000000000', action: 'dismissed',
    }))
    expect(changed).toBeNull()
  })
})

describe('every failure looks like the prepared questions', () => {
  const expectPrepared = (outcome: Awaited<ReturnType<typeof run>>, reason: string) => {
    expect(outcome.kind).toBe('prepared')
    expect(outcome.kind === 'prepared' && outcome.reason).toBe(reason)
    // The same shape as a success, so a fallback does not tell the candidate something went wrong. And no
    // citations: a prepared question responds to nothing that was said.
    expect(outcome.suggestions.length).toBeGreaterThan(0)
    for (const suggestion of outcome.suggestions) expect(suggestion.segmentIds).toEqual([])
  }

  it('falls back with critical questions first', async () => {
    await seedBrief()
    await seedSegments()
    mockEnv.SENSITIVE_AI_ENABLED = 'false'
    const outcome = await run()
    expectPrepared(outcome, 'ai_disabled')
    // Ordered critical → technical → general, because the panel shows three and those are the three worth
    // asking.
    expect(outcome.suggestions[0].question).toMatch(/rollout sequence/)
  })

  it('never returns more than three', async () => {
    await seedBrief()
    await seedSegments()
    mockEnv.SENSITIVE_AI_ENABLED = 'false'
    const outcome = await run()
    expect(outcome.suggestions.length).toBeLessThanOrEqual(3)
  })

  it('degrades on a paused session', async () => {
    await seedBrief()
    await seedSegments()
    await db.update(schema.interviewSessions).set({ state: 'paused' })
    const outcome = await run({ session: await session({ state: 'paused' }) })
    // A suggestion about what was just said is meaningless when nothing is being said, and a pause has
    // told the candidate that capture stopped.
    expectPrepared(outcome, 'not_live')
  })

  it('degrades on a finished session', async () => {
    await seedBrief()
    await seedSegments()
    const outcome = await run({ session: await session({ state: 'processing' }) })
    expectPrepared(outcome, 'not_live')
  })

  it('degrades when the provider is down', async () => {
    await seedBrief()
    await seedSegments()
    const outcome = await run({
      complete: async () => { throw new AIProviderError(503, 'unavailable') },
    })
    expectPrepared(outcome, 'provider_failed')
  })

  it('distinguishes an unparseable output from an outage', async () => {
    await seedBrief()
    await seedSegments()
    const outcome = await run({ complete: async () => { throw new AIParseError('not json') } })
    // Only a log cares about the difference, but collapsing them would make a systematically broken
    // provider look like a flaky network.
    expectPrepared(outcome, 'invalid_output')
  })

  it('degrades when a completion cites a segment it was never sent', async () => {
    await seedBrief()
    await seedSegments()
    const outcome = await run({
      complete: async (input: { schema: { safeParse: (value: unknown) => { success: boolean; data?: unknown } } }) => ({
        output: validateLikeProvider(input.schema as never, {
          questions: [{
            id: 'q1', topicId: 'topic:1', question: 'What about the rollout?',
            rationale: 'Cited.', segmentIds: ['00000000-0000-4000-8000-000000000000'],
          }],
        }),
        provider: 'mistral', model: 'm', usage: { promptTokens: 1, completionTokens: 1 }, durationMs: 1,
      }),
    })
    // The organizer would click the citation and land on nothing.
    expectPrepared(outcome, 'invalid_output')
  })

  it('degrades when a completion smuggles a hire recommendation', async () => {
    await seedBrief()
    const [segmentId] = await seedSegments()
    const outcome = await run({
      complete: async (input: { schema: { safeParse: (value: unknown) => { success: boolean; data?: unknown } } }) => ({
        output: validateLikeProvider(input.schema as never, {
          questions: [{
            id: 'q1', topicId: 'topic:1', question: 'Ask what decides whether to hire them.',
            rationale: 'Scoring.', segmentIds: [segmentId],
          }],
        }),
        provider: 'mistral', model: 'm', usage: { promptTokens: 1, completionTokens: 1 }, durationMs: 1,
      }),
    })
    expectPrepared(outcome, 'invalid_output')
  })
})

describe('the throttle', () => {
  it('refuses a second request inside thirty seconds', async () => {
    await seedBrief()
    await seedSegments()
    const calls = { count: 0 }
    await run({ complete: goodProvider(calls) as never })
    expect(calls.count).toBe(1)

    const second = await db.transaction(async (tx) => service.suggestFollowups(tx as never, principal, {
      session: await session(),
      now: new Date(NOW.getTime() + 20_000),
      complete: goodProvider(calls) as never,
    }))
    expect(second.kind).toBe('prepared')
    expect(second.kind === 'prepared' && second.reason).toBe('throttled')
    expect(calls.count).toBe(1)
  })

  it('allows a request after thirty seconds when there is new speech', async () => {
    await seedBrief()
    await seedSegments()
    const calls = { count: 0 }
    await run({ complete: goodProvider(calls) as never })

    // New speech, which is the other half of the condition.
    await db.insert(schema.transcriptSegments).values({
      organizationId: ORG, sessionId, providerSegmentId: 'req:0:99', sequence: 99,
      speakerEstimate: 'speaker_b', text: 'And the rollout took two weeks.',
      startsMs: 99_000, endsMs: 99_900, retentionExpiresAt: FAR_FUTURE(),
    })

    const second = await db.transaction(async (tx) => service.suggestFollowups(tx as never, principal, {
      session: await session(),
      now: new Date(NOW.getTime() + 31_000),
      complete: goodProvider(calls) as never,
    }))
    expect(second.kind).toBe('suggested')
    expect(calls.count).toBe(2)
  })

  it('refuses when the window has not changed, however long it has been', async () => {
    await seedBrief()
    await seedSegments()
    const calls = { count: 0 }
    await run({ complete: goodProvider(calls) as never })

    const second = await db.transaction(async (tx) => service.suggestFollowups(tx as never, principal, {
      session: await session(),
      now: new Date(NOW.getTime() + 600_000),
      complete: goodProvider(calls) as never,
    }))
    // The same window produces the same suggestions, so this would be a paid restatement.
    expect(second.kind === 'prepared' && second.reason).toBe('no_new_speech')
    expect(calls.count).toBe(1)
  })

  it('collapses a slow request and a later one into a single provider call', async () => {
    // The scenario the in-flight flag uniquely protects, and the *only* one: a completion that takes longer
    // than the thirty-second floor while the interview keeps producing speech. Both the elapsed-time check
    // and the new-speech check pass, so without the flag the second request pays for a completion the
    // organizer never sees — the first one's answer arrives and replaces it.
    //
    // A test using the same instant would pass with the flag removed, because the elapsed-time check
    // answers `throttled` on its own. Verified by removing the flag: this test fails, that one did not.
    await seedBrief()
    await seedSegments()
    const calls = { count: 0 }
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })

    const slow = async (input: { prompt: string; schema: { safeParse: (value: unknown) => { success: boolean; data?: unknown } } }) => {
      calls.count += 1
      await gate
      return goodProvider({ count: 0 })(input)
    }

    const first = db.transaction(async (tx) => service.suggestFollowups(tx as never, principal, {
      session: await session(), now: NOW, complete: slow as never,
    }))
    await vi.waitFor(() => expect(calls.count).toBe(1))

    // New speech, so the no-new-speech check cannot be what refuses the second request.
    await db.insert(schema.transcriptSegments).values({
      organizationId: ORG, sessionId, providerSegmentId: 'req:0:77', sequence: 77,
      speakerEstimate: 'speaker_b', text: 'And then we shipped it on a Friday.',
      startsMs: 77_000, endsMs: 77_900, retentionExpiresAt: FAR_FUTURE(),
    })

    const second = await db.transaction(async (tx) => service.suggestFollowups(tx as never, principal, {
      session: await session(),
      // Past the floor, so the elapsed-time check cannot be what refuses it either.
      now: new Date(NOW.getTime() + 45_000),
      complete: slow as never,
    }))
    release()
    await first

    expect(second.kind === 'prepared' && second.reason).toBe('throttled')
    expect(calls.count).toBe(1)
  })

  it('does not lock the session out after a provider failure', async () => {
    await seedBrief()
    await seedSegments()
    await run({ complete: async () => { throw new AIProviderError(500, 'boom') } })
    // The in-flight flag is cleared in a finally, so one outage does not make the session unable to ask
    // again. The timestamp stays, which keeps the thirty-second floor in force.
    expect(service.suggestionThrottleState(sessionId)?.inFlight).toBe(false)
  })
})

describe('the gate order', () => {
  it('does not consult the provider for a session with no speech', async () => {
    await seedBrief()
    const calls = { count: 0 }
    const outcome = await run({ complete: goodProvider(calls) as never })
    expect(outcome.kind === 'prepared' && outcome.reason).toBe('no_new_speech')
    expect(calls.count).toBe(0)
  })

  it('degrades rather than prompting with no topics when there is no brief', async () => {
    await seedSegments()
    const calls = { count: 0 }
    const outcome = await run({ complete: goodProvider(calls) as never })
    // The output schema requires a known topic id, so an empty topic list would guarantee a validation
    // failure. Degrading is the honest shape.
    expect(outcome.kind === 'prepared' && outcome.reason).toBe('no_brief')
    expect(outcome.suggestions).toEqual([])
    expect(calls.count).toBe(0)
  })

  it('checks the switch before the billing platform', async () => {
    await seedBrief()
    await seedSegments()
    mockEnv.SENSITIVE_AI_ENABLED = 'false'
    const outcome = await run()
    // Charging for entitlement checks on a feature the switch forbids would be indefensible, and an
    // operator reading a tier error would go and fix a tier that was never the problem.
    expect(outcome.kind === 'prepared' && outcome.reason).toBe('ai_disabled')
  })

  it('refuses a tier that does not include the feature', async () => {
    await seedBrief()
    await seedSegments()
    await db.delete(schema.billingSubscriptions)
    const outcome = await run()
    expect(outcome.kind === 'prepared' && outcome.reason).toBe('not_entitled')
    // Restored for the remaining tests in this file.
    const [customer] = await db.select().from(schema.billingCustomers)
    await db.insert(schema.billingSubscriptions).values({
      id: uniqueId('sub'), organizationId: ORG, customerId: customer.id, livemode: false,
      catalogKey: 'pro_monthly', tier: 'pro', interval: 'monthly', catalogVersion: 1,
      stripeSubscriptionId: uniqueId('ssub'), stripeStatus: 'active', providerSyncedAt: NOW,
      createdAt: NOW, updatedAt: NOW,
    })
  })
})

describe('topic coverage', () => {
  it('marks a topic covered when its content words were spoken', () => {
    const topics = [{ id: 't1', question: 'Explain the cache rewrite rollout sequence.', rationale: 'x' }]
    const covered = service.deriveTopicCoverage({
      topics,
      segments: [{ text: 'The cache rewrite rollout sequence took two weeks.' }],
    })
    expect(covered[0].covered).toBe(true)
  })

  it('does not mark a topic covered from stop words alone', () => {
    // "Tell me about your work" against "tell me" would match on filler and silently deprioritise a
    // question nobody asked.
    const topics = [{ id: 't1', question: 'Tell me about your work with Kubernetes.', rationale: 'x' }]
    const covered = service.deriveTopicCoverage({
      topics, segments: [{ text: 'Tell me, what would you like to know about me?' }],
    })
    expect(covered[0].covered).toBe(false)
  })

  it('is case-insensitive', () => {
    const topics = [{ id: 't1', question: 'Describe the Postgres partitioning strategy.', rationale: 'x' }]
    expect(service.deriveTopicCoverage({
      topics, segments: [{ text: 'we DESCRIBED our POSTGRES PARTITIONING STRATEGY at length' }],
    })[0].covered).toBe(true)
  })

  it('treats an empty transcript as covering nothing', () => {
    const topics = [{ id: 't1', question: 'Explain the cache rewrite.', rationale: 'x' }]
    expect(service.deriveTopicCoverage({ topics, segments: [] })[0].covered).toBe(false)
  })
})

describe('what the model is told about who is speaking', () => {
  it('labels remote channels by role, because the mixer made them facts', async () => {
    await seedBrief()
    await seedSegments(2)
    let prompt = ''
    await run({
      complete: async (input: { prompt: string; schema: { safeParse: (value: unknown) => { success: boolean; data?: unknown } } }) => {
        prompt = input.prompt
        return goodProvider({ count: 0 })(input)
      },
    })
    expect(prompt).toMatch(/Interviewer:/)
    expect(prompt).toMatch(/Candidate:/)
    // Never the raw estimate: `speaker_a` means nothing to a model.
    expect(prompt).not.toMatch(/speaker_a/)
  })

  it('labels in-person voices as speakers rather than guessing a role', async () => {
    await seedBrief()
    await seedSegments(2)
    await db.update(schema.interviewSessions).set({ captureMode: 'in_person' })
    let prompt = ''
    await run({
      session: await session({ captureMode: 'in_person' }),
      complete: async (input: { prompt: string; schema: { safeParse: (value: unknown) => { success: boolean; data?: unknown } } }) => {
        prompt = input.prompt
        return goodProvider({ count: 0 })(input)
      },
    })
    // Telling the model the candidate said something the interviewer said would produce a follow-up aimed
    // at nobody.
    expect(prompt).toMatch(/Speaker A:/)
    expect(prompt).not.toMatch(/Interviewer:/)
  })

  it('prefers a confirmed mapping over the estimate', async () => {
    await seedBrief()
    await seedSegments(1)
    await db.update(schema.transcriptSegments).set({ speakerMapping: 'candidate_or_remote' })
    let prompt = ''
    await run({
      complete: async (input: { prompt: string; schema: { safeParse: (value: unknown) => { success: boolean; data?: unknown } } }) => {
        prompt = input.prompt
        return goodProvider({ count: 0 })(input)
      },
    })
    // A human's correction is better information than the guess it replaced.
    expect(prompt).toMatch(/Candidate:/)
  })
})
