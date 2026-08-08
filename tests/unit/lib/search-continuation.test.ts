import { createHmac } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  createSearchContinuation,
  queryVectorHash,
  searchFingerprint,
  SEARCH_CONTINUATION_MAX_LENGTH,
  SEARCH_CONTINUATION_TTL_MS,
  SearchContinuationError,
  verifySearchContinuation,
  type CreateSearchContinuationInput,
  type SearchContinuationExpectation,
} from '~/lib/search-continuation'
import { IMPLEMENTED_SEARCH_CONNECTORS } from '~/shared/lib/search-connectors'

/**
 * Passed explicitly rather than read from `env`: unit tests run in happy-dom, where `env.ts`
 * returns its browser stub, so `env.BETTER_AUTH_SECRET` is not `process.env.BETTER_AUTH_SECRET`.
 */
const SECRET = 'a-test-secret-with-more-than-32-characters'
const OTHER_SECRET = 'a-different-secret-with-more-than-32-chars'

const NOW = 1_770_000_000_000

const FINGERPRINT = searchFingerprint({
  keywords: ['rust', 'databases'],
  requestedSources: ['github', 'hn'],
  country: 'DE',
})

const keywordInput: CreateSearchContinuationInput = {
  mode: 'keyword',
  query: FINGERPRINT,
  scope: 'org_alpha',
  sources: ['hn', 'github'],
  state: { kind: 'provider', providerPage: 1, served: 50 },
}

const keywordExpectation: SearchContinuationExpectation = {
  mode: 'keyword',
  query: FINGERPRINT,
  scope: 'org_alpha',
  sources: ['github', 'hn'],
}

function mint(
  input: Partial<CreateSearchContinuationInput> = {},
  now = NOW,
): string {
  return createSearchContinuation({ ...keywordInput, ...input }, { secret: SECRET, now })
}

function verify(
  token: string,
  expected: Partial<SearchContinuationExpectation> = {},
  now = NOW,
) {
  return verifySearchContinuation(token, { ...keywordExpectation, ...expected }, { secret: SECRET, now })
}

/** Re-sign a tampered payload with a secret the server does not use. */
function forge(payload: object, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = createHmac('sha256', secret)
    .update(`builderhunt:search-continuation:v1:${encoded}`)
    .digest('base64url')
  return `${encoded}.${signature}`
}

/** The exact payload the module mints, so a test can change one field and re-sign it properly. */
function payloadOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')) as Record<string, unknown>
}

describe('search continuations', () => {
  it('round-trips the provider state it minted', () => {
    expect(verify(mint())).toEqual({ kind: 'provider', providerPage: 1, served: 50 })
  })

  it('round-trips the semantic state it minted', () => {
    const token = mint({
      mode: 'semantic',
      state: { kind: 'semantic', distance: 0.1834, source: 'github', sourceId: 'octocat' },
    })
    expect(verify(token, { mode: 'semantic' })).toEqual({
      kind: 'semantic',
      distance: 0.1834,
      source: 'github',
      sourceId: 'octocat',
    })
  })

  /**
   * "Every active connector's shape" means the snapshot, not the page state: the fan-out asks every
   * connector for the same provider page (`searchBuildersWithStatus` passes one `page` to all of
   * them), so per-source page numbers would be a change to how the federation pages rather than a
   * property of the token. What *is* per-source is which sources answered, and that is what has to
   * survive a round trip — and what sets the token's worst-case size.
   */
  it('round-trips a snapshot holding every implemented connector', () => {
    const sources = [...IMPLEMENTED_SEARCH_CONNECTORS]
    const token = mint({ sources })
    expect(verify(token, { sources })).toEqual({ kind: 'provider', providerPage: 1, served: 50 })
  })

  it('accepts a source snapshot in any order', () => {
    // The snapshot is a set. A UI that re-orders source toggles must not invalidate a live token.
    expect(verify(mint({ sources: ['github', 'hn'] }), { sources: ['hn', 'github'] })).toBeTruthy()
  })

  it('stays well inside the token budget at the widest snapshot', () => {
    const token = mint({
      sources: [...IMPLEMENTED_SEARCH_CONNECTORS],
      state: { kind: 'semantic', distance: 0.123456789, source: 'stackoverflow', sourceId: 'a'.repeat(40) },
      mode: 'hybrid',
    })
    expect(token.length).toBeLessThan(SEARCH_CONTINUATION_MAX_LENGTH)
    // The conservative budget for a query parameter or a request header. Both endpoints carry the
    // continuation in a POST body today; this is what keeps a future move into the URL safe.
    expect(token.length).toBeLessThan(2048)
  })

  it('refuses a token longer than the cap before parsing it', () => {
    expect(() => verify('x'.repeat(SEARCH_CONTINUATION_MAX_LENGTH + 1))).toThrow(/token too large/)
  })

  it('refuses to mint a state that would exceed the cap', () => {
    expect(() => mint({
      state: { kind: 'semantic', distance: 0.5, source: 'github', sourceId: 'x'.repeat(SEARCH_CONTINUATION_MAX_LENGTH) },
    })).toThrow(/exceeds/)
  })

  it('refuses a token signed with another secret', () => {
    const token = forge(payloadOf(mint()), OTHER_SECRET)
    expect(() => verify(token)).toThrow(SearchContinuationError)
    expect(() => verify(token)).toThrow(/signature mismatch/)
  })

  it('refuses a payload edited without re-signing', () => {
    const [encoded, signature] = mint().split('.')
    const tampered = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>
    tampered.c = { kind: 'provider', providerPage: 900, served: 0 }
    const rewritten = Buffer.from(JSON.stringify(tampered)).toString('base64url')
    expect(() => verify(`${rewritten}.${signature}`)).toThrow(/signature mismatch/)
  })

  it.each([
    ['no dot', 'notatoken'],
    ['two dots', 'a.b.c'],
    ['empty signature', 'abc.'],
  ])('refuses a malformed token (%s)', (_label, token) => {
    expect(() => verify(token)).toThrow(/malformed token|signature mismatch/)
  })

  it('refuses a payload that is not JSON', () => {
    const encoded = Buffer.from('not json at all').toString('base64url')
    expect(() => verify(forge_raw(encoded))).toThrow(/payload is not JSON/)
  })

  function forge_raw(encoded: string): string {
    const signature = createHmac('sha256', SECRET)
      .update(`builderhunt:search-continuation:v1:${encoded}`)
      .digest('base64url')
    return `${encoded}.${signature}`
  }

  it('refuses an unsupported payload version', () => {
    expect(() => verify(forge({ ...payloadOf(mint()), v: 2 }, SECRET))).toThrow(/unsupported payload version/)
  })

  it('refuses an expired token', () => {
    const token = mint()
    expect(() => verify(token, {}, NOW + SEARCH_CONTINUATION_TTL_MS + 1)).toThrow(/expired/)
    // One millisecond earlier is still good — the boundary is inclusive, not "nearly expired".
    expect(verify(token, {}, NOW + SEARCH_CONTINUATION_TTL_MS)).toBeTruthy()
  })

  it('refuses a mode it was not minted for', () => {
    expect(() => verify(mint({ mode: 'keyword' }), { mode: 'semantic' })).toThrow(/mode mismatch/)
  })

  /**
   * The degradation case from the spec's resolved edge cases: a semantic query that fell back to
   * the federation mints a `keyword-fallback` continuation, and once the AI recovers the same
   * request is `semantic`. Accepting the old token would page a semantic view out of federated
   * results with the label saying otherwise.
   */
  it('refuses a keyword-fallback continuation once the query stops degrading', () => {
    const token = mint({ mode: 'keyword-fallback' })
    expect(() => verify(token, { mode: 'semantic' })).toThrow(/mode mismatch/)
  })

  it('refuses a different query', () => {
    const other = searchFingerprint({ keywords: ['rust'], requestedSources: ['github', 'hn'], country: 'DE' })
    expect(() => verify(mint(), { query: other })).toThrow(/query or filter mismatch/)
  })

  it('refuses a changed filter even when the keywords are identical', () => {
    const other = searchFingerprint({ keywords: ['rust', 'databases'], requestedSources: ['github', 'hn'], country: 'FR' })
    expect(() => verify(mint(), { query: other })).toThrow(/query or filter mismatch/)
  })

  it('refuses another access scope', () => {
    expect(() => verify(mint(), { scope: 'org_beta' })).toThrow(/access scope mismatch/)
  })

  it('refuses a token minted while signed in, presented anonymously', () => {
    expect(() => verify(mint({ scope: 'org_alpha' }), { scope: 'anon' })).toThrow(/access scope mismatch/)
  })

  it('refuses a snapshot that lost a source', () => {
    // An operator switched `hn` off between pages. Restarting at page one is the point: rows from a
    // withdrawn source must not be served out of a cache entry written while it was enabled.
    expect(() => verify(mint({ sources: ['github', 'hn'] }), { sources: ['github'] })).toThrow(/source snapshot mismatch/)
  })

  it('refuses a snapshot that gained a source', () => {
    expect(() => verify(mint({ sources: ['github'] }), { sources: ['github', 'hn'] })).toThrow(/source snapshot mismatch/)
  })

  it.each([
    ['a zero provider page', { kind: 'provider', providerPage: 0, served: 0 }, /provider page/],
    ['a negative provider page', { kind: 'provider', providerPage: -1, served: 0 }, /provider page/],
    ['a fractional provider page', { kind: 'provider', providerPage: 1.5, served: 0 }, /provider page/],
    ['a negative served count', { kind: 'provider', providerPage: 1, served: -1 }, /served count/],
    ['a NaN distance', { kind: 'semantic', distance: Number.NaN, source: 'github', sourceId: 'a' }, /finite/],
    ['an empty source', { kind: 'semantic', distance: 0.1, source: '', sourceId: 'a' }, /missing source/],
    ['an empty source id', { kind: 'semantic', distance: 0.1, source: 'github', sourceId: '' }, /missing source id/],
    ['an unknown kind', { kind: 'sql', distance: 0.1 }, /unknown state kind/],
  ])('refuses %s', (_label, state, message) => {
    expect(() => verify(forge({ ...payloadOf(mint()), c: state }, SECRET))).toThrow(message)
  })

  it.each([
    ['mode', 'm'],
    ['query fingerprint', 'q'],
    ['access scope', 'a'],
    ['source snapshot', 's'],
    ['expiry', 'x'],
    ['state', 'c'],
  ])('refuses a payload missing its %s', (_label, key) => {
    const payload = payloadOf(mint())
    delete payload[key]
    expect(() => verify(forge(payload, SECRET))).toThrow(SearchContinuationError)
  })

  /**
   * The property that makes the signature the only barrier rather than one of two: there is no
   * field a token could put a column name into. The semantic key is three fixed slots whose meaning
   * is this module's code.
   */
  it('carries no column names in either variant', () => {
    const provider = Object.keys(payloadOf(mint()).c as object)
    expect(provider.sort()).toEqual(['kind', 'providerPage', 'served'])

    const semantic = payloadOf(mint({
      mode: 'semantic',
      state: { kind: 'semantic', distance: 0.2, source: 'github', sourceId: 'octocat' },
    })).c as object
    expect(Object.keys(semantic).sort()).toEqual(['distance', 'kind', 'source', 'sourceId'])
  })

  it('cannot be replayed as a table cursor', async () => {
    const { verifyTableCursor } = await import('~/shared/lib/table/cursor')
    // Different HMAC prefix, so the same secret produces a different signature for the same bytes.
    expect(() => verifyTableCursor(
      mint(),
      { table: 'sprint_results', sort: 'id:asc', organizationId: 'org_alpha', query: 'x' },
      SECRET,
    )).toThrow(/signature mismatch/)
  })
})

describe('search fingerprints', () => {
  it('treats keywords as a set', () => {
    expect(searchFingerprint({ keywords: ['rust', 'db'] })).toBe(searchFingerprint({ keywords: ['db', 'rust'] }))
  })

  it('treats requested sources as a set', () => {
    expect(searchFingerprint({ keywords: ['a'], requestedSources: ['github', 'hn'] }))
      .toBe(searchFingerprint({ keywords: ['a'], requestedSources: ['hn', 'github'] }))
  })

  it.each([
    ['keywords', { keywords: ['b'] }],
    ['requested sources', { keywords: ['a'], requestedSources: ['github'] }],
    ['language', { keywords: ['a'], language: 'de' }],
    ['country', { keywords: ['a'], country: 'DE' }],
    ['entity kinds', { keywords: ['a'], entityKinds: ['human_profile'] }],
    ['vector hash', { keywords: ['a'], vectorHash: 'abc' }],
  ])('changes when the %s changes', (_label, input) => {
    expect(searchFingerprint(input)).not.toBe(searchFingerprint({ keywords: ['a'] }))
  })

  it('binds the query vector, not only its text', () => {
    // An embedding model change leaves the text identical and the ordering different — which is
    // exactly the case a text-only fingerprint would accept.
    const a = queryVectorHash([0.1, 0.2, 0.3])
    const b = queryVectorHash([0.1, 0.2, 0.4])
    expect(a).not.toBe(b)
    expect(searchFingerprint({ keywords: ['a'], vectorHash: a }))
      .not.toBe(searchFingerprint({ keywords: ['a'], vectorHash: b }))
  })
})
