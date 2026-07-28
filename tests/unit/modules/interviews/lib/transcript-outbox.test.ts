/**
 * Real IndexedDB semantics via `fake-indexeddb`, not a mocked store.
 *
 * The claims worth testing here are all storage-shaped: whether a compound-index read actually excludes
 * another user's records, whether a transaction that aborts is reported as a failure rather than a
 * success, whether a sweep at open deletes before anything is read. A hand-built Map would satisfy every
 * assertion while the real store leaked across users.
 *
 * The quota failure is the one case a real implementation cannot be asked for on demand, so it comes from
 * an injected factory whose transaction aborts — which is what a browser out of space actually does.
 */
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  assertNoForbiddenPayload,
  openTranscriptOutbox,
  OUTBOX_RECORD_TTL_MS,
  OutboxError,
  type OutboxSegment,
} from '~/modules/interviews/lib/transcript-outbox'

const USER_A = 'user-a'
const USER_B = 'user-b'
const SESSION_1 = 'session-1'
const SESSION_2 = 'session-2'

let clock = 1_700_000_000_000
const now = () => clock

const segment = (n: number, overrides: Partial<OutboxSegment> = {}): OutboxSegment => ({
  providerSegmentId: `req:0:${n}`,
  sequence: n,
  speakerEstimate: 'speaker_a',
  text: `Turn ${n}.`,
  startsMs: n * 1_000,
  endsMs: n * 1_000 + 900,
  confidence: 0.95,
  ...overrides,
})

const open = (userId = USER_A, sessionId = SESSION_1) =>
  openTranscriptOutbox({ userId, sessionId, now })

beforeEach(() => {
  // A fresh database per test. `fake-indexeddb`'s factory is process-global, so without this every test
  // would inherit the previous one's records and a cross-user assertion could pass on stale data.
  ;(globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
  clock = 1_700_000_000_000
})

describe('the store holds unacknowledged finals and nothing else', () => {
  it('round-trips a batch in sequence order', async () => {
    const outbox = await open()
    await outbox!.enqueue([segment(3), segment(1), segment(2)])
    const pending = await outbox!.pending()
    // Sorted: a transcript resent out of order reads out of order.
    expect(pending.map((entry) => entry.sequence)).toEqual([1, 2, 3])
    expect(pending[0]).toEqual(segment(1))
  })

  it('carries no key, user or expiry into what the caller sees', async () => {
    const outbox = await open()
    await outbox!.enqueue([segment(1)])
    const [pending] = await outbox!.pending()
    // Internal bookkeeping. A caller that received `expiresAt` would eventually make a decision from it.
    expect(Object.keys(pending)).not.toContain('key')
    expect(Object.keys(pending)).not.toContain('userId')
    expect(Object.keys(pending)).not.toContain('expiresAt')
  })

  it('treats a re-enqueue as an update, not a duplicate-key failure', async () => {
    const outbox = await open()
    await outbox!.enqueue([segment(1)])
    // What a failed send followed by a retry does. `add` would throw here and take out the capture path.
    await expect(outbox!.enqueue([segment(1)])).resolves.toBeUndefined()
    expect(await outbox!.pending()).toHaveLength(1)
  })

  it('does nothing for an empty batch', async () => {
    const outbox = await open()
    await outbox!.enqueue([])
    expect(await outbox!.pending()).toEqual([])
  })
})

describe('audio and interim text are refused', () => {
  const forbidden: Array<[string, Record<string, unknown>]> = [
    ['an audio field', { audio: 'AAAA' }],
    ['an audioBlob field', { audioBlob: 'x' }],
    ['an objectUrl field', { objectUrl: 'blob:https://app/x' }],
    ['an objectKey field', { objectKey: 'recordings/x.webm' }],
    ['a recording field', { recording: 'x' }],
    ['a mediaStream field', { mediaStream: {} }],
    ['interim text', { interimText: 'partial wor' }],
    ['an isFinal flag', { isFinal: true }],
  ]

  it.each(forbidden)('refuses %s', async (_label, extra) => {
    const outbox = await open()
    await expect(outbox!.enqueue([{ ...segment(1), ...extra } as OutboxSegment]))
      .rejects.toMatchObject({ code: 'forbidden_payload' })
    // And nothing was written. A rejection that stored the record first would be worse than no check.
    expect(await outbox!.pending()).toHaveLength(0)
  })

  it('refuses binary data under an innocent name', async () => {
    // The field list catches the obvious spellings. This catches the shape whatever it was called.
    expect(() => assertNoForbiddenPayload({ notes: new Uint8Array([1, 2, 3]) }))
      .toThrow(OutboxError)
    expect(() => assertNoForbiddenPayload({ notes: new ArrayBuffer(8) })).toThrow(OutboxError)
  })

  it('refuses an object URL under an innocent name', () => {
    expect(() => assertNoForbiddenPayload({ href: 'blob:https://app.test/abc' })).toThrow(OutboxError)
  })

  it('accepts a plain final segment', () => {
    expect(() => assertNoForbiddenPayload({ ...segment(1) })).not.toThrow()
  })

  it('does not mistake ordinary text for a payload', () => {
    // `text` is the whole point of the store. A check that rejected long text would break the feature.
    expect(() => assertNoForbiddenPayload({ ...segment(1), text: 'x'.repeat(1_500) })).not.toThrow()
  })
})

describe('acknowledgement', () => {
  it('deletes what the server confirmed and keeps the rest', async () => {
    const outbox = await open()
    await outbox!.enqueue([segment(1), segment(2), segment(3)])
    await outbox!.acknowledge(['req:0:1', 'req:0:3'])
    expect((await outbox!.pending()).map((entry) => entry.sequence)).toEqual([2])
  })

  it('treats a duplicate acknowledgement as a no-op', async () => {
    const outbox = await open()
    await outbox!.enqueue([segment(1)])
    await outbox!.acknowledge(['req:0:1'])
    // The server's response lists every id it accepted, including ones it already had — so a second
    // acknowledgement of the same id is the normal case, not an anomaly.
    await expect(outbox!.acknowledge(['req:0:1'])).resolves.toBe(0)
    expect(await outbox!.pending()).toHaveLength(0)
  })

  it('ignores an id that was never enqueued', async () => {
    const outbox = await open()
    await expect(outbox!.acknowledge(['req:0:99'])).resolves.toBe(0)
  })

  it('empties the store during a healthy interview', async () => {
    const outbox = await open()
    for (let n = 1; n <= 5; n += 1) {
      await outbox!.enqueue([segment(n)])
      await outbox!.acknowledge([`req:0:${n}`])
    }
    // The steady state. A store that accumulated during a normal session would be retaining a
    // candidate's words for no reason at all.
    expect(await outbox!.pending()).toHaveLength(0)
  })
})

describe('a reload, an outage, and a reconnect', () => {
  it('survives a close and reopen with the segments still pending', async () => {
    const first = await open()
    await first!.enqueue([segment(1), segment(2)])
    first!.close()

    // What a page refresh does mid-interview.
    const second = await open()
    expect((await second!.pending()).map((entry) => entry.sequence)).toEqual([1, 2])
  })

  it('accumulates through an outage and drains on reconnect', async () => {
    const outbox = await open()
    // Offline: sends fail, so nothing is acknowledged and everything stays queued.
    for (let n = 1; n <= 4; n += 1) await outbox!.enqueue([segment(n)])
    expect(await outbox!.pending()).toHaveLength(4)

    // Reconnected: the server accepts the whole backlog in one batch.
    const pending = await outbox!.pending()
    await outbox!.acknowledge(pending.map((entry) => entry.providerSegmentId))
    expect(await outbox!.pending()).toHaveLength(0)
  })

  it("keeps a second session's backlog separate", async () => {
    const one = await open(USER_A, SESSION_1)
    const two = await open(USER_A, SESSION_2)
    await one!.enqueue([segment(1)])
    await two!.enqueue([segment(2)])

    expect((await one!.pending()).map((entry) => entry.sequence)).toEqual([1])
    expect((await two!.pending()).map((entry) => entry.sequence)).toEqual([2])
  })
})

describe('cross-user separation', () => {
  it('shows one user nothing of another\'s interview', async () => {
    const a = await open(USER_A, SESSION_1)
    await a!.enqueue([segment(1), segment(2)])

    // A shared office machine. The next organizer signs in on the same browser profile.
    const b = await open(USER_B, SESSION_1)
    expect(await b!.pending()).toEqual([])
  })

  it('does not let one user acknowledge away another\'s record', async () => {
    const a = await open(USER_A, SESSION_1)
    await a!.enqueue([segment(1)])
    const b = await open(USER_B, SESSION_1)

    // The same provider segment id, a different user. The key is scoped, so this deletes nothing.
    await b!.acknowledge(['req:0:1'])
    expect(await a!.pending()).toHaveLength(1)
  })

  it('does not let one user\'s record overwrite another\'s on the same interview', async () => {
    // Two organizers with access to one interview, signing in on the same shared machine — which
    // `event_participants` makes a designed case, not an accident. Same session id, same provider segment
    // id, different users.
    //
    // Without the user in the primary key this is a silent `put` overwrite: B's record replaces A's,
    // carries B's userId, and A's next read returns nothing at all. A loses a pending segment and there
    // is no error anywhere. The user-scoped *read* cannot save this — the row is gone.
    const a = await open(USER_A, SESSION_1)
    const b = await open(USER_B, SESSION_1)
    await a!.enqueue([segment(1, { text: 'A said this.' })])
    await b!.enqueue([segment(1, { text: 'B said this.' })])

    const aPending = await a!.pending()
    expect(aPending).toHaveLength(1)
    expect(aPending[0].text).toBe('A said this.')
    const bPending = await b!.pending()
    expect(bPending).toHaveLength(1)
    expect(bPending[0].text).toBe('B said this.')
  })

  it('clears only the logging-out user on logout', async () => {
    const a = await open(USER_A, SESSION_1)
    const b = await open(USER_B, SESSION_2)
    await a!.enqueue([segment(1)])
    await b!.enqueue([segment(2)])

    await a!.clearForUser()
    expect(await a!.pending()).toHaveLength(0)
    // B's interview may still be running in another profile. One person's logout must not lose it.
    expect(await b!.pending()).toHaveLength(1)
  })

  it('clears every session belonging to the logging-out user', async () => {
    const one = await open(USER_A, SESSION_1)
    const two = await open(USER_A, SESSION_2)
    await one!.enqueue([segment(1)])
    await two!.enqueue([segment(2)])

    await one!.clearForUser()
    expect(await two!.pending()).toHaveLength(0)
  })
})

describe('finish and expiry cleanup', () => {
  it('clears the session when the interview finishes', async () => {
    const outbox = await open()
    await outbox!.enqueue([segment(1), segment(2)])
    await outbox!.clearSession()
    expect(await outbox!.pending()).toHaveLength(0)
  })

  it('leaves other sessions alone when one finishes', async () => {
    const one = await open(USER_A, SESSION_1)
    const two = await open(USER_A, SESSION_2)
    await one!.enqueue([segment(1)])
    await two!.enqueue([segment(2)])
    await one!.clearSession()
    expect(await two!.pending()).toHaveLength(1)
  })

  it('sweeps an expired record at open, before it can be resent', async () => {
    const first = await open()
    await first!.enqueue([segment(1)])
    first!.close()

    // Thirteen hours later. A laptop closed mid-interview and reopened the next day.
    clock += OUTBOX_RECORD_TTL_MS + 60_000
    const second = await open()
    // Swept during `openTranscriptOutbox`, so a stale segment is deleted rather than resent into a
    // session that finished without it.
    expect(await second!.pending()).toHaveLength(0)
  })

  it('keeps a record that is not yet expired', async () => {
    const first = await open()
    await first!.enqueue([segment(1)])
    first!.close()

    clock += OUTBOX_RECORD_TTL_MS - 60_000
    const second = await open()
    expect(await second!.pending()).toHaveLength(1)
  })

  it('sweeps another user\'s abandoned records too', async () => {
    const a = await open(USER_A, SESSION_1)
    await a!.enqueue([segment(1)])
    a!.close()

    clock += OUTBOX_RECORD_TTL_MS + 1
    // Only a different user's visit will ever collect a record belonging to someone who never came back.
    const b = await open(USER_B, SESSION_2)
    expect(await b!.sweepExpired()).toBe(0)
    const aAgain = await open(USER_A, SESSION_1)
    expect(await aAgain!.pending()).toHaveLength(0)
  })

  it('reports how many it swept', async () => {
    const outbox = await open()
    await outbox!.enqueue([segment(1), segment(2), segment(3)])
    clock += OUTBOX_RECORD_TTL_MS + 1
    expect(await outbox!.sweepExpired()).toBe(3)
  })
})

describe('when storage is unavailable or full', () => {
  it('returns null rather than failing when IndexedDB is absent', async () => {
    // Private browsing, a locked-down profile, a server render. An interview that cannot buffer is still
    // an interview; refusing to start one because a storage API is missing would be worse.
    //
    // The global has to go, not the option: an omitted `factory` means "use the browser's", which is
    // exactly what the default does. Passing `undefined` tested nothing.
    const real = globalThis.indexedDB
    // Deleting the global is the only way to model a browser that has no IndexedDB at all.
    delete (globalThis as { indexedDB?: unknown }).indexedDB
    try {
      expect(await openTranscriptOutbox({ userId: USER_A, sessionId: SESSION_1, now })).toBeNull()
    } finally {
      ;(globalThis as { indexedDB: IDBFactory }).indexedDB = real as IDBFactory
    }
  })

  it('returns null when opening the database fails', async () => {
    const failing = {
      open: () => {
        const request = { onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null } as Record<string, unknown>
        setTimeout(() => {
          request.error = new DOMException('corrupt', 'UnknownError')
          ;(request.onerror as (() => void) | null)?.()
        }, 0)
        return request
      },
    } as unknown as IDBFactory
    expect(await openTranscriptOutbox({ userId: USER_A, sessionId: SESSION_1, factory: failing, now })).toBeNull()
  })

  it('reports a quota failure as quota_exceeded, not a generic failure', async () => {
    const outbox = await open()
    // A browser out of space throws `QuotaExceededError` from the write itself. Patched on the prototype
    // rather than by racing an abort event, so the failure is deterministic instead of depending on
    // whether `oncomplete` beats a timer.
    const realPut = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function put() {
      throw new DOMException('out of space', 'QuotaExceededError')
    } as typeof realPut
    try {
      await expect(outbox!.enqueue([segment(1)])).rejects.toMatchObject({ code: 'quota_exceeded' })
    } finally {
      IDBObjectStore.prototype.put = realPut
    }
  })

  it('does not report a stored segment when the transaction aborts', async () => {
    const outbox = await open()
    // The subtler shape of the same failure: every `put` succeeds and the transaction then aborts.
    // Resolving after the last `put` instead of on `oncomplete` would call this stored.
    const database = (outbox as unknown as { database: IDBDatabase }).database
    const realTransaction = database.transaction.bind(database)
    Object.defineProperty(database, 'transaction', {
      configurable: true,
      value: (...args: Parameters<typeof realTransaction>) => {
        const transaction = realTransaction(...args)
        if (args[1] === 'readwrite') queueMicrotask(() => transaction.abort())
        return transaction
      },
    })
    try {
      await expect(outbox!.enqueue([segment(9)])).rejects.toBeInstanceOf(OutboxError)
    } finally {
      Object.defineProperty(database, 'transaction', { configurable: true, value: realTransaction })
    }
    expect(await outbox!.pending()).toHaveLength(0)
  })
})
