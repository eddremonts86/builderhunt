/**
 * @vitest-environment node
 *
 * The assertions that matter: the master key never reaches a browser, the endpoint is the EU one and not
 * a configurable default, and the two capture modes produce configurations that are *not* interchangeable.
 *
 * A remote session configured for diarization would throw away channel attribution we already have and
 * replace it with a guess; an in-person session configured for multichannel would claim two sources where
 * one microphone carries two voices. Both look fine in a screenshot and produce a transcript that
 * misattributes who said what in a hiring decision.
 */
import { describe, expect, it, vi } from 'vitest'

const mockEnv = vi.hoisted(() => ({ DEEPGRAM_API_KEY: 'master-key-do-not-leak' }))
vi.mock('~/shared/lib/env', () => ({ env: mockEnv }))

const {
  DEEPGRAM_EU_LISTEN_URL,
  DEEPGRAM_MODEL,
  DEEPGRAM_TOKEN_TTL_SECONDS,
  DeepgramError,
  assertNoMasterKey,
  buildSessionConfig,
  createSessionToken,
  normalizeBilledSeconds,
  parseFinalSegment,
} = await import('~/lib/interviews/transcription/deepgram')

function grantResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('the token is short-lived, EU-scoped, and never the master key', () => {
  it('mints a scoped grant against the EU endpoint', async () => {
    const calls: string[] = []
    const token = await createSessionToken({
      fetchImpl: (async (url: string) => {
        calls.push(url)
        return grantResponse({ access_token: 'scoped-grant', expires_in: 30 })
      }) as never,
    })

    expect(calls[0]).toBe('https://api.eu.deepgram.com/v1/auth/grant')
    expect(token.accessToken).toBe('scoped-grant')
    expect(token.expiresInSeconds).toBe(DEEPGRAM_TOKEN_TTL_SECONDS)
    expect(token.url).toBe('wss://api.eu.deepgram.com/v1/listen')
  })

  it('sends the master key exactly once, server-to-server, and returns it never', async () => {
    let sentAuthorization = ''
    const token = await createSessionToken({
      fetchImpl: (async (_url: string, init: RequestInit) => {
        sentAuthorization = String((init.headers as Record<string, string>).Authorization)
        return grantResponse({ access_token: 'scoped-grant' })
      }) as never,
    })

    expect(sentAuthorization).toContain('master-key-do-not-leak')
    // A key that can create projects, read every past request and spend money must not reach a browser,
    // where it also reaches every extension and crash report on that machine.
    expect(JSON.stringify(token)).not.toContain('master-key-do-not-leak')
  })

  it('refuses a grant that echoes the master key back', async () => {
    await expect(createSessionToken({
      fetchImpl: (async () => grantResponse({ access_token: 'prefix-master-key-do-not-leak' })) as never,
    })).rejects.toMatchObject({ name: 'DeepgramError', code: 'invalid_response' })
  })

  it('clamps a TTL longer than 30 seconds instead of trusting it', async () => {
    const token = await createSessionToken({
      fetchImpl: (async () => grantResponse({ access_token: 't', expires_in: 3600 })) as never,
    })
    expect(token.expiresInSeconds).toBe(30)
  })

  it.each([
    ['a non-2xx status', async () => grantResponse({}, 503), 'provider_unavailable'],
    ['a non-JSON body', async () => new Response('not json', { status: 200 }), 'invalid_response'],
    ['a grant with no token', async () => grantResponse({ expires_in: 30 }), 'invalid_response'],
    ['an empty token', async () => grantResponse({ access_token: '' }), 'invalid_response'],
  ])('rejects %s', async (_label, fetchImpl, code) => {
    await expect(createSessionToken({ fetchImpl: fetchImpl as never })).rejects.toMatchObject({ code })
  })

  it('reports a network failure without leaking the request', async () => {
    // try/catch, not `.catch(fn)`: the latter types its result as the union of the resolved value and the
    // handler's return, so `.message` does not exist on it.
    let caught: Error | null = null
    try {
      await createSessionToken({
        fetchImpl: (async () => { throw new TypeError('fetch failed for https://x/?key=master-key-do-not-leak') }) as never,
      })
    } catch (error) {
      caught = error as Error
    }

    expect((caught as { code?: string } | null)?.code).toBe('provider_unavailable')
    expect(caught?.message).not.toContain('master-key-do-not-leak')
  })

  it('refuses to mint anything without a configured key', async () => {
    mockEnv.DEEPGRAM_API_KEY = ''
    await expect(createSessionToken({ fetchImpl: (async () => grantResponse({})) as never }))
      .rejects.toMatchObject({ code: 'not_configured' })
    mockEnv.DEEPGRAM_API_KEY = 'master-key-do-not-leak'
  })

  it('exposes the master-key guard as a guarantee, not an internal habit', () => {
    expect(() => assertNoMasterKey('contains master-key-do-not-leak here', 'master-key-do-not-leak')).toThrow(DeepgramError)
    expect(() => assertNoMasterKey('clean-grant', 'master-key-do-not-leak')).not.toThrow()
    // An unconfigured key must not make every token look like a leak.
    expect(() => assertNoMasterKey('anything', '')).not.toThrow()
  })
})

describe('the two capture modes are not interchangeable', () => {
  it('gives a remote call two interleaved channels and no diarization', () => {
    const config = buildSessionConfig({ captureMode: 'remote_call', language: 'en' })

    expect(config.url).toBe(DEEPGRAM_EU_LISTEN_URL)
    expect(config.parameters.channels).toBe('2')
    expect(config.parameters.multichannel).toBe('true')
    // Attribution is already deterministic from the channel the mixer assigned; diarization would replace
    // that fact with a guess.
    expect(config.parameters.diarize).toBeUndefined()
    expect(config.diarize).toBe(false)
    expect(config.channelLabels).toEqual({ 0: 'organizer', 1: 'candidate_or_remote' })
  })

  it('gives an in-person session one channel and diarization', () => {
    const config = buildSessionConfig({ captureMode: 'in_person', language: 'da' })

    expect(config.parameters.channels).toBe('1')
    expect(config.parameters.multichannel).toBeUndefined()
    // One microphone, two voices: channel attribution is impossible, so diarization is the only option —
    // and it guesses, which is why `speaker_mapping` exists for a human to correct.
    expect(config.parameters.diarize).toBe('true')
    expect(config.diarize).toBe(true)
    expect(config.channelLabels).toEqual({})
  })

  it('pins the model and the audio format rather than defaulting them', () => {
    const config = buildSessionConfig({ captureMode: 'remote_call', language: 'en' })
    expect(config.parameters.model).toBe(DEEPGRAM_MODEL)
    expect(DEEPGRAM_MODEL).not.toMatch(/latest|general$/)
    // Stated, not sniffed: a format mismatch transcribes noise, and noise is indistinguishable from a
    // candidate who mumbles.
    expect(config.parameters.encoding).toBe('linear16')
    expect(config.parameters.sample_rate).toBe('16000')
  })

  it('asks for final results only', () => {
    for (const captureMode of ['remote_call', 'in_person'] as const) {
      expect(buildSessionConfig({ captureMode, language: 'en' }).parameters.interim_results).toBe('false')
    }
  })

  it('carries the session language through', () => {
    expect(buildSessionConfig({ captureMode: 'in_person', language: 'da' }).parameters.language).toBe('da')
  })
})

describe('final segments', () => {
  const finalMessage = (overrides: Record<string, unknown> = {}) => ({
    type: 'Results',
    is_final: true,
    request_id: 'req-1',
    channel_index: [0, 2],
    start: 1.5,
    duration: 2.25,
    channel: { alternatives: [{ transcript: 'I built a cache.', confidence: 0.94 }] },
    ...overrides,
  })

  it('converts a final result to a persistable segment', () => {
    const segment = parseFinalSegment(finalMessage(), { captureMode: 'remote_call', sequence: 3 })

    expect(segment?.text).toBe('I built a cache.')
    expect(segment?.startsMs).toBe(1500)
    expect(segment?.endsMs).toBe(3750)
    expect(segment?.confidence).toBe(0.94)
    // Stable across a redelivery, which is what makes the unique index an idempotency guarantee rather
    // than a duplicate-row error.
    expect(segment?.providerSegmentId).toBe('req-1:0:3')
  })

  it.each([
    ['an interim result', { is_final: false }],
    ['a silent final with no words', { channel: { alternatives: [{ transcript: '   ' }] } }],
    ['a metadata message', { type: 'Metadata', is_final: undefined, channel: undefined }],
  ])('persists nothing for %s', (_label, overrides) => {
    expect(parseFinalSegment(finalMessage(overrides), { captureMode: 'remote_call', sequence: 0 })).toBeNull()
  })

  it.each([[null], [undefined], ['a string'], [42]])('persists nothing for a non-message (%s)', (raw) => {
    expect(parseFinalSegment(raw, { captureMode: 'remote_call', sequence: 0 })).toBeNull()
  })

  it('guarantees a positive duration the database will accept', () => {
    // transcript_segments_timing_check requires ends > starts; a zero-duration final would be rejected by
    // Postgres far from the code that produced it.
    const segment = parseFinalSegment(finalMessage({ start: 5, duration: 0 }), { captureMode: 'remote_call', sequence: 0 })
    expect(segment?.endsMs).toBeGreaterThan(segment?.startsMs ?? 0)
  })

  it('reads the channel for a remote call', () => {
    expect(parseFinalSegment(finalMessage({ channel_index: [0, 2] }), { captureMode: 'remote_call', sequence: 0 })?.speakerEstimate).toBe('speaker_a')
    expect(parseFinalSegment(finalMessage({ channel_index: [1, 2] }), { captureMode: 'remote_call', sequence: 0 })?.speakerEstimate).toBe('speaker_b')
  })

  it('reads the diarization label for an in-person session', () => {
    const withSpeaker = (speaker: number) => finalMessage({
      channel: { alternatives: [{ transcript: 'text', words: [{ speaker }] }] },
    })
    expect(parseFinalSegment(withSpeaker(0), { captureMode: 'in_person', sequence: 0 })?.speakerEstimate).toBe('speaker_a')
    expect(parseFinalSegment(withSpeaker(1), { captureMode: 'in_person', sequence: 0 })?.speakerEstimate).toBe('speaker_b')
  })

  it('admits it does not know rather than picking one', () => {
    // A wrong attribution puts words in a named person's mouth and the reader cannot tell.
    expect(parseFinalSegment(
      finalMessage({ channel: { alternatives: [{ transcript: 'text', words: [{}] }] } }),
      { captureMode: 'in_person', sequence: 0 },
    )?.speakerEstimate).toBe('unknown')
    expect(parseFinalSegment(
      finalMessage({ channel_index: [7, 8] }),
      { captureMode: 'remote_call', sequence: 0 },
    )?.speakerEstimate).toBe('unknown')
  })

  it('does not let a diarization guess override the channel in remote mode', () => {
    const segment = parseFinalSegment(
      finalMessage({ channel_index: [0, 2], channel: { alternatives: [{ transcript: 'text', words: [{ speaker: 1 }] }] } }),
      { captureMode: 'remote_call', sequence: 0 },
    )
    expect(segment?.speakerEstimate).toBe('speaker_a')
  })
})

describe('billed duration', () => {
  it('rounds up to a whole second', () => {
    // Deepgram bills fractions, the ledger is integers. Rounding down would systematically under-bill
    // every session — a slow accounting error rather than a visible bug.
    expect(normalizeBilledSeconds({ duration: 1802.4 })).toBe(1803)
    expect(normalizeBilledSeconds({ duration: 60 })).toBe(60)
  })

  it.each([[{}], [null], [{ duration: 'lots' }], [{ duration: -5 }], [{ duration: Number.NaN }]])(
    'reports zero for unusable metadata (%s)',
    (metadata) => {
      expect(normalizeBilledSeconds(metadata)).toBe(0)
    },
  )
})
