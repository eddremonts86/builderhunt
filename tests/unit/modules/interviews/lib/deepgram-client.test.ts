/**
 * A socket double, a controllable clock, and real message parsing.
 *
 * The reconnect behaviour is the part most likely to be quietly wrong, and it is invisible in a live test:
 * a client that opens two sockets per drop, or one that reconnects after a deliberate close, transcribes
 * perfectly right up to the moment it bills twice or resumes a finished interview.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  buildSocketUrl,
  DeepgramClientError,
  DeepgramLiveClient,
  MAX_RECONNECT_ATTEMPTS,
  RECONNECT_BASE_DELAY_MS,
  type DeepgramConnectionState,
  type SocketLike,
} from '~/modules/interviews/lib/deepgram-client'

const OPEN = 1

interface FakeSocket extends SocketLike {
  sent: unknown[]
  closedWith: Array<{ code?: number; reason?: string }>
}

function harness(options: {
  captureMode?: 'in_person' | 'remote_call'
  token?: () => Promise<{ accessToken: string; url: string; parameters: Record<string, string> }>
} = {}) {
  const sockets: FakeSocket[] = []
  const finals: unknown[] = []
  const states: DeepgramConnectionState[] = []
  const waits: number[] = []
  const gaveUp: DeepgramClientError[] = []

  const client = new DeepgramLiveClient({
    captureMode: options.captureMode ?? 'remote_call',
    getToken: options.token ?? (async () => ({
      accessToken: `grant-${sockets.length + 1}`,
      url: 'wss://api.eu.deepgram.com/v1/listen',
      parameters: { model: 'nova-3', channels: '2', multichannel: 'true' },
    })),
    onFinal: (segment) => finals.push(segment),
    onStateChange: (state) => states.push(state),
    onGaveUp: (error) => gaveUp.push(error),
    // Recorded rather than awaited: five real backoffs would add seven seconds to the suite.
    delay: async (ms) => { waits.push(ms) },
    createSocket: (url, protocols) => {
      const socket: FakeSocket = {
        readyState: 0,
        sent: [],
        closedWith: [],
        send: (data) => socket.sent.push(data),
        close: (code, reason) => {
          socket.closedWith.push({ code, reason })
          socket.readyState = 3
        },
        onopen: null, onclose: null, onerror: null, onmessage: null,
      }
      Object.assign(socket, { url, protocols })
      sockets.push(socket)
      return socket
    },
  })

  const open = (index = sockets.length - 1) => {
    sockets[index].readyState = OPEN
    sockets[index].onopen?.()
  }
  const drop = (index = sockets.length - 1, code = 1006) => {
    sockets[index].readyState = 3
    sockets[index].onclose?.({ code })
  }

  return { client, sockets, finals, states, waits, gaveUp, open, drop }
}

const finalMessage = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  type: 'Results',
  is_final: true,
  request_id: 'req-1',
  channel_index: [0, 2],
  start: 1.5,
  duration: 2.25,
  channel: { alternatives: [{ transcript: 'Tell me about the caching work.', confidence: 0.98 }] },
  ...overrides,
})

describe('the socket URL', () => {
  it('carries the grant parameters', () => {
    const url = buildSocketUrl({
      accessToken: 'x',
      url: 'wss://api.eu.deepgram.com/v1/listen',
      parameters: { model: 'nova-3', channels: '2' },
    })
    expect(url).toContain('model=nova-3')
    expect(url).toContain('channels=2')
  })

  it('refuses a grant naming a non-EU endpoint', () => {
    // The host comes from the grant and is verified. A parameter map that could carry a host would be a
    // way to point a candidate's audio at a different country.
    expect(() => buildSocketUrl({
      accessToken: 'x', url: 'wss://api.deepgram.com/v1/listen', parameters: {},
    })).toThrow(DeepgramClientError)
  })

  it('refuses a look-alike host', () => {
    expect(() => buildSocketUrl({
      accessToken: 'x', url: 'wss://api.eu.deepgram.com.evil.test/v1/listen', parameters: {},
    })).toThrow(DeepgramClientError)
  })

  it('falls back to the pinned EU endpoint for an empty url', () => {
    expect(buildSocketUrl({ accessToken: 'x', url: '', parameters: {} }))
      .toContain('wss://api.eu.deepgram.com/v1/listen')
  })
})

describe('connecting', () => {
  it('asks for a token and opens one socket', async () => {
    const h = harness()
    await h.client.connect()
    expect(h.sockets).toHaveLength(1)
    expect(h.states).toEqual(['connecting'])
    h.open()
    expect(h.client.connectionState).toBe('open')
  })

  it('passes the grant as a subprotocol, not a query parameter', async () => {
    const h = harness()
    await h.client.connect()
    // A credential in a URL ends up in logs, referrers and crash reports.
    const socket = h.sockets[0] as unknown as { url: string; protocols: string[] }
    expect(socket.protocols).toEqual(['token', 'grant-1'])
    expect(socket.url).not.toContain('grant-1')
  })

  it('fails immediately when the token is refused, without retrying', async () => {
    // A refused token is a withdrawal or a spent balance. The answer will be the same in 250 ms, and
    // surfacing it at once is what makes the hard stop prompt.
    const h = harness({ token: async () => { throw Object.assign(new Error('no'), { name: 'ConsentWithdrawn' }) } })
    await expect(h.client.connect()).rejects.toMatchObject({ code: 'no_token' })
    expect(h.sockets).toHaveLength(0)
    expect(h.waits).toEqual([])
    expect(h.gaveUp[0].code).toBe('no_token')
  })
})

describe('sending audio', () => {
  it('sends a copy of the frame, not the backing pool', async () => {
    const h = harness()
    await h.client.connect()
    h.open()

    const pool = new Int16Array([1, 2, 3, 4, 5, 6])
    // A view into a larger buffer, which is what a reused frame pool produces.
    const frame = pool.subarray(2, 4)
    h.client.enqueue(frame)

    const sent = h.sockets[0].sent[0] as ArrayBuffer
    // Four bytes, not twelve. Sending `pcm.buffer` directly would ship the whole pool — every previous
    // frame included.
    expect(sent.byteLength).toBe(4)
    expect([...new Int16Array(sent)]).toEqual([3, 4])
  })

  it('buffers while the socket is down and drains in order on open', async () => {
    const h = harness()
    await h.client.connect()
    h.client.enqueue(new Int16Array([1]))
    h.client.enqueue(new Int16Array([2]))
    expect(h.client.backlogSize).toBe(2)

    h.open()
    // In order. Live frames ahead of buffered ones would interleave the conversation, which reads as two
    // people talking over each other.
    expect(h.sockets[0].sent.map((buffer) => [...new Int16Array(buffer as ArrayBuffer)])).toEqual([[1], [2]])
    expect(h.client.backlogSize).toBe(0)
  })

  it('bounds the backlog rather than growing until the tab dies', async () => {
    const h = harness()
    await h.client.connect()
    const maximum = Math.ceil(30_000 / 20)
    for (let n = 0; n < maximum + 10; n += 1) h.client.enqueue(new Int16Array([n]))
    // An unbounded backlog during a long outage loses the whole interview instead of the unsendable part.
    expect(h.client.backlogSize).toBe(maximum)
  })

  it('drops the oldest frames first', async () => {
    const h = harness()
    await h.client.connect()
    const maximum = Math.ceil(30_000 / 20)
    for (let n = 0; n < maximum + 1; n += 1) h.client.enqueue(new Int16Array([n]))
    h.open()
    const first = new Int16Array(h.sockets[0].sent[0] as ArrayBuffer)[0]
    // The most recent audio is the audio worth keeping: it is what the organizer is still talking about.
    expect(first).toBe(1)
  })
})

describe('reconnecting', () => {
  it('reopens after an unclean close, with a fresh token', async () => {
    const h = harness()
    await h.client.connect()
    h.open()
    h.drop(0, 1006)
    await vi.waitFor(() => expect(h.sockets).toHaveLength(2))

    // A new grant, because the 30-second one authorized the handshake, not the conversation — and the
    // token route re-reads consent on every mint.
    expect((h.sockets[1] as unknown as { protocols: string[] }).protocols).toEqual(['token', 'grant-2'])
    expect(h.states).toContain('reconnecting')
  })

  it('backs off exponentially and gives up after the bound', async () => {
    const h = harness()
    await h.client.connect()
    h.open()

    // Five drops produce five backoffs and five fresh sockets.
    for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt += 1) {
      h.drop()
      await vi.waitFor(() => expect(h.waits).toHaveLength(attempt))
    }
    expect(h.waits).toEqual([
      RECONNECT_BASE_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2, RECONNECT_BASE_DELAY_MS * 4,
      RECONNECT_BASE_DELAY_MS * 8, RECONNECT_BASE_DELAY_MS * 16,
    ])
    // Awaited separately: the delay is recorded before `openSocket` runs, so the socket for the last
    // backoff is still in flight when the wait count reaches five.
    await vi.waitFor(() => expect(h.sockets).toHaveLength(MAX_RECONNECT_ATTEMPTS + 1))
    expect(h.gaveUp).toHaveLength(0)

    // The sixth gives up *before* waiting: another 8-second delay before admitting defeat would leave the
    // organizer watching a "reconnecting" indicator for a socket that is never coming back.
    h.drop()
    await vi.waitFor(() => expect(h.gaveUp).toHaveLength(1))
    expect(h.waits).toHaveLength(MAX_RECONNECT_ATTEMPTS)
    expect(h.sockets).toHaveLength(MAX_RECONNECT_ATTEMPTS + 1)
    // Bounded, so a genuine outage surfaces instead of the client silently transcribing nothing for forty
    // minutes while the organizer believes it is working.
    expect(h.gaveUp[0].code).toBe('gave_up')
    expect(h.client.connectionState).toBe('failed')
  })

  it('resets the attempt count after a successful reopen', async () => {
    const h = harness()
    await h.client.connect()
    h.open()
    h.drop(0)
    await vi.waitFor(() => expect(h.sockets).toHaveLength(2))
    h.open(1)
    h.drop(1)
    await vi.waitFor(() => expect(h.waits).toHaveLength(2))
    // Back to the shortest delay: a drop an hour after the last one is a new incident, not a continuation.
    expect(h.waits[1]).toBe(RECONNECT_BASE_DELAY_MS)
  })

  it('does not reconnect after a clean server close', async () => {
    const h = harness()
    await h.client.connect()
    h.open()
    // 1000 means the provider ended the stream, which after a finished interview is expected.
    h.drop(0, 1000)
    await new Promise((resolve) => { setTimeout(resolve, 5) })
    expect(h.sockets).toHaveLength(1)
    expect(h.client.connectionState).toBe('closed')
  })

  it('does not reconnect after a deliberate close', async () => {
    const h = harness()
    await h.client.connect()
    h.open()
    h.client.close()
    // The close event a browser delivers after `close()`. Reversing the ordering inside `close()` produces
    // a socket that reopens after the interview finished.
    h.sockets[0].onclose?.({ code: 1006 })
    await new Promise((resolve) => { setTimeout(resolve, 5) })
    expect(h.sockets).toHaveLength(1)
  })

  it('opens one socket per drop, not two', async () => {
    const h = harness()
    await h.client.connect()
    h.open()
    // A browser fires `onerror` and then `onclose` for the same drop. Reconnecting from both would open
    // two sockets and bill two streams for one conversation.
    h.sockets[0].onerror?.()
    h.drop(0)
    await vi.waitFor(() => expect(h.sockets).toHaveLength(2))
    await new Promise((resolve) => { setTimeout(resolve, 5) })
    expect(h.sockets).toHaveLength(2)
  })

  it('closes with 1000 and discards the backlog', async () => {
    const h = harness()
    await h.client.connect()
    h.client.enqueue(new Int16Array([1]))
    h.client.close()
    expect(h.sockets[0].closedWith[0].code).toBe(1000)
    // Nothing left to resend into a session that has finished.
    expect(h.client.backlogSize).toBe(0)
  })
})

describe('parsing provider messages', () => {
  async function connected(captureMode: 'in_person' | 'remote_call' = 'remote_call') {
    const h = harness({ captureMode })
    await h.client.connect()
    h.open()
    return h
  }

  it('emits a final segment with millisecond timings', async () => {
    const h = await connected()
    h.sockets[0].onmessage?.({ data: finalMessage() })
    expect(h.finals[0]).toEqual({
      providerSegmentId: 'req-1:0:1',
      text: 'Tell me about the caching work.',
      startsMs: 1_500,
      endsMs: 3_750,
      confidence: 0.98,
      speakerEstimate: 'speaker_a',
    })
  })

  it('ignores an interim result', async () => {
    const h = await connected()
    h.sockets[0].onmessage?.({ data: finalMessage({ is_final: false }) })
    // Interim text is replaced within seconds. Storing it would multiply a candidate's words for nothing.
    expect(h.finals).toHaveLength(0)
  })

  it('ignores an empty final, which is what silence produces', async () => {
    const h = await connected()
    h.sockets[0].onmessage?.({ data: finalMessage({ channel: { alternatives: [{ transcript: '   ' }] } }) })
    // Blank lines in a transcript, and an inflated sequence number for every one of them.
    expect(h.finals).toHaveLength(0)
  })

  it('ignores metadata and malformed JSON', async () => {
    const h = await connected()
    h.sockets[0].onmessage?.({ data: JSON.stringify({ type: 'Metadata', duration: 12.4 }) })
    h.sockets[0].onmessage?.({ data: 'not json at all' })
    h.sockets[0].onmessage?.({ data: null })
    expect(h.finals).toHaveLength(0)
  })

  it('guarantees ends is after starts even for a zero-duration final', async () => {
    const h = await connected()
    h.sockets[0].onmessage?.({ data: finalMessage({ start: 4, duration: 0 }) })
    // `transcript_segments_timing_check` requires it, and the rejection would otherwise arrive from the
    // database far from here.
    expect((h.finals[0] as { startsMs: number; endsMs: number }).endsMs).toBe(4_001)
  })

  it('numbers segments monotonically across sockets', async () => {
    const h = await connected()
    h.sockets[0].onmessage?.({ data: finalMessage() })
    h.drop(0)
    await vi.waitFor(() => expect(h.sockets).toHaveLength(2))
    h.open(1)
    h.sockets[1].onmessage?.({ data: finalMessage() })
    // The sequence survives a reconnect. Restarting it would collide with segments already accepted.
    expect((h.finals[1] as { providerSegmentId: string }).providerSegmentId).toBe('req-1:0:2')
  })

  it('attributes remote audio by channel and ignores a diarization label', async () => {
    const h = await connected('remote_call')
    h.sockets[0].onmessage?.({
      data: finalMessage({
        channel_index: [1, 2],
        // A label the provider offered anyway. Honouring it would replace a fact the mixer constructed
        // with a guess a model made.
        channel: { alternatives: [{ transcript: 'I built the cache.', confidence: 0.9, words: [{ speaker: 0 }] }] },
      }),
    })
    expect((h.finals[0] as { speakerEstimate: string }).speakerEstimate).toBe('speaker_b')
  })

  it('attributes in-person audio by diarization', async () => {
    const h = await connected('in_person')
    h.sockets[0].onmessage?.({
      data: finalMessage({
        channel_index: [0, 1],
        channel: { alternatives: [{ transcript: 'I built the cache.', words: [{ speaker: 1 }] }] },
      }),
    })
    // One microphone carrying two voices. The channel says nothing, so the guess is all there is.
    expect((h.finals[0] as { speakerEstimate: string }).speakerEstimate).toBe('speaker_b')
  })

  it('says unknown rather than guessing when neither signal exists', async () => {
    const h = await connected('in_person')
    h.sockets[0].onmessage?.({ data: finalMessage({ channel: { alternatives: [{ transcript: 'Hello.' }] } }) })
    // A wrong attribution in an interview transcript is worse than an admitted gap, because a reader
    // cannot tell it is wrong.
    expect((h.finals[0] as { speakerEstimate: string }).speakerEstimate).toBe('unknown')
  })

  it('reports a null confidence rather than inventing one', async () => {
    const h = await connected()
    h.sockets[0].onmessage?.({ data: finalMessage({ channel: { alternatives: [{ transcript: 'Hello.' }] } }) })
    expect((h.finals[0] as { confidence: number | null }).confidence).toBeNull()
  })
})
