/**
 * Deepgram EU streaming-transcription tokens and session configuration (plan:
 * calendar-scheduling-interview-intelligence, Phase 9). Server-only — reads `DEEPGRAM_API_KEY`.
 *
 * ## The master key never leaves this module
 *
 * The browser needs credentials to open a WebSocket, and the obvious shortcut is to hand it the API key.
 * That key can create projects, read every past request, and spend money; a copy of it in a browser is a
 * copy in every extension, devtools session and crash report on that machine. So this mints a 30-second
 * scoped grant instead, and `assertNoMasterKey` is a test-visible guarantee rather than a habit.
 *
 * ## 30 seconds, and why that is not too short
 *
 * The token authorizes the *handshake*, not the conversation. Once the socket is open it stays open —
 * Deepgram does not re-check the grant mid-stream — so a 30-second TTL costs nothing during a
 * 45-minute interview and means a leaked token is useless almost immediately. A reconnect asks for a
 * new one, which is a request the client is already making anyway.
 *
 * ## Two capture modes, two configurations, and they are not interchangeable
 *
 * - **remote_call**: two interleaved channels — microphone on 0, meeting tab on 1 — with
 *   `channels=2&multichannel=true`. Deepgram then attributes each transcript to the channel it came
 *   from, which is *deterministic*: the organizer is channel 0 because we put them there. No guessing.
 * - **in_person**: one microphone carrying both voices, so channel attribution is impossible and
 *   `diarize=true` is the only option. Diarization guesses, which is why the schema has
 *   `speaker_mapping` for an organizer to correct it.
 *
 * Using diarization for remote would throw away attribution we already have and replace it with a
 * guess; using multichannel for in-person would claim two sources where there is one. The mode decides,
 * and `buildSessionConfig` refuses to be told otherwise.
 */
import { env } from '~/shared/lib/env'
import type { InterviewCaptureMode, InterviewSupportedLanguage } from '~/shared/lib/interview-config'

/** The only endpoint this module will ever talk to. Not a default — a constant. */
export const DEEPGRAM_EU_LISTEN_URL = 'wss://api.eu.deepgram.com/v1/listen'
const DEEPGRAM_EU_API_BASE = 'https://api.eu.deepgram.com'

/** Long enough for a handshake, short enough that a leaked token is worthless. */
export const DEEPGRAM_TOKEN_TTL_SECONDS = 30

/**
 * Pinned, not `nova-3-general` or a floating alias.
 *
 * A model change alters how a candidate's words are transcribed, which alters the transcript a decision
 * is made from. That is an auditability question, not a quality preference.
 */
export const DEEPGRAM_MODEL = 'nova-3'

export class DeepgramError extends Error {
  constructor(message: string, readonly code: 'not_configured' | 'provider_unavailable' | 'invalid_response') {
    super(message)
    this.name = 'DeepgramError'
  }
}

export interface DeepgramSessionToken {
  /** The scoped grant. Safe to send to a browser; the master key is not. */
  accessToken: string
  expiresInSeconds: number
  url: string
}

export interface DeepgramSessionConfig {
  url: string
  /** Query parameters, already ordered, for the WebSocket URL. */
  parameters: Readonly<Record<string, string>>
  /** Channel index → what is on it. Empty for in-person, where there is one channel and two voices. */
  channelLabels: Readonly<Record<number, 'organizer' | 'candidate_or_remote'>>
  /** True only for in-person: channel attribution is impossible with one microphone. */
  diarize: boolean
}

interface DeepgramGrantResponse {
  access_token?: string
  expires_in?: number
}

/**
 * Mints a short-lived grant.
 *
 * Deepgram's `/v1/auth/grant` returns a token scoped to what the requesting key can do. This module
 * requests nothing beyond that and never sends the master key onward — the *only* place it appears is
 * the `Authorization` header of this one server-to-server request.
 */
export async function createSessionToken(options?: { fetchImpl?: typeof fetch }): Promise<DeepgramSessionToken> {
  const apiKey = env.DEEPGRAM_API_KEY
  if (!apiKey) throw new DeepgramError('DEEPGRAM_API_KEY is not configured', 'not_configured')

  const doFetch = options?.fetchImpl ?? fetch
  let response: Response
  try {
    response = await doFetch(`${DEEPGRAM_EU_API_BASE}/v1/auth/grant`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl_seconds: DEEPGRAM_TOKEN_TTL_SECONDS }),
    })
  } catch (error) {
    throw new DeepgramError(
      `could not reach the transcription provider: ${error instanceof Error ? error.name : 'unknown'}`,
      'provider_unavailable',
    )
  }

  if (!response.ok) {
    // Status only. A provider error body can echo request details, and this message reaches logs.
    throw new DeepgramError(`transcription provider returned ${response.status}`, 'provider_unavailable')
  }

  let payload: DeepgramGrantResponse
  try {
    payload = await response.json() as DeepgramGrantResponse
  } catch {
    throw new DeepgramError('transcription provider returned a non-JSON grant', 'invalid_response')
  }

  const accessToken = payload.access_token
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new DeepgramError('transcription grant carried no access token', 'invalid_response')
  }
  assertNoMasterKey(accessToken, apiKey)

  return {
    accessToken,
    // The provider's own answer, clamped: a grant that claimed an hour would still be treated as 30
    // seconds by everything downstream, and the mismatch would surface as a mystery reconnect.
    expiresInSeconds: Math.min(payload.expires_in ?? DEEPGRAM_TOKEN_TTL_SECONDS, DEEPGRAM_TOKEN_TTL_SECONDS),
    url: DEEPGRAM_EU_LISTEN_URL,
  }
}

/**
 * Refuses to return anything that contains the master key.
 *
 * Exported because it is the guarantee, not an implementation detail: a future refactor that changed
 * where the token comes from should still be unable to leak the key past this point.
 */
export function assertNoMasterKey(token: string, apiKey: string): void {
  if (apiKey.length > 0 && token.includes(apiKey)) {
    throw new DeepgramError('transcription grant contained the master key', 'invalid_response')
  }
}

/**
 * The WebSocket configuration for one session.
 *
 * `encoding=linear16&sample_rate=16000` because that is what the browser mixer produces, stated
 * explicitly rather than left to content-type sniffing — a mismatch here transcribes noise, and noise is
 * indistinguishable from a candidate who mumbles.
 */
export function buildSessionConfig(params: {
  captureMode: InterviewCaptureMode
  language: InterviewSupportedLanguage
}): DeepgramSessionConfig {
  const shared: Record<string, string> = {
    model: DEEPGRAM_MODEL,
    language: params.language,
    encoding: 'linear16',
    sample_rate: '16000',
    // Punctuation and number formatting. A transcript a human reads during an interview is worth
    // formatting; one they cannot skim is worth less than nothing at speed.
    smart_format: 'true',
    // Final results only. Interim text is never persisted, and asking for it here would only add
    // traffic the outbox must then filter out.
    interim_results: 'false',
  }

  if (params.captureMode === 'remote_call') {
    return {
      url: DEEPGRAM_EU_LISTEN_URL,
      parameters: Object.freeze({
        ...shared,
        channels: '2',
        multichannel: 'true',
        // Deliberately absent: attribution is already deterministic from the channel, and diarization
        // would replace a fact with a guess.
      }),
      // Deterministic, because the mixer puts them there — not inferred from the audio.
      channelLabels: Object.freeze({ 0: 'organizer' as const, 1: 'candidate_or_remote' as const }),
      diarize: false,
    }
  }

  return {
    url: DEEPGRAM_EU_LISTEN_URL,
    parameters: Object.freeze({
      ...shared,
      channels: '1',
      // One microphone carrying two voices. Diarization is the only way to separate them, and it
      // guesses — which is why `transcript_segments.speaker_mapping` exists for a human to correct.
      diarize: 'true',
    }),
    channelLabels: Object.freeze({}),
    diarize: true,
  }
}

export interface DeepgramFinalSegment {
  providerSegmentId: string
  text: string
  startsMs: number
  endsMs: number
  confidence: number | null
  /** `speaker_a`/`speaker_b` from a channel index or a diarization label; `unknown` when neither is usable. */
  speakerEstimate: 'speaker_a' | 'speaker_b' | 'unknown'
}

interface DeepgramListenMessage {
  type?: string
  is_final?: boolean
  channel_index?: [number, number]
  start?: number
  duration?: number
  request_id?: string
  channel?: {
    alternatives?: Array<{
      transcript?: string
      confidence?: number
      words?: Array<{ speaker?: number }>
    }>
  }
}

/**
 * Turns one provider message into a segment, or null when there is nothing worth persisting.
 *
 * Returns null for interim results, empty transcripts and non-transcript messages. An empty final —
 * which Deepgram emits during silence — must not become a blank line in the transcript, and a
 * `Metadata` message must not become a segment at all.
 */
export function parseFinalSegment(
  raw: unknown,
  context: { captureMode: InterviewCaptureMode; sequence: number },
): DeepgramFinalSegment | null {
  const message = raw as DeepgramListenMessage | null
  if (!message || typeof message !== 'object') return null
  if (message.is_final !== true) return null

  const alternative = message.channel?.alternatives?.[0]
  const text = (alternative?.transcript ?? '').trim()
  // Silence produces final results with empty transcripts. Persisting them would fill a transcript with
  // blank lines and inflate every sequence number.
  if (text.length === 0) return null

  const startSeconds = typeof message.start === 'number' ? message.start : 0
  const durationSeconds = typeof message.duration === 'number' ? message.duration : 0
  const startsMs = Math.max(0, Math.round(startSeconds * 1000))
  // At least one millisecond: `transcript_segments_timing_check` requires ends > starts, and a
  // zero-duration final would be rejected by the database far from here.
  const endsMs = Math.max(startsMs + 1, Math.round((startSeconds + durationSeconds) * 1000))

  return {
    // Deepgram gives no per-segment id, so one is derived from what does identify it: the request, the
    // channel and the sequence. Stable across a redelivery of the same message, which is what makes the
    // unique index an idempotency guarantee rather than a duplicate-row error.
    providerSegmentId: `${message.request_id ?? 'unknown'}:${message.channel_index?.[0] ?? 0}:${context.sequence}`,
    text,
    startsMs,
    endsMs,
    confidence: typeof alternative?.confidence === 'number' ? alternative.confidence : null,
    speakerEstimate: speakerFor(message, context.captureMode),
  }
}

function speakerFor(message: DeepgramListenMessage, captureMode: InterviewCaptureMode): DeepgramFinalSegment['speakerEstimate'] {
  if (captureMode === 'remote_call') {
    // The channel index, which the mixer assigned. Deterministic.
    const channel = message.channel_index?.[0]
    if (channel === 0) return 'speaker_a'
    if (channel === 1) return 'speaker_b'
    return 'unknown'
  }
  // Diarization. `unknown` when the provider offered no speaker at all rather than picking one — a
  // wrong attribution in an interview transcript is worse than an admitted gap.
  const speaker = message.channel?.alternatives?.[0]?.words?.find((word) => typeof word.speaker === 'number')?.speaker
  if (speaker === 0) return 'speaker_a'
  if (speaker === 1) return 'speaker_b'
  return 'unknown'
}

/**
 * The billable duration to settle against, from the provider's own metadata.
 *
 * Rounded *up* to a whole second. Deepgram bills in fractions and the credit ledger is integers; rounding
 * down would systematically under-bill every session, which is a slow accounting error rather than a
 * visible bug.
 */
export function normalizeBilledSeconds(metadata: unknown): number {
  const duration = (metadata as { duration?: unknown } | null)?.duration
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) return 0
  return Math.ceil(duration)
}
