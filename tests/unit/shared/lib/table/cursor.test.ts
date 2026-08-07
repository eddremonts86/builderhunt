import { createHmac } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  createTableCursor,
  queryFingerprint,
  sortDescriptor,
  TableCursorError,
  verifyTableCursor,
  type TableCursorPayload,
} from '~/shared/lib/table/cursor'

const SECRET = 'a-test-secret-with-more-than-32-characters'
const OTHER_SECRET = 'a-different-secret-with-more-than-32-chars'

const QUERY = { search: '', filters: { source: ['github'] } }

const payload: TableCursorPayload = {
  t: 'sprint_results',
  s: 'score:desc,id:asc',
  o: 'org_alpha',
  k: [42, 'result_7'],
  q: queryFingerprint(QUERY),
}

const expectation = {
  table: payload.t,
  sort: payload.s,
  organizationId: payload.o,
  query: payload.q,
}

describe('table cursors', () => {
  it('round-trips a payload it minted', () => {
    const token = createTableCursor(payload, SECRET)
    expect(verifyTableCursor(token, expectation, SECRET)).toEqual(payload)
  })

  it('carries null for a table that is not tenant-scoped', () => {
    const global = { ...payload, o: null }
    const token = createTableCursor(global, SECRET)
    expect(verifyTableCursor(token, { ...expectation, organizationId: null }, SECRET)).toEqual(global)
  })
})

describe('a cursor the server should refuse', () => {
  /**
   * The point of signing. Without it the key tuple is a client-supplied operand in a `WHERE`
   * clause — which is the injection surface the whole design exists to close.
   */
  it('rejects a tampered key tuple', () => {
    const token = createTableCursor(payload, SECRET)
    const [encoded, signature] = token.split('.')
    const decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as TableCursorPayload
    const tampered = Buffer.from(JSON.stringify({ ...decoded, k: [0, ''] })).toString('base64url')

    expect(() => verifyTableCursor(`${tampered}.${signature}`, expectation, SECRET))
      .toThrow(TableCursorError)
  })

  it('rejects a cursor minted for a different sort', () => {
    const token = createTableCursor({ ...payload, s: 'createdAt:desc,id:asc' }, SECRET)
    expect(() => verifyTableCursor(token, expectation, SECRET))
      .toThrow(/sort mismatch/)
  })

  /**
   * A tenant-scoped keyset cursor is a way to ask "what comes after this row". Accepting one from
   * another organization would answer that question about rows the caller cannot see, without any
   * of the row's data ever having left the server — which is what makes it easy to miss.
   */
  it('rejects a cursor minted for a different organization', () => {
    const token = createTableCursor({ ...payload, o: 'org_beta' }, SECRET)
    expect(() => verifyTableCursor(token, expectation, SECRET))
      .toThrow(/organization mismatch/)
  })

  /**
   * The bug this field exists to close.
   *
   * A cursor minted under one filter and presented under another used to be accepted, and the
   * keyset predicate then resumed from a row's position in an ordering the new filter does not
   * produce — so rows are skipped or repeated. No tenant boundary is crossed, which is why it
   * would have gone unnoticed.
   */
  it('rejects a cursor minted under a different filter', () => {
    const token = createTableCursor(payload, SECRET)
    const otherFilter = { ...expectation, query: queryFingerprint({ search: '', filters: { source: ['gitlab'] } }) }
    expect(() => verifyTableCursor(token, otherFilter, SECRET)).toThrow(/filter or search mismatch/)
  })

  it('rejects a cursor minted under a different search term', () => {
    const token = createTableCursor(payload, SECRET)
    const otherSearch = { ...expectation, query: queryFingerprint({ search: 'ada', filters: { source: ['github'] } }) }
    expect(() => verifyTableCursor(token, otherSearch, SECRET)).toThrow(/filter or search mismatch/)
  })

  it('rejects a cursor minted for a different table', () => {
    const token = createTableCursor({ ...payload, t: 'billing_disputes' }, SECRET)
    expect(() => verifyTableCursor(token, expectation, SECRET))
      .toThrow(/table mismatch/)
  })

  it('rejects a cursor signed with another secret', () => {
    const token = createTableCursor(payload, OTHER_SECRET)
    expect(() => verifyTableCursor(token, expectation, SECRET))
      .toThrow(/signature mismatch/)
  })

  /** A feed capability and a cursor share the HMAC construction; only the versioned prefix differs. That prefix is what stops one being replayed as the other. */
  it('rejects a token whose signature covers the payload without the cursor prefix', () => {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const feedStyle = createHmac('sha256', SECRET).update(`builderhunt:feed:v1:${encoded}`).digest('base64url')

    expect(() => verifyTableCursor(`${encoded}.${feedStyle}`, expectation, SECRET))
      .toThrow(/signature mismatch/)
  })

  it('rejects a malformed token', () => {
    expect(() => verifyTableCursor('nodot', expectation, SECRET)).toThrow(/malformed token/)
    expect(() => verifyTableCursor('a.b.c', expectation, SECRET)).toThrow(/malformed token/)
  })

  it('answers 400, not 403 — a forged cursor and a stale one are the same malformed request', () => {
    const token = createTableCursor({ ...payload, o: 'org_beta' }, SECRET)
    try {
      verifyTableCursor(token, expectation, SECRET)
      expect.unreachable('expected a TableCursorError')
    } catch (error) {
      expect(error).toBeInstanceOf(TableCursorError)
      expect((error as TableCursorError).status).toBe(400)
    }
  })
})

describe('queryFingerprint', () => {
  /** `filters[id]` is a set. Re-ordering chips must not invalidate a cursor that is still valid. */
  it('does not depend on the order of filter values or of dimensions', () => {
    expect(queryFingerprint({ search: 'x', filters: { a: ['1', '2'], b: ['3'] } }))
      .toBe(queryFingerprint({ search: 'x', filters: { b: ['3'], a: ['2', '1'] } }))
  })

  it('separates a different value, a different dimension and a different search', () => {
    const base = queryFingerprint({ search: '', filters: { a: ['1'] } })
    expect(queryFingerprint({ search: '', filters: { a: ['2'] } })).not.toBe(base)
    expect(queryFingerprint({ search: '', filters: { b: ['1'] } })).not.toBe(base)
    expect(queryFingerprint({ search: 'x', filters: { a: ['1'] } })).not.toBe(base)
  })

  it('ignores surrounding whitespace in the search term, as the query builder does', () => {
    expect(queryFingerprint({ search: '  ada  ', filters: {} }))
      .toBe(queryFingerprint({ search: 'ada', filters: {} }))
  })
})

describe('sortDescriptor', () => {
  it('is the string a cursor is bound to', () => {
    expect(sortDescriptor([{ id: 'score', dir: 'desc' }, { id: 'id', dir: 'asc' }]))
      .toBe('score:desc,id:asc')
  })
})
