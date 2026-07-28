/**
 * The browser-side outbox for final transcript text (plan:
 * calendar-scheduling-interview-intelligence, Phase 9).
 *
 * ## What it stores, and the much longer list of what it does not
 *
 * One record per *unacknowledged final* segment: the provider's segment id, a sequence, a speaker
 * estimate, the text, and its timing. That is the minimum needed to resend a segment the server has not
 * confirmed.
 *
 * It never stores audio — no blob, no object URL, no media reference. It never stores interim text, which
 * is replaced within seconds and would multiply a candidate's words several times over for nothing. And a
 * record is deleted the moment the server acknowledges it, so the steady state of this store during a
 * healthy interview is *empty*.
 *
 * `assertNoForbiddenPayload` is exported as the guarantee rather than kept private, so a future change
 * that added a field cannot quietly widen what a candidate's browser retains.
 *
 * ## Why a store at all, when the server is the record
 *
 * A reload, a dropped connection, or a laptop lid closing mid-interview loses whatever was in memory. The
 * words a candidate said in the twenty seconds before that are not recoverable from anywhere else — the
 * provider stream is gone and the server never received them. So the outbox exists for exactly the window
 * between "the provider gave us final text" and "the server confirmed it".
 *
 * ## Keyed by session *and* user
 *
 * A shared machine is normal in an office. Keying on the session alone would let the next organizer's
 * client find, resend and display segments from someone else's interview, which is a confidentiality
 * failure rather than a bug. Every read is filtered on both, and `clearForUser` on logout is what makes
 * "the previous person's interview" unreachable rather than merely unshown.
 *
 * ## Retention is enforced on the next visit, not by a timer
 *
 * A timer does not run while the tab is closed, and the tab being closed is precisely the case where old
 * records linger. `sweepExpired` runs at open, before anything is read, so a record past its expiry is
 * deleted rather than resent.
 */

/** The store name. Bumping the database version is what triggers `onupgradeneeded`. */
const DATABASE_NAME = 'builderhunt-transcript-outbox'
const DATABASE_VERSION = 1
const STORE_NAME = 'pending-segments'

/**
 * How long an unacknowledged segment may sit before it is dropped.
 *
 * Twelve hours: long enough to survive a laptop closed overnight mid-interview and reopened in the
 * morning, short enough that a candidate's words are not sitting in a browser a week later. A segment this
 * old has almost certainly been superseded by a session that finished without it.
 */
export const OUTBOX_RECORD_TTL_MS = 12 * 60 * 60 * 1_000

/** The fields a record is allowed to carry. Anything else is a bug, and `assertNoForbiddenPayload` says so. */
export interface OutboxSegment {
  providerSegmentId: string
  sequence: number
  speakerEstimate: 'speaker_a' | 'speaker_b' | 'unknown'
  text: string
  startsMs: number
  endsMs: number
  confidence: number | null
}

interface OutboxRecord extends OutboxSegment {
  /** `${userId}:${sessionId}:${providerSegmentId}` — the primary key, and the cross-user separation. */
  key: string
  sessionId: string
  userId: string
  expiresAt: number
}

export class OutboxError extends Error {
  constructor(message: string, readonly code: 'unavailable' | 'quota_exceeded' | 'forbidden_payload' | 'failed') {
    super(message)
    this.name = 'OutboxError'
  }
}

/**
 * Field names that must never reach this store.
 *
 * Not a type-level check: a record arrives from a provider message parser, and a parser change could add
 * a field without anyone editing this file. This is the runtime line.
 */
const FORBIDDEN_FIELDS = Object.freeze([
  'audio', 'audioBlob', 'blob', 'objectUrl', 'objectKey', 'recording', 'recordingUrl',
  'mediaStream', 'buffer', 'arrayBuffer', 'interim', 'interimText', 'isFinal',
])

/**
 * Refuses a record carrying audio, a media reference, or interim text.
 *
 * `isFinal` is on the list for a reason that is not obvious: its presence means the caller is storing
 * provider messages rather than parsed finals, and the next such message will be an interim one.
 */
export function assertNoForbiddenPayload(segment: Record<string, unknown>): void {
  for (const field of FORBIDDEN_FIELDS) {
    if (field in segment) {
      throw new OutboxError(`the outbox refuses a '${field}' field`, 'forbidden_payload')
    }
  }
  for (const [key, value] of Object.entries(segment)) {
    // A Blob, ArrayBuffer or MediaStream under an innocent name. The field list catches the obvious
    // spellings; this catches the shape regardless of what it was called.
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      throw new OutboxError(`the outbox refuses binary data in '${key}'`, 'forbidden_payload')
    }
    if (typeof Blob !== 'undefined' && value instanceof Blob) {
      throw new OutboxError(`the outbox refuses a Blob in '${key}'`, 'forbidden_payload')
    }
    if (typeof value === 'string' && value.startsWith('blob:')) {
      throw new OutboxError(`the outbox refuses an object URL in '${key}'`, 'forbidden_payload')
    }
  }
}

export interface TranscriptOutboxOptions {
  userId: string
  sessionId: string
  /** Injectable so a test can supply a failing factory; defaults to the browser's. */
  factory?: IDBFactory
  /** Injectable so expiry is testable without waiting twelve hours. */
  now?: () => number
}

/**
 * Opens the outbox for one user's session.
 *
 * Returns null when IndexedDB is unavailable — private browsing, a locked-down profile, a
 * server-side render. A null outbox means "no durability", which the caller degrades to rather than
 * failing: an interview that cannot buffer is still an interview, and refusing to start one because a
 * storage API is missing would be a worse product than losing a reconnect window.
 */
export async function openTranscriptOutbox(options: TranscriptOutboxOptions): Promise<TranscriptOutbox | null> {
  const factory = options.factory ?? (typeof indexedDB === 'undefined' ? null : indexedDB)
  if (!factory) return null

  let database: IDBDatabase
  try {
    database = await openDatabase(factory)
  } catch {
    // A blocked or corrupt database is the same answer as an absent one: no durability, carry on.
    return null
  }

  const outbox = new TranscriptOutbox(database, options.userId, options.sessionId, options.now ?? Date.now)
  // Before anything is read, so an expired record is deleted rather than resent. A timer cannot do this:
  // it does not run while the tab is closed, which is the case that produces stale records.
  await outbox.sweepExpired()
  return outbox
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: 'key' })
        // Indexed together: every read is scoped to one user's one session, and an index on the session
        // alone would make the cross-user filter a post-hoc `.filter()` that a future refactor could drop.
        store.createIndex('by_user_session', ['userId', 'sessionId'])
        store.createIndex('by_expiry', 'expiresAt')
        store.createIndex('by_user', 'userId')
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('indexeddb open failed'))
    request.onblocked = () => reject(new Error('indexeddb open blocked'))
  })
}

export class TranscriptOutbox {
  constructor(
    private readonly database: IDBDatabase,
    private readonly userId: string,
    private readonly sessionId: string,
    private readonly now: () => number,
  ) {}

  private keyFor(providerSegmentId: string): string {
    return `${this.userId}:${this.sessionId}:${providerSegmentId}`
  }

  /**
   * Stores segments that have not yet been acknowledged.
   *
   * `put`, not `add`: re-enqueueing a segment already in the store is what happens when a send fails and
   * the caller retries, and treating that as a duplicate-key error would turn a normal retry into an
   * exception on the capture path.
   */
  async enqueue(segments: readonly OutboxSegment[]): Promise<void> {
    if (segments.length === 0) return
    for (const segment of segments) {
      assertNoForbiddenPayload(segment as unknown as Record<string, unknown>)
    }

    const expiresAt = this.now() + OUTBOX_RECORD_TTL_MS
    const records: OutboxRecord[] = segments.map((segment) => ({
      key: this.keyFor(segment.providerSegmentId),
      sessionId: this.sessionId,
      userId: this.userId,
      expiresAt,
      providerSegmentId: segment.providerSegmentId,
      sequence: segment.sequence,
      speakerEstimate: segment.speakerEstimate,
      text: segment.text,
      startsMs: segment.startsMs,
      endsMs: segment.endsMs,
      confidence: segment.confidence,
    }))

    await this.write((store) => {
      for (const record of records) store.put(record)
    })
  }

  /** Everything still waiting for this user's session, in sequence order. */
  async pending(): Promise<OutboxSegment[]> {
    const records = await this.read()
    return records
      .sort((a, b) => a.sequence - b.sequence)
      .map(({ key: _key, sessionId: _sessionId, userId: _userId, expiresAt: _expiresAt, ...segment }) => segment)
  }

  /**
   * Deletes the segments the server confirmed.
   *
   * Acknowledging an id that is not present is a no-op, not an error. The server's response lists every id
   * it accepted — including ones it already had from an earlier send — so a duplicate acknowledgement is
   * the normal case rather than an anomaly.
   */
  async acknowledge(providerSegmentIds: readonly string[]): Promise<number> {
    if (providerSegmentIds.length === 0) return 0

    // Read first, because `IDBObjectStore.delete` fires `onsuccess` whether or not the key existed —
    // counting delete callbacks would report a duplicate acknowledgement as having removed something. The
    // count is what tells a caller "this send was new" from "the server already had it", so a count that
    // is really an attempt tally is worse than none.
    const present = new Set((await this.read()).map((record) => record.key))
    const keys = providerSegmentIds
      // Scoped by `keyFor`, so one user's acknowledgement cannot reach another's record even when the
      // provider segment id matches.
      .map((id) => this.keyFor(id))
      .filter((key) => present.has(key))
    if (keys.length === 0) return 0

    await this.write((store) => {
      for (const key of keys) store.delete(key)
    })
    return keys.length
  }

  /** Everything for this session — what a finished or failed interview leaves behind. */
  async clearSession(): Promise<void> {
    const records = await this.read()
    await this.write((store) => {
      for (const record of records) store.delete(record.key)
    })
  }

  /**
   * Everything for this user, across every session.
   *
   * The logout path. Scoped to the user rather than clearing the store, because a shared machine may have
   * another organizer's records in it and destroying those on one person's logout would lose an interview
   * that is still running in another profile.
   */
  async clearForUser(): Promise<void> {
    const records = await this.allRecords()
    const mine = records.filter((record) => record.userId === this.userId)
    await this.write((store) => {
      for (const record of mine) store.delete(record.key)
    })
  }

  /**
   * Deletes records past their expiry, for every user.
   *
   * Deliberately not scoped to the current user: an abandoned record belonging to someone who never came
   * back is exactly what needs collecting, and only a *different* user's visit will ever run this.
   */
  async sweepExpired(): Promise<number> {
    const cutoff = this.now()
    const records = await this.allRecords()
    const stale = records.filter((record) => record.expiresAt <= cutoff)
    if (stale.length === 0) return 0
    await this.write((store) => {
      for (const record of stale) store.delete(record.key)
    })
    return stale.length
  }

  close(): void {
    this.database.close()
  }

  private read(): Promise<OutboxRecord[]> {
    return new Promise((resolve, reject) => {
      const transaction = this.database.transaction(STORE_NAME, 'readonly')
      const index = transaction.objectStore(STORE_NAME).index('by_user_session')
      // The compound key is the filter. A `getAll()` plus a `.filter()` would give the same answer today
      // and would silently start returning another user's segments the day someone removed the filter.
      const request = index.getAll(IDBKeyRange.only([this.userId, this.sessionId]))
      request.onsuccess = () => resolve(request.result as OutboxRecord[])
      request.onerror = () => reject(toOutboxError(request.error))
    })
  }

  private allRecords(): Promise<OutboxRecord[]> {
    return new Promise((resolve, reject) => {
      const transaction = this.database.transaction(STORE_NAME, 'readonly')
      const request = transaction.objectStore(STORE_NAME).getAll()
      request.onsuccess = () => resolve(request.result as OutboxRecord[])
      request.onerror = () => reject(toOutboxError(request.error))
    })
  }

  private write(work: (store: IDBObjectStore) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      let transaction: IDBTransaction
      try {
        transaction = this.database.transaction(STORE_NAME, 'readwrite')
      } catch (error) {
        reject(toOutboxError(error))
        return
      }
      // Resolve on `oncomplete`, not after the last `put`. A `put` that succeeds in a transaction that
      // then aborts — which is what a quota failure looks like — would otherwise be reported as stored.
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(toOutboxError(transaction.error))
      transaction.onerror = () => reject(toOutboxError(transaction.error))
      try {
        work(transaction.objectStore(STORE_NAME))
      } catch (error) {
        reject(toOutboxError(error))
      }
    })
  }
}

/**
 * Maps a storage failure to something the caller can act on.
 *
 * `QuotaExceededError` gets its own code because the response is different: there is no point retrying,
 * and the workspace should tell the organizer that buffering has stopped rather than silently losing the
 * reconnect window they think they have.
 */
function toOutboxError(error: unknown): OutboxError {
  const name = (error as { name?: unknown } | null)?.name
  if (name === 'QuotaExceededError') {
    return new OutboxError('the browser refused more storage for the transcript outbox', 'quota_exceeded')
  }
  if (error instanceof OutboxError) return error
  return new OutboxError(`the transcript outbox failed: ${typeof name === 'string' ? name : 'unknown'}`, 'failed')
}
