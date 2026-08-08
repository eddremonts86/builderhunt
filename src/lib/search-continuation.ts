import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

import { env } from '~/shared/lib/env'

/**
 * Signed continuations for search.
 *
 * `shared/lib/table/cursor.ts` is the keyset cursor for a SQL table: it carries the last row's
 * `ORDER BY` values so the next page is a tuple comparison. Search cannot use it. Keyword search is
 * a fan-out to third-party APIs that expose numeric pages and nothing else, and the local semantic
 * leg orders by a distance computed against a query vector rather than by stored column values.
 * Handing either of those to `buildKeysetPage` would mean inventing a guarantee neither backend
 * offers.
 *
 * So this is the same *construction* — base64url payload, HMAC-SHA256 over a versioned prefix,
 * `timingSafeEqual` — with a different payload and an honest name. The prefix differs from the
 * table cursor's, so neither token can ever be replayed as the other.
 *
 * ## Why it is signed at all
 *
 * The provider variant carries a page number and an offset, which look harmless until you notice
 * they are the two numbers that decide how much upstream work one request causes. Unsigned, a
 * client could ask for provider page 900 of fifteen connectors. The semantic variant is stronger
 * still: its key tuple goes straight into a `WHERE` comparison.
 *
 * ## What it deliberately does not carry
 *
 * No column names, in either variant. The semantic key is a fixed three-slot tuple whose meaning
 * — distance, then source, then source id — lives in this module's code, not in the token. A token
 * cannot name a column to sort or compare by, which is the property that makes the signature the
 * only thing standing between a client and a `WHERE`, rather than one of two.
 *
 * **Server only.** Reaches `node:crypto`; nothing that renders in a browser may import it. The
 * client holds a continuation as an opaque string and never inspects it.
 */

/** Bump when the payload shape changes: an old token then fails on the signature, not on a field. */
const PREFIX = 'builderhunt:search-continuation:v1:'

/**
 * How long a continuation stays usable.
 *
 * Deliberately short. The federated leg's own result cache lives five minutes
 * (`CACHE_TTL` in `search.ts`), so a continuation older than that is already resuming into a set
 * the server would have to re-fetch from upstream anyway. Fifteen minutes leaves room for a user
 * who scrolled, read something and came back, and refuses the tab left open overnight.
 */
export const SEARCH_CONTINUATION_TTL_MS = 15 * 60 * 1000

/**
 * Refuse anything longer than this before parsing it.
 *
 * A continuation is a handful of small fields; a legitimate one is a few hundred bytes. The cap is
 * checked first so a hostile caller cannot make the server base64-decode and JSON-parse a megabyte
 * to find out it was not signed. It also keeps the token inside the budget of a query parameter or
 * a request header, even though both endpoints carry it in a POST body today — the moment someone
 * puts it in a URL, this is what makes that safe rather than a discovery.
 */
export const SEARCH_CONTINUATION_MAX_LENGTH = 1024

/**
 * Which backend produced the page a continuation resumes.
 *
 * `keyword` and `keyword-fallback` are the same machinery reached two ways: the keyword endpoint,
 * and the semantic endpoint after an AI failure. They are separate values because the *mode* is
 * user-visible — the UI says which one answered — and a continuation minted while the query was
 * degrading must not be accepted once it stops degrading, or the user pages into a different
 * backend without the label changing.
 */
export type SearchContinuationMode = 'keyword' | 'semantic' | 'hybrid' | 'keyword-fallback'

/**
 * Federated paging state.
 *
 * `providerPage` is what every connector is asked for; `served` is how many rows of that page's
 * fused, deduped, ranked set have already been handed out. Two numbers rather than one because a
 * fan-out over N sources produces up to `N × providerPerPage` rows for a single provider page, so a
 * bounded response is a slice of that set — and the next slice usually needs no upstream request at
 * all.
 *
 * It is an offset, and calling it a cursor would be a lie. A provider that renumbers its pages
 * between requests shifts the whole set under it, which is exactly why the response says
 * `consistency: 'provider-best-effort'` instead of claiming keyset stability.
 */
export interface ProviderContinuation {
  kind: 'provider'
  /** 1-based, matching every connector's own convention. */
  providerPage: number
  /** Rows of the current provider page's fused set already served. Never negative. */
  served: number
}

/**
 * Local semantic paging state: the last row's position in the total order
 * `(distance, source, source_id)`.
 *
 * A true keyset, unlike the provider variant — the comparison is against values the database
 * produced, so a row inserted between pages either sorts after the boundary and appears, or sorts
 * before it and is skipped. Neither duplicates. What it is *not* is a guarantee that the same rows
 * would have been found: HNSW is approximate, and a filtered re-probe explores a fresh candidate
 * set. That is a property of the index, not of the cursor, and no cursor design fixes it.
 */
export interface SemanticContinuation {
  kind: 'semantic'
  /** Cosine distance of the last row served. */
  distance: number
  source: string
  sourceId: string
}

export type SearchContinuationState = ProviderContinuation | SemanticContinuation

interface SearchContinuationPayload {
  /** Payload version. Distinct from the prefix's version so a shape change can be diagnosed. */
  v: 1
  /** Mode this continuation resumes. */
  m: SearchContinuationMode
  /** `searchFingerprint` of the query and filters the page was produced under. */
  q: string
  /** Access scope: the organization id, or `'anon'` for a signed-out visitor. */
  a: string
  /** Keys of the sources actually contacted, sorted. An operator toggle invalidates the token. */
  s: string[]
  /** Expiry, epoch milliseconds. */
  x: number
  /** Backend-specific position. */
  c: SearchContinuationState
}

/** What the request being served right now is asking for. */
export interface SearchContinuationExpectation {
  /**
   * The mode, or the modes this endpoint is willing to resume.
   *
   * A list, because `/api/search/semantic` mints two: a `semantic` token when the local vector leg
   * answered, and a `hybrid` one when it degraded and the federation filled the page. Which of the
   * two a request is resuming is decided by the token's own signed state kind, not by anything the
   * client says — so the endpoint names both and dispatches on what comes back. It is still a real
   * check: a `keyword` or `keyword-fallback` token is in neither endpoint's list.
   */
  mode: SearchContinuationMode | readonly SearchContinuationMode[]
  /** `searchFingerprint` computed from the current request. */
  query: string
  scope: string
  /** The enabled-source snapshot resolved for the current request, in any order. */
  sources: readonly string[]
}

/** What a verified continuation says. */
export interface VerifiedSearchContinuation {
  /** The mode it was minted for — one of the modes the caller said it would accept. */
  mode: SearchContinuationMode
  state: SearchContinuationState
}

/**
 * A continuation the server refuses.
 *
 * 400 rather than 403, for `table/cursor.ts`'s reason: an unusable continuation is a malformed
 * request, and telling a caller whether it was forged or merely stale would tell them which of the
 * two they achieved. The client drops it and restarts at page one either way.
 */
export class SearchContinuationError extends Error {
  readonly status = 400

  constructor(reason: string) {
    super(`Invalid search continuation: ${reason}`)
    this.name = 'SearchContinuationError'
  }
}

/** Everything about a request that decides *which rows exist and in what order*. */
export interface SearchFingerprintInput {
  /** Keywords as sent, before any provider-side normalisation. */
  keywords: readonly string[]
  /** Sources the caller asked for — the filter, not the register's answer to it. */
  requestedSources?: readonly string[]
  language?: string
  country?: string
  /** Entity kinds, on the semantic leg. */
  entityKinds?: readonly string[]
  /**
   * Hex digest of the query vector, on the semantic leg.
   *
   * Binding the vector rather than only the text is strictly stronger: it catches an embedding
   * model or dimension change mid-session, where the text is identical but the ordering the cursor
   * resumes into no longer exists.
   */
  vectorHash?: string
}

/**
 * A short, stable digest of a search request's row-deciding inputs.
 *
 * Keywords are sorted before hashing, matching `cacheKey` in `search.ts`: the fan-out treats them
 * as a set, so `["rust","db"]` and `["db","rust"]` are the same search and must share a
 * fingerprint, or re-ordering a chip would invalidate a valid continuation. Sources and entity
 * kinds are sorted for the same reason. Language and country are not — they are single values.
 */
export function searchFingerprint(input: SearchFingerprintInput): string {
  const canonical = JSON.stringify({
    k: [...input.keywords].sort(),
    r: [...(input.requestedSources ?? [])].sort(),
    l: input.language ?? '',
    c: input.country ?? '',
    e: [...(input.entityKinds ?? [])].sort(),
    v: input.vectorHash ?? '',
  })
  return createHash('sha256').update(canonical).digest('base64url').slice(0, 16)
}

/** Digest of a query vector, for `SearchFingerprintInput.vectorHash`. */
export function queryVectorHash(vector: readonly number[]): string {
  return createHash('sha256').update(vector.join(',')).digest('base64url').slice(0, 16)
}

function signingSecret(override?: string): string {
  const secret = override ?? env.BETTER_AUTH_SECRET
  // Same reasoning as `table/cursor.ts`: a continuation is a short-lived token that is never stored
  // and carries no personal data, so it reuses the application signing secret rather than adding
  // another one to rotate.
  if (!secret) throw new Error('BETTER_AUTH_SECRET is required to sign search continuations')
  return secret
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(`${PREFIX}${payload}`).digest('base64url')
}

export interface CreateSearchContinuationInput {
  mode: SearchContinuationMode
  query: string
  scope: string
  sources: readonly string[]
  state: SearchContinuationState
}

/** Mint a continuation for the page just served. */
export function createSearchContinuation(
  input: CreateSearchContinuationInput,
  options: { secret?: string; now?: number } = {},
): string {
  const payload: SearchContinuationPayload = {
    v: 1,
    m: input.mode,
    q: input.query,
    a: input.scope,
    // Sorted at mint time so the comparison in `verify` is an equality on canonical forms rather
    // than a set comparison that has to be written twice.
    s: [...input.sources].sort(),
    x: (options.now ?? Date.now()) + SEARCH_CONTINUATION_TTL_MS,
    c: input.state,
  }
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const token = `${encoded}.${sign(encoded, signingSecret(options.secret))}`
  if (token.length > SEARCH_CONTINUATION_MAX_LENGTH) {
    // Not a client error — the server built this. Throwing rather than truncating means a future
    // state field that outgrows the budget fails here, in the code that added it, instead of
    // producing a token every caller is then told is invalid.
    throw new Error(`Search continuation exceeds ${SEARCH_CONTINUATION_MAX_LENGTH} bytes`)
  }
  return token
}

function parseState(value: unknown): SearchContinuationState {
  if (typeof value !== 'object' || value === null) throw new SearchContinuationError('missing state')
  const state = value as Record<string, unknown>

  if (state.kind === 'provider') {
    const { providerPage, served } = state
    if (!Number.isSafeInteger(providerPage) || (providerPage as number) < 1) {
      throw new SearchContinuationError('provider page is not a positive integer')
    }
    if (!Number.isSafeInteger(served) || (served as number) < 0) {
      throw new SearchContinuationError('served count is not a non-negative integer')
    }
    return { kind: 'provider', providerPage: providerPage as number, served: served as number }
  }

  if (state.kind === 'semantic') {
    const { distance, source, sourceId } = state
    // `Number.isFinite` and not `typeof === 'number'`: NaN compares false against everything, so a
    // NaN distance in a row-value predicate silently returns an empty page rather than an error.
    if (!Number.isFinite(distance)) throw new SearchContinuationError('distance is not a finite number')
    if (typeof source !== 'string' || source.length === 0) throw new SearchContinuationError('missing source')
    if (typeof sourceId !== 'string' || sourceId.length === 0) throw new SearchContinuationError('missing source id')
    return { kind: 'semantic', distance: distance as number, source, sourceId }
  }

  throw new SearchContinuationError('unknown state kind')
}

/**
 * Verify a continuation against what the current request is actually asking for.
 *
 * The signature proves this server minted it. Everything after that proves it was minted for *this*
 * question: same mode, same query and filters, same access scope, same set of sources. Each of
 * those is a way for a continuation to be honestly stale rather than forged, and each would resume
 * paging into an ordering the current request does not produce.
 */
export function verifySearchContinuation(
  token: string,
  expected: SearchContinuationExpectation,
  options: { secret?: string; now?: number } = {},
): VerifiedSearchContinuation {
  if (token.length > SEARCH_CONTINUATION_MAX_LENGTH) throw new SearchContinuationError('token too large')

  const [encoded, signature, extra] = token.split('.')
  if (!encoded || !signature || extra !== undefined) throw new SearchContinuationError('malformed token')

  const expectedSignature = Buffer.from(sign(encoded, signingSecret(options.secret)), 'base64url')
  const actualSignature = Buffer.from(signature, 'base64url')
  if (
    expectedSignature.length !== actualSignature.length
    || !timingSafeEqual(expectedSignature, actualSignature)
  ) throw new SearchContinuationError('signature mismatch')

  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch {
    throw new SearchContinuationError('payload is not JSON')
  }
  if (typeof decoded !== 'object' || decoded === null) throw new SearchContinuationError('payload is not an object')
  const payload = decoded as Record<string, unknown>

  if (payload.v !== 1) throw new SearchContinuationError('unsupported payload version')
  if (typeof payload.m !== 'string') throw new SearchContinuationError('missing mode')
  if (typeof payload.q !== 'string') throw new SearchContinuationError('missing query fingerprint')
  if (typeof payload.a !== 'string') throw new SearchContinuationError('missing access scope')
  if (!Array.isArray(payload.s) || payload.s.some((key) => typeof key !== 'string')) {
    throw new SearchContinuationError('missing source snapshot')
  }
  if (typeof payload.x !== 'number' || !Number.isFinite(payload.x)) throw new SearchContinuationError('missing expiry')

  if ((options.now ?? Date.now()) > payload.x) throw new SearchContinuationError('expired')
  const acceptedModes = Array.isArray(expected.mode) ? expected.mode : [expected.mode]
  if (!acceptedModes.includes(payload.m as SearchContinuationMode)) {
    throw new SearchContinuationError('mode mismatch')
  }
  if (payload.q !== expected.query) throw new SearchContinuationError('query or filter mismatch')
  if (payload.a !== expected.scope) throw new SearchContinuationError('access scope mismatch')

  const now = [...expected.sources].sort()
  const then = payload.s as string[]
  if (now.length !== then.length || now.some((key, index) => key !== then[index])) {
    throw new SearchContinuationError('source snapshot mismatch')
  }

  return { mode: payload.m as SearchContinuationMode, state: parseState(payload.c) }
}
