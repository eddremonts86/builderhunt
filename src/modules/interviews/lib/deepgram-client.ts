import { DEEPGRAM_EU_LISTEN_URL } from '~/lib/interviews/transcription/deepgram'

/**
 * The browser side of the Deepgram EU stream (plan:
 * calendar-scheduling-interview-intelligence, Phase 9).
 *
 * ## It sends PCM and receives text. That is the whole surface.
 *
 * No `MediaRecorder`, no `Blob`, no video. The socket carries `Int16Array` buffers in and JSON out, and the
 * only thing retained on this side is the parsed final text on its way to the outbox.
 *
 * ## Every reconnect asks the server for a new token
 *
 * The grant lives 30 seconds and authorizes the handshake, not the conversation. So the client cannot cache
 * one — and that is the feature, not the cost: the token route re-reads the candidate's consent on every
 * mint, which is what makes a withdrawal enforceable against a client that ignores the heartbeat.
 *
 * `getToken` is therefore a function the caller supplies, not a value. A cached string here would quietly
 * remove the enforcement point.
 *
 * ## A closed socket is not an error until the retries are exhausted
 *
 * A conference call drops packets. Reconnecting silently up to a bounded number of times is what makes the
 * transcript survive a lift ride; giving up after that is what stops an interview from silently
 * transcribing nothing for forty minutes while the organizer believes it is working.
 */

export const MAX_RECONNECT_ATTEMPTS = 5
/** 250ms, 500ms, 1s, 2s, 4s. Bounded so a genuine outage surfaces rather than retrying forever. */
export const RECONNECT_BASE_DELAY_MS = 250

export class DeepgramClientError extends Error {
  constructor(
    message: string,
    readonly code: 'no_token' | 'connect_failed' | 'gave_up' | 'closed',
    /**
     * The code of whatever caused this, when there was one.
     *
     * Kept because the *reason* a grant was refused is usually the most important sentence on the page —
     * "the candidate withdrew consent" is not the same as "could not connect", and collapsing both into
     * `no_token` left the organizer reading "something went wrong" at the one moment they needed to know
     * exactly what had happened.
     */
    readonly reason: string | null = null,
  ) {
    super(message)
    this.name = 'DeepgramClientError'
  }
}

export interface DeepgramGrant {
  accessToken: string
  url: string
  parameters: Readonly<Record<string, string>>
}

export interface FinalSegment {
  providerSegmentId: string
  text: string
  startsMs: number
  endsMs: number
  confidence: number | null
  speakerEstimate: 'speaker_a' | 'speaker_b' | 'unknown'
}

/** The subset of `WebSocket` used here. Narrow so a test supplies a double rather than a whole polyfill. */
export interface SocketLike {
  readyState: number
  send: (data: ArrayBufferLike | ArrayBufferView | string) => void
  close: (code?: number, reason?: string) => void
  onopen: ((event?: unknown) => void) | null
  onclose: ((event: { code?: number; reason?: string; wasClean?: boolean }) => void) | null
  onerror: ((event?: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
}

export interface DeepgramClientOptions {
  captureMode: 'in_person' | 'remote_call'
  /** Called for each reconnect as well as the first connect — never cached. */
  getToken: () => Promise<DeepgramGrant>
  onFinal: (segment: FinalSegment) => void
  /** Told about every state change so the workspace can show an honest connection indicator. */
  onStateChange?: (state: DeepgramConnectionState) => void
  /** Called when the retries are exhausted. The workspace degrades to manual-only from here. */
  onGaveUp?: (error: DeepgramClientError) => void
  createSocket?: (url: string, protocols?: string[]) => SocketLike
  /** Injectable so a reconnect test does not wait seven seconds. */
  delay?: (ms: number) => Promise<void>
}

export type DeepgramConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed' | 'failed'

const OPEN = 1

export class DeepgramLiveClient {
  private socket: SocketLike | null = null
  private state: DeepgramConnectionState = 'idle'
  private attempts = 0
  private sequence = 0
  /** Set by `close()`. A deliberate close must not trigger the reconnect a dropped one does. */
  private closing = false
  /** Frames produced while the socket is down. Bounded — see `enqueue`. */
  private readonly backlog: Int16Array[] = []

  constructor(private readonly options: DeepgramClientOptions) {}

  get connectionState(): DeepgramConnectionState {
    return this.state
  }

  /** How many frames are waiting for a socket. Exposed so the workspace can show a real backlog. */
  get backlogSize(): number {
    return this.backlog.length
  }

  async connect(): Promise<void> {
    this.closing = false
    await this.openSocket()
  }

  private setState(state: DeepgramConnectionState): void {
    this.state = state
    this.options.onStateChange?.(state)
  }

  private async openSocket(): Promise<void> {
    this.setState(this.attempts === 0 ? 'connecting' : 'reconnecting')

    let grant: DeepgramGrant
    try {
      grant = await this.options.getToken()
    } catch (error) {
      // A refused token is usually a withdrawal or a spent balance, and neither is worth retrying: the
      // answer will be the same in 250 ms. Surfacing it immediately is what makes the hard stop prompt.
      this.setState('failed')
      const cause = (error as { code?: unknown } | null)?.code
      const failure = new DeepgramClientError(
        `could not obtain a transcription grant: ${(error as Error)?.name ?? 'unknown'}`,
        'no_token',
        typeof cause === 'string' ? cause : null,
      )
      this.options.onGaveUp?.(failure)
      throw failure
    }

    const url = buildSocketUrl(grant)
    const socket = (this.options.createSocket ?? defaultSocket)(url, ['token', grant.accessToken])
    this.socket = socket

    socket.onopen = () => {
      this.attempts = 0
      this.setState('open')
      // The backlog goes first and in order. Sending live frames ahead of buffered ones would interleave
      // the conversation out of sequence, which reads as two people talking over each other.
      const pending = this.backlog.splice(0, this.backlog.length)
      for (const frame of pending) this.sendFrame(frame)
    }

    socket.onmessage = (event) => {
      const segment = this.parse(event.data)
      if (segment) this.options.onFinal(segment)
    }

    // Deliberately absent behaviour: `onerror` is always followed by `onclose`, and reconnecting from
    // both would open two sockets for one drop and bill two streams for one conversation. The handler is
    // assigned so the browser does not report an unhandled socket error.
    socket.onerror = () => {}

    socket.onclose = (event) => {
      this.socket = null
      if (this.closing) {
        this.setState('closed')
        return
      }
      // 1000 is a clean server-side close: the provider ended the stream, which after a finished interview
      // is the expected outcome rather than a fault to retry.
      if (event.code === 1000) {
        this.setState('closed')
        return
      }
      void this.reconnect()
    }
  }

  private async reconnect(): Promise<void> {
    this.attempts += 1
    if (this.attempts > MAX_RECONNECT_ATTEMPTS) {
      this.setState('failed')
      this.options.onGaveUp?.(new DeepgramClientError(
        `gave up after ${MAX_RECONNECT_ATTEMPTS} reconnection attempts`,
        'gave_up',
      ))
      return
    }
    const wait = RECONNECT_BASE_DELAY_MS * 2 ** (this.attempts - 1)
    await (this.options.delay ?? defaultDelay)(wait)
    if (this.closing) return
    // `openSocket` already reported the failure through `onGaveUp`; this only stops an unhandled
    // rejection surfacing from a background retry.
    await this.openSocket().catch(() => {})
  }

  /**
   * Hands a frame to the socket, or holds it if there is no socket.
   *
   * The backlog is bounded at roughly thirty seconds. An unbounded one during a long outage grows until the
   * tab is killed, which loses the whole interview rather than the part that could not be sent.
   */
  enqueue(pcm: Int16Array): void {
    if (this.socket?.readyState === OPEN) {
      this.sendFrame(pcm)
      return
    }
    const maximum = Math.ceil(30_000 / 20)
    if (this.backlog.length >= maximum) this.backlog.shift()
    this.backlog.push(pcm)
  }

  private sendFrame(pcm: Int16Array): void {
    // The buffer, not the view. A `Int16Array` from a larger pool would otherwise send the whole pool.
    this.socket?.send(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength))
  }

  /**
   * Closes deliberately.
   *
   * `closing` is set before `close()` so the `onclose` that follows does not start a reconnect — the
   * ordering matters, and reversing it produces a socket that reopens after the interview finished.
   */
  close(): void {
    this.closing = true
    this.backlog.length = 0
    const socket = this.socket
    this.socket = null
    // 1000: this end is done, which is not an error the provider should log as one.
    socket?.close(1000, 'session finished')
    this.setState('closed')
  }

  /**
   * Parses one provider message into a final segment, or null.
   *
   * Null for interim results, empty finals and metadata. Deepgram emits empty finals during silence, and
   * persisting them would fill a transcript with blank lines and inflate every sequence number.
   */
  private parse(raw: unknown): FinalSegment | null {
    let message: DeepgramMessage
    try {
      message = (typeof raw === 'string' ? JSON.parse(raw) : raw) as DeepgramMessage
    } catch {
      return null
    }
    if (!message || typeof message !== 'object' || message.is_final !== true) return null

    const alternative = message.channel?.alternatives?.[0]
    const text = (alternative?.transcript ?? '').trim()
    if (text.length === 0) return null

    const startSeconds = typeof message.start === 'number' ? message.start : 0
    const durationSeconds = typeof message.duration === 'number' ? message.duration : 0
    const startsMs = Math.max(0, Math.round(startSeconds * 1_000))
    // At least one millisecond: `transcript_segments_timing_check` requires ends > starts, and a
    // zero-duration final would be rejected by the database far from here.
    const endsMs = Math.max(startsMs + 1, Math.round((startSeconds + durationSeconds) * 1_000))

    this.sequence += 1
    return {
      // Deepgram gives no per-segment id, so one is derived from what does identify it. Stable across a
      // redelivery, which is what makes the server's unique index an idempotency guarantee.
      providerSegmentId: `${message.request_id ?? 'unknown'}:${message.channel_index?.[0] ?? 0}:${this.sequence}`,
      text,
      startsMs,
      endsMs,
      confidence: typeof alternative?.confidence === 'number' ? alternative.confidence : null,
      speakerEstimate: this.speakerFor(message),
    }
  }

  private speakerFor(message: DeepgramMessage): FinalSegment['speakerEstimate'] {
    if (this.options.captureMode === 'remote_call') {
      // The channel index the mixer assigned. A diarization label in the same message is ignored on
      // purpose: it would replace a fact we constructed with a guess a model made.
      const channel = message.channel_index?.[0]
      if (channel === 0) return 'speaker_a'
      if (channel === 1) return 'speaker_b'
      return 'unknown'
    }
    const speaker = message.channel?.alternatives?.[0]?.words
      ?.find((word) => typeof word.speaker === 'number')?.speaker
    if (speaker === 0) return 'speaker_a'
    if (speaker === 1) return 'speaker_b'
    // `unknown` rather than a default: a wrong attribution in an interview transcript is worse than an
    // admitted gap, because a reader cannot tell it is wrong.
    return 'unknown'
  }
}

interface DeepgramMessage {
  type?: string
  is_final?: boolean
  channel_index?: [number, number]
  start?: number
  duration?: number
  request_id?: string
  channel?: {
    alternatives?: Array<{ transcript?: string; confidence?: number; words?: Array<{ speaker?: number }> }>
  }
}

/**
 * Builds the socket URL from the grant.
 *
 * The host comes from the grant's own `url` and is verified to be the EU endpoint. A parameter map that
 * could carry a host, or a base URL taken from configuration reachable by a client, would be a way to point
 * a candidate's audio at a different country.
 */
export function buildSocketUrl(grant: DeepgramGrant): string {
  const base = grant.url || DEEPGRAM_EU_LISTEN_URL
  if (!base.startsWith('wss://api.eu.deepgram.com/')) {
    throw new DeepgramClientError('the transcription grant named a non-EU endpoint', 'connect_failed')
  }
  const url = new URL(base)
  for (const [key, value] of Object.entries(grant.parameters)) url.searchParams.set(key, value)
  return url.toString()
}

function defaultSocket(url: string, protocols?: string[]): SocketLike {
  const Constructor = (globalThis as { WebSocket?: new (url: string, protocols?: string[]) => unknown }).WebSocket
  if (!Constructor) throw new DeepgramClientError('WebSocket is unavailable', 'connect_failed')
  const socket = new Constructor(url, protocols) as SocketLike & { binaryType?: string }
  // Binary frames, never text. A text socket would coerce PCM to a string.
  socket.binaryType = 'arraybuffer'
  return socket
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}
