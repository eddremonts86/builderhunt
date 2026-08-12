// table-surface: searchBuildersCapability
import * as React from 'react'
import {
  Search, X, Bookmark, ExternalLink, Code, Filter, Clock, Hash,
  TrendingUp, Save, Lightbulb, ChevronDown, Sparkles, RotateCcw, MapPin,
  Users, BookMarked, Star, GitFork, Loader2, Lock, Wand2,
} from 'lucide-react'
import { Link, useLocation, useSearch } from '@tanstack/react-router'
import { Input, Button, Dialog, ScoreRing, getScoreBreakdown } from '~/components/ui'
import { Tooltip } from '~/shared/components/Tooltip'
import { ai } from '~/shared/lib/ai/client'
import { AIUnavailableError } from '~/shared/lib/ai/errors'
import { useAICapabilities } from '~/shared/lib/ai/useAICapabilities'
import { BuilderResultActions } from '~/modules/search/components/BuilderResultActions'
import { DataTable, VIRTUALIZATION_THRESHOLD } from '~/shared/components/table/DataTable'
import { SEARCH_CARD_ROW_HEIGHT } from '~/shared/components/table/useTableVirtual'
import { resolveSafeBuilderFrom } from '~/shared/lib/safe-next'
import { SOURCE_PRESENTATION } from '~/shared/lib/source-presentation'
import type { ColumnDef } from '~/shared/lib/table/columns'
import type { PageResult, TableQuery } from '~/shared/lib/table/types'

/* -------------------------------------------------------------------------- */
/*  Types                                                                      */
/* -------------------------------------------------------------------------- */
type BuilderKind = 'person' | 'repo' | 'organization'

interface Builder {
  id: string
  kind: BuilderKind
  source: 'github' | 'reddit' | 'hn' | 'devto' | 'lobsters' | 'stackoverflow' | 'npm' | 'huggingface' | 'gitlab' | 'codeberg' | 'hashnode' | 'sourcehut' | 'devpost' | 'producthunt' | 'bluesky'
  sourceId: string
  username: string
  displayName?: string
  avatarUrl?: string
  bio?: string
  profileUrl: string
  followersCount?: number
  topics?: string[]
  score?: number
  lastSeen?: string
  language?: string
  country?: string
  metadata?: Record<string, unknown>
  tracked?: boolean
  trackedRowId?: string
  /** Present only on /api/search/semantic hits — a local (embedded) match's
   * cosine similarity to the query, 0..1. Renders in place of the score chip. */
  similarity?: number
}

/** Recency lives in `metadata.lastSeen` (a ms-epoch number set by each
 * source), not the unused top-level `lastSeen` string field. */
function getLastSeenMs(builder: Builder): number | null {
  const ms = builder.metadata?.lastSeen
  return typeof ms === 'number' ? ms : null
}

function formatRelativeDate(ms: number): string {
  const diff = Date.now() - ms
  const day = 24 * 60 * 60 * 1000
  if (diff < day) return 'today'
  if (diff < 2 * day) return 'yesterday'
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`
  if (diff < 30 * day) return `${Math.floor(diff / (7 * day))}w ago`
  if (diff < 365 * day) return `${Math.floor(diff / (30 * day))}mo ago`
  return `${Math.floor(diff / (365 * day))}y ago`
}

type Source = Builder['source']
type ResultTab = 'people' | 'resources'

/**
 * One source's outcome, as `SourceStatus` in `src/lib/search.ts` reports it.
 *
 * `disabled` and `unconfigured` are operator states rather than failures, and they are named
 * separately here for the same reason they are named separately there: folding them into "failed"
 * would tell a user something is broken when an operator switched a source off on purpose.
 */
interface SourceStatusView {
  source: string
  health: 'ok' | 'failed' | 'timeout' | 'disabled' | 'unconfigured'
  resultCount: number
  detail?: string
}

/** All supported sources. Visible in the source-pills UI. */
// `sourcehut` (drizzle/0143) and `hashnode` (drizzle/0144) are deliberately absent: both retired, so
// `resolveRequestedSources` refuses either key. The `Source` union above keeps them, because a stored result
// from before the retirement must still render.
const ALL_SOURCES: Source[] = ['github', 'reddit', 'hn', 'devto', 'lobsters', 'stackoverflow', 'npm', 'huggingface', 'gitlab', 'codeberg', 'devpost', 'producthunt', 'bluesky']
/** Sources that are ON by default. Niche sources are opt-in. */
const DEFAULT_ACTIVE_SOURCES: Source[] = ['github', 'reddit', 'hn', 'devto', 'lobsters']

// Sourced from the one exhaustive registry (src/shared/lib/source-presentation.ts) — kept in this
// file's own pre-existing `{label, color, Icon}` shape so none of this file's many call sites need
// to change, while removing this file's own copy of the label/icon/badge table.
const SOURCE_META: Record<Source, { label: string; color: string; Icon: React.ComponentType<{ className?: string; title?: string }> }> = Object.fromEntries(
  ALL_SOURCES.map((source) => {
    const presentation = SOURCE_PRESENTATION[source]
    return [source, { label: presentation.label, color: presentation.badgeClassName, Icon: presentation.Icon }]
  }),
) as Record<Source, { label: string; color: string; Icon: React.ComponentType<{ className?: string; title?: string }> }>


/* -------------------------------------------------------------------------- */
/*  Constants                                                                  */
/* -------------------------------------------------------------------------- */
const POPULAR_QUERIES = [
  { label: 'rust async runtime', emoji: '⚡' },
  { label: 'AI agents in production', emoji: '🤖' },
  { label: 'indie hackers in EU', emoji: '🚀' },
  { label: 'kubernetes operators', emoji: '☸️' },
  { label: 'svelte developers', emoji: '🔥' },
  { label: 'python ML engineers', emoji: '🧠' },
  { label: 'react performance', emoji: '⚛️' },
  { label: 'open source maintainers', emoji: '🛠️' },
]

const PRO_TIPS = [
  { icon: Hash, text: 'Combine 2-3 keywords for sharper results (e.g. "rust", "async", "tokio")' },
  { icon: Filter, text: 'Toggle the source pills above to narrow down to one platform' },
  { icon: Bookmark, text: 'Save searches to get alerts the moment a new builder shows up' },
]

const RECENT_KEY = 'builderhunt.recent_searches'
const MAX_RECENT = 5
/** Query used to fetch a real preview before the user has searched anything. */
const FEATURED_QUERY = 'open source maintainers'
/** Sources/location/language selection persists across visits. */
const FILTERS_KEY = 'builderhunt.search_filters'
/** Short connector words that substring-match almost anything (e.g. "con"
 * inside "container") — excluded from the results header's real-tag list so
 * natural-language queries don't surface noise like "y"/"con"/"the"/"and". */
const QUERY_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'you',
  'your', 'have', 'has', 'not', 'but', 'all', 'can', 'una', 'uno', 'los',
  'las', 'del', 'con', 'para', 'por', 'que', 'como', 'esta', 'este', 'y',
  'en', 'de', 'la', 'el', 'un',
])

/* -------------------------------------------------------------------------- */
/*  Shell adapter                                                              */
/* -------------------------------------------------------------------------- */

/**
 * One result, as the shell wants it: a `Record<string, unknown>` with a stable id.
 *
 * The builder is nested rather than spread so `id` cannot be shadowed by whatever a connector
 * happens to call a field, and so the card keeps taking exactly the object it always took.
 */
interface SearchRow extends Record<string, unknown> {
  id: string
  builder: Builder
}

/**
 * Height of one result row, in pixels.
 *
 * The shell's virtualizer measures nothing (see `DataTableProps.rowHeight`), so a card row has to
 * declare a height, and the card is clamped to it: the bio is already `line-clamp-2` and the meta
 * row is capped below. Fixed rather than measured is the trade plan 06 made deliberately —
 * variable heights are its own plan — and a uniform card list is a defensible thing to look at,
 * where a list that jumps at the hundredth row would not be.
 *
 * The number itself is the table system's `--tbl-row-height-search-card`, re-exported from
 * `useTableVirtual` — a specialized renderer's height rather than a fourth density, but a named
 * token rather than a `176` sitting in a surface file.
 */
const SEARCH_ROW_HEIGHT = SEARCH_CARD_ROW_HEIGHT

/**
 * The query the shell's toolbar is handed.
 *
 * Frozen, because every control that would change it lives elsewhere on this page and re-runs the
 * federation rather than re-viewing a set. Passing the page's real filter state here would put two
 * controls on screen for one input.
 */
const EMPTY_TABLE_QUERY: TableQuery = Object.freeze({ search: '', filters: {}, sort: [], groupBy: null })
const NO_TABLE_QUERY_CHANGE = () => {}

/** What a source that did not answer gets said about it, when the server sent no `detail`. */
const UNANSWERED_LABEL: Record<SourceStatusView['health'], string> = {
  ok: 'answered',
  failed: 'unavailable',
  timeout: 'took too long to answer',
  disabled: 'switched off by an operator',
  unconfigured: 'not configured on this deployment',
}

/* -------------------------------------------------------------------------- */
/*  Page                                                                       */
/* -------------------------------------------------------------------------- */
export function SearchPage() {
  const [query, setQuery] = React.useState('')
  const [location, setLocation] = React.useState('')
  const [language, setLanguage] = React.useState('')
  const [filtersOpen, setFiltersOpen] = React.useState(false)
  const [results, setResults] = React.useState<Builder[]>([])
  const [loading, setLoading] = React.useState(false)
  const [loadingMore, setLoadingMore] = React.useState(false)
  /**
   * The server's opaque continuation, or `null` when there is no further page.
   *
   * `page`/`hasMore` were here and are gone (plan 11). A page number meant the client decided how
   * deep to walk a federation, and `hasMore` came from a server flag that compared a cross-source
   * total against a per-source ask and was therefore true almost always.
   */
  const [cursor, setCursor] = React.useState<string | null>(null)
  /**
   * Per-source health from the last response.
   *
   * `/api/search/builders` has reported this since connector isolation landed and this page has
   * never read it, so a search where GitHub timed out looked exactly like a search where nobody
   * matched. That is the one thing the status exists to distinguish.
   */
  const [sourceStatuses, setSourceStatuses] = React.useState<SourceStatusView[]>([])
  const sentinelRef = React.useRef<HTMLDivElement>(null)
  const [searched, setSearched] = React.useState(false)
  // Read ?q= from URL on mount and auto-run the search
  const search = useSearch({ from: '/_dashboard/search/' })
  const initialQAppliedRef = React.useRef(false)
  React.useEffect(() => {
    if (initialQAppliedRef.current) return
    if (search.q && search.q.length >= 2) {
      initialQAppliedRef.current = true
      setQuery(search.q)
      // Defer to next tick so state is set
      // eslint-disable-next-line react-hooks/immutability -- runSearch is defined below but only invoked async after mount, once all bindings are initialized
      setTimeout(() => runSearch(search.q), 0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally run once on mount
  }, [])
  /**
   * A `?sources=` deep link (e.g. from Admin Integrations) decides the initial selection, not an effect.
   *
   * It used to be applied in a mount effect, which meant the persist effect below ran first — with the
   * five-source default still in state — and wrote *that* to `localStorage` before the re-render wrote the
   * requested source over it. Two writes per deep link, the first one wrong. A tab closed in that window left
   * the user's saved filters replaced by defaults, and it is what made
   * `admin-integrations.spec.ts` read `["github","reddit","hn","devto","lobsters"]` where the link said gitlab.
   *
   * A lazy initializer removes the window rather than narrowing it: the first render already has the right
   * value, so the first persist is the only persist. Route search params are available during render on both
   * server and client, so this stays hydration-safe — unlike `localStorage`, which is restored in an effect
   * below precisely because it is not.
   */
  const [activeSources, setActiveSources] = React.useState<Set<Source>>(() => {
    const requested = search.sources?.split(',').map((entry) => entry.trim()) ?? []
    const valid = requested.filter((entry): entry is Source => (ALL_SOURCES as string[]).includes(entry))
    return new Set(valid.length > 0 ? valid : DEFAULT_ACTIVE_SOURCES)
  })
  const [activeTab, setActiveTab] = React.useState<ResultTab>('people')
  const [recent, setRecent] = React.useState<string[]>([])
  const [showSave, setShowSave] = React.useState(false)
  const [saveName, setSaveName] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const [saveMsg, setSaveMsg] = React.useState<{ ok: boolean; text: string } | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [featured, setFeatured] = React.useState<Builder[]>([])

  /* Semantic search (Plan: semantic-search) — Pro/team feature, toggled
     via ?mode=semantic. `resultMode` reflects what the last response
     actually returned (semantic/hybrid/keyword-fallback), which can differ
     from the toggle itself (e.g. a cold index falls back to hybrid). */
  const [semanticMode, setSemanticMode] = React.useState(search.mode === 'semantic')
  const [resultMode, setResultMode] = React.useState<'semantic' | 'hybrid' | 'keyword-fallback' | null>(null)
  /** The real keywords a search actually matched on — the AI translation's
   * keywords in semantic mode, or the same whitespace/comma split the server
   * applies for keyword mode. Rendered in the results header instead of the
   * raw (possibly long, natural-language) query text. */
  const [matchedKeywords, setMatchedKeywords] = React.useState<string[]>([])
  const [plan, setPlan] = React.useState<'free' | 'pro' | 'team' | 'pro_max' | null>(null)
  // Distinguishes "we checked and you're on Free" from "we couldn't check because your
  // session isn't valid right now" — both fail closed to the same locked toggle, but the
  // action offered differs (Billing/Pricing vs. sign in again).
  const [planStaleSession, setPlanStaleSession] = React.useState(false)
  const routerLocation = useLocation()
  const aiCaps = useAICapabilities()
  // Semantic search is a paid feature (Pro, Pro Max, Team). Pro Max carries the
  // same semantic entitlement as Team; the server enforces the real gate, so
  // this flag only chooses between the live toggle and the upgrade nudge below.
  const semanticSearchAllowed = plan === 'pro' || plan === 'team' || plan === 'pro_max'

  React.useEffect(() => {
    fetch('/api/plans/me', { credentials: 'include' })
      .then((r) => {
        if (r.status === 401) {
          setPlanStaleSession(true)
          return null
        }
        return r.ok ? r.json() : null
      })
      .then((data: { plan?: { plan?: 'free' | 'pro' | 'team' | 'pro_max' } } | null) => {
        if (data?.plan?.plan) setPlan(data.plan.plan)
      })
      .catch(() => {})
  }, [])

  const toggleSemanticMode = () => {
    if (!semanticSearchAllowed) return
    const next = !semanticMode
    setSemanticMode(next)
    // Keeps the URL shareable/bookmarkable without fighting the router's
    // typed `from`/`search` inference for a purely cosmetic sync — the
    // actual re-search below is what matters functionally.
    try {
      const url = new URL(window.location.href)
      url.searchParams.set('mode', next ? 'semantic' : 'keyword')
      window.history.replaceState(null, '', url)
    } catch {
      // ignore
    }
    if (searched && query.trim()) runSearch(query)
  }

  const inputRef = React.useRef<HTMLInputElement>(null)

  /* Mount: preview a few real, live results before the user has typed
     anything — demonstrates real value instead of only showing tips. */
  React.useEffect(() => {
    fetch('/api/search/builders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keywords: FEATURED_QUERY, perPage: 6 }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { builders?: Builder[] } | null) => {
        const people = (data?.builders ?? []).filter((b) => b.kind === 'person')
        setFeatured(people.slice(0, 3))
      })
      .catch(() => {})
  }, [])

  /* Mount: load recent searches from localStorage */
  React.useEffect(() => {
    try {
      const stored = localStorage.getItem(RECENT_KEY)
      if (stored) setRecent(JSON.parse(stored))
    } catch {
      // ignore
    }
  }, [])

  /* Mount: restore sources/location/language from localStorage. A plain
     useState initializer would run during SSR (no localStorage there), so
     this loads post-mount instead — same pattern as recent searches above. */
  React.useEffect(() => {
    try {
      if (search.sources) return // a URL deep link already decided this above
      const stored = localStorage.getItem(FILTERS_KEY)
      if (!stored) return
      const parsed = JSON.parse(stored)
      if (Array.isArray(parsed.sources)) {
        const valid = parsed.sources.filter((s: unknown): s is Source => (ALL_SOURCES as string[]).includes(s as string))
        if (valid.length > 0) setActiveSources(new Set(valid))
      }
      if (typeof parsed.location === 'string') setLocation(parsed.location)
      if (typeof parsed.language === 'string') setLanguage(parsed.language)
    } catch {
      // ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally run once on mount
  }, [])

  /* Persist sources/location/language on every change so they apply to
     every future search (and survive a reload) without further plumbing —
     runSearch/loadMore/handleSaveSearch already read these same states. */
  React.useEffect(() => {
    try {
      localStorage.setItem(FILTERS_KEY, JSON.stringify({
        sources: Array.from(activeSources),
        location,
        language,
      }))
    } catch {
      // ignore
    }
  }, [activeSources, location, language])

  /* ⌘K / Ctrl+K to focus search */
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
      if (e.key === 'Escape' && document.activeElement === inputRef.current) {
        if (query) {
          setQuery('')
        } else {
          inputRef.current?.blur()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [query])

  /* Re-run search when active sources change (after first search) */
  const initialSourcesRef = React.useRef<string>('')
  React.useEffect(() => {
    const sig = Array.from(activeSources).sort().join(',')
    if (initialSourcesRef.current === '') {
      initialSourcesRef.current = sig
      return
    }
    if (initialSourcesRef.current !== sig && searched && query.trim() && activeSources.size > 0) {
      initialSourcesRef.current = sig
      runSearch(query)
    }
  }, [activeSources]) // eslint-disable-line react-hooks/exhaustive-deps

  /* Persist recent searches */
  const rememberSearch = React.useCallback((q: string) => {
    if (!q.trim()) return
    setRecent((prev) => {
      const next = [q, ...prev.filter((x) => x !== q)].slice(0, MAX_RECENT)
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(next))
      } catch {
        // ignore
      }
      return next
    })
  }, [])

  const clearRecent = () => {
    setRecent([])
    try {
      localStorage.removeItem(RECENT_KEY)
    } catch {
      // ignore
    }
  }

  /* Search */
  const handleSearch = async (e?: React.FormEvent) => {
    e?.preventDefault()
    const q = query.trim()
    if (!q || activeSources.size === 0) return
    await runSearch(q)
  }

  /** Runs the `query-translate` AI task (Chrome on-device first, MiniMax via
   * /api/ai/complete as fallback — see client.ts). Returns `undefined` on
   * any failure (disabled/budget/parse error); the server re-validates and
   * re-attempts server-side translation itself if this is omitted. */
  const getClientTranslation = async (q: string): Promise<unknown> => {
    try {
      const result = await ai('query-translate', { query: q })
      return result.output
    } catch (err) {
      if (!(err instanceof AIUnavailableError)) console.error('query-translate error:', err)
      return undefined
    }
  }

  const runSearch = async (q: string) => {
    setLoading(true)
    setSearched(true)
    setShowSave(false)
    setSaveMsg(null)
    setError(null)
    setCursor(null)
    setResultMode(null)
    setSourceStatuses([])
    rememberSearch(q)
    try {
      const endpoint = semanticMode ? '/api/search/semantic' : '/api/search/builders'
      const translated = semanticMode ? await getClientTranslation(q) : undefined
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          keywords: q,
          query: q,
          translated,
          sources: Array.from(activeSources),
          country: location.trim() || undefined,
          language: language.trim() || undefined,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error ?? `HTTP ${res.status}`)
      }
      const data = await res.json()
      setResults(data.builders ?? [])
      setCursor(data.nextCursor ?? null)
      // Absent on the semantic endpoint, which contacts no connector on its local leg.
      setSourceStatuses(Array.isArray(data.sources) ? data.sources : [])
      if (semanticMode && (data.mode === 'semantic' || data.mode === 'hybrid' || data.mode === 'keyword-fallback')) {
        setResultMode(data.mode)
      }
      // AI-translated keywords (semantic mode) are the actual filter that
      // was applied — real tags. Plain keyword mode has no such list; the
      // header derives real tags itself from what actually matched (see
      // `matchedKeywords` memo below), so this only needs the AI case.
      setMatchedKeywords(Array.isArray(data.translated?.keywords) ? (data.translated.keywords as string[]) : [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Search failed. Please try again.')
      setResults([])
      setCursor(null)
      setSourceStatuses([])
    } finally {
      setLoading(false)
    }
  }

  /**
   * Load the next page, resuming from the server's continuation.
   *
   * The request repeats the query and the filters because the server re-derives the fingerprint
   * from them and refuses the cursor if they no longer agree — which is what makes "changed the
   * filters, kept scrolling" a clean 400 and a restart rather than a page silently spliced out of
   * a different result set.
   */
  const loadMore = React.useCallback(async () => {
    if (loadingMore || !cursor || loading || !searched) return
    setLoadingMore(true)
    try {
      const endpoint = semanticMode ? '/api/search/semantic' : '/api/search/builders'
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          keywords: query,
          query,
          sources: Array.from(activeSources),
          country: location.trim() || undefined,
          language: language.trim() || undefined,
          cursor,
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const newOnes: Builder[] = data.builders ?? []
      // Dedupe by id. The keyset legs cannot repeat a row; the federated one is
      // `provider-best-effort` and an upstream that renumbers its pages between two requests can.
      setResults((prev) => {
        const seen = new Set(prev.map((b) => b.id))
        return [...prev, ...newOnes.filter((b) => !seen.has(b.id))]
      })
      setCursor(data.nextCursor ?? null)
    } catch {
      // Stop walking rather than retrying into the same failure. The rows already loaded stay on
      // screen — losing them would punish the user for the last page's problem.
      setCursor(null)
    } finally {
      setLoadingMore(false)
    }
  }, [loadingMore, cursor, loading, searched, query, activeSources, location, language, semanticMode])


  /* Split results by kind */
  const people = React.useMemo(() => results.filter((b) => b.kind === 'person'), [results])
  const resources = React.useMemo(() => results.filter((b) => b.kind !== 'person'), [results])

  /* Real tags for the results header (spec: never show the raw, possibly
   * long/natural-language query string). AI-translated keywords (semantic
   * mode) win when present; otherwise derive from what the query terms
   * actually matched across the returned results — filters out filler
   * words a naive whitespace split would otherwise show. */
  const displayKeywords = React.useMemo(() => {
    if (matchedKeywords.length > 0) return matchedKeywords
    const queryTerms = query.toLowerCase().split(/[,\s]+/).filter((t) => t.length > 2 && !QUERY_STOPWORDS.has(t))
    if (queryTerms.length === 0 || results.length === 0) return []
    const found = new Set<string>()
    for (const b of results) {
      for (const term of getMatchHighlights(b, query).terms) found.add(term)
    }
    return queryTerms.filter((t) => found.has(t))
  }, [matchedKeywords, query, results])

  /* Removing a single matched tag re-runs the search with the remaining
   * tags joined as the new query. This works the same way in both modes:
   * semantic tags are AI-translated terms that may not appear verbatim in
   * the original natural-language query (so stripping substrings out of
   * `query` wouldn't work), while keyword-mode tags already are the real
   * query terms. Removing the last tag clears back to the landing state. */
  const handleRemoveKeyword = (keyword: string) => {
    const remaining = displayKeywords.filter((k) => k !== keyword)
    if (remaining.length === 0) {
      setQuery('')
      setMatchedKeywords([])
      setSearched(false)
      setResults([])
      return
    }
    const nextQuery = remaining.join(' ')
    setQuery(nextQuery)
    setMatchedKeywords(remaining)
    runSearch(nextQuery)
  }

  /**
   * The active tab's results, in the order the server returned them.
   *
   * There was a `.sort()` here, driven by a "Best match / Most recent / Most followers" menu, and
   * all three re-ordered the rows this browser happened to hold. That was never a sort of the
   * result set: with up to `sources × 30` rows arriving per request and infinite scroll appending
   * more, "most followers" meant "the most-followed of what has loaded so far" and changed meaning
   * every time the user scrolled. Neither backend can sort globally — the federation would have to
   * exhaust thirteen upstreams, and the vector leg's order *is* the relevance — so the menu is gone
   * rather than reimplemented (`searchBuildersCapability.sorts` is empty and says why).
   *
   * The tab split stays: it partitions the loaded rows by kind, which is a different claim from
   * ordering them, and the counts beside it say `loaded` for exactly that reason.
   */
  const visible = React.useMemo(
    () => (activeTab === 'people' ? people : resources),
    [people, resources, activeTab],
  )

  /** Sources that were requested and did not contribute — for whatever reason, each named. */
  const unansweredSources = React.useMemo(
    () => sourceStatuses.filter((status) => status.health !== 'ok'),
    [sourceStatuses],
  )

  /**
   * Infinite scroll, for as long as the grid scrolls with the page.
   *
   * Once the shell windows the rows it becomes its own `overflow-y: auto` box, the page stops
   * scrolling, and this sentinel — which sits *below* that box — is permanently in view. Left
   * observing, it would ask for every remaining page in a row. Above the threshold the shell's own
   * container scroll takes over through `onLoadMore`, so the two never both drive it.
   */
  const gridIsWindowed = visible.length > VIRTUALIZATION_THRESHOLD
  React.useEffect(() => {
    const el = sentinelRef.current
    if (!el || gridIsWindowed) return
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) loadMore()
        }
      },
      { rootMargin: '200px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [loadMore, gridIsWindowed])


  /* Source toggle — individual clicks can't reduce to zero (that would
     silently break Search); "Clear all" below is the deliberate way to
     start a custom selection from scratch. */
  const toggleSource = (s: Source) => {
    setActiveSources((prev) => {
      const next = new Set(prev)
      if (next.has(s)) {
        if (next.size === 1) return prev
        next.delete(s)
      } else {
        next.add(s)
      }
      return next
    })
  }

  const isDefaultSourceSet =
    activeSources.size === DEFAULT_ACTIVE_SOURCES.length &&
    DEFAULT_ACTIVE_SOURCES.every((s) => activeSources.has(s))
  const filtersActiveCount =
    (isDefaultSourceSet ? 0 : 1) + (location.trim() ? 1 : 0) + (language.trim() ? 1 : 0)

  const resetFilters = () => {
    setActiveSources(new Set(DEFAULT_ACTIVE_SOURCES))
    setLocation('')
    setLanguage('')
  }

  /* Save search */
  const handleSaveSearch = async () => {
    if (!saveName.trim() || !query.trim()) return
    setSaving(true)
    setSaveMsg(null)
    try {
      const keywords = query.split(/[,\s]+/).filter(Boolean)
      const res = await fetch('/api/queries', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: saveName,
          keywords,
          sources: Array.from(activeSources),
          country: location.trim() || undefined,
          language: language.trim() || undefined,
        }),
      })
      if (res.ok) {
        setSaveMsg({ ok: true, text: 'Search saved! You\'ll get alerts when new matches appear.' })
        setSaveName('')
        setShowSave(false)
        setTimeout(() => setSaveMsg(null), 4000)
      } else {
        const err = await res.json().catch(() => ({}))
        setSaveMsg({ ok: false, text: err.error ?? 'Failed to save. Make sure you are signed in.' })
      }
    } catch {
      setSaveMsg({ ok: false, text: 'Failed to save search.' })
    } finally {
      setSaving(false)
    }
  }

  /* Track a builder — actual request/error/loading state now lives in the shared
     BuilderResultActions contract; this only reconciles the two local result arrays once it
     succeeds, since a card can come from either `results` or the pre-search `featured` list. */
  const handleTracked = React.useCallback((builderId: string, organizationBuilderId: string) => {
    const patch = (b: Builder) => (b.id === builderId ? { ...b, tracked: true, trackedRowId: organizationBuilderId } : b)
    setResults((prev) => prev.map(patch))
    setFeatured((prev) => prev.map(patch))
  }, [])

  /**
   * Changing what is being searched discards what was found.
   *
   * Sources, country, language and the semantic toggle are all bound into the continuation's
   * fingerprint or its source snapshot, so keeping the cursor across a change would earn a 400 on
   * the next scroll. Worse than the 400 is the alternative: rows from the old query sitting above
   * rows from the new one under a single heading, with nothing to say they answer different
   * questions.
   *
   * The query *text* is not here on purpose — it changes on every keystroke, and clearing results
   * as someone types would empty the page they are reading. `runSearch` resets on submit instead.
   */
  const searchInputsSignature = `${Array.from(activeSources).sort().join(',')}|${location.trim()}|${language.trim()}|${semanticMode}`
  const lastSignature = React.useRef(searchInputsSignature)
  React.useEffect(() => {
    if (lastSignature.current === searchInputsSignature) return
    lastSignature.current = searchInputsSignature
    setResults([])
    setCursor(null)
    setResultMode(null)
    setSourceStatuses([])
    setSearched(false)
  }, [searchInputsSignature])

  /**
   * The loaded rows as a `PageResult`.
   *
   * `total` is `null` and `nextCursor` is the server's own, so `aria-rowcount` announces -1 rather
   * than the loaded count. That is the honest answer here and the reason `PageResult.total` became
   * nullable: neither backend can count without exhausting itself.
   */
  const resultPage = React.useMemo<PageResult<SearchRow>>(() => ({
    rows: visible.map((builder) => ({ id: `${builder.source}-${builder.id}`, builder })),
    nextCursor: cursor,
    total: null,
    facets: {},
    consistency: semanticMode && resultMode === 'semantic' ? 'approximate' : 'provider-best-effort',
  }), [visible, cursor, semanticMode, resultMode])

  /**
   * One column, because the row *is* the card.
   *
   * `priority: 'primary'` so the stacked renderer keeps it below `md` rather than dropping it, and
   * nothing else competes for the width.
   */
  const resultColumns = React.useMemo<ColumnDef<SearchRow>[]>(() => [{
    id: 'result',
    header: 'Result',
    // The row *is* this cell, so it is the table's one flexible track — and the only one. Search
    // renders with `chrome="minimal"`, so there is no visible header for a fixed width to line up
    // under anyway.
    kind: 'primary',
    priority: 'primary',
    cell: (row) => (
      // `w-full`: the grid cell is a flex row, so a block child sizes to its content rather than
      // stretching, and the card came out ragged and half-width.
      <div className="w-full overflow-hidden" style={{ height: SEARCH_ROW_HEIGHT - 12 }}>
        <BuilderResultCard builder={row.builder} query={query} onTracked={handleTracked} />
      </div>
    ),
    value: (row) => row.builder.username,
  }], [query, handleTracked])

  /* ---------------------------------------------------------------------- */

  return (
    <div>
      {/* Header — collapses to just a small title once results are on screen,
          so a returning search doesn't repeat a full-height intro every time. */}
      <header className={searched ? 'mb-4' : 'mb-8'}>
        <h1 className={`font-bold tracking-tight ${searched ? 'text-xl md:text-2xl' : 'text-3xl md:text-4xl mb-2'}`}>
          Search builders
        </h1>
        {!searched && (
          <>
            <p className="text-bh-text-muted mb-4">
              Find active developers across {ALL_SOURCES.length} platforms — from GitHub commits to Hacker News threads.
            </p>
            <ul className="flex flex-wrap gap-1.5" aria-label="Supported sources">
              {ALL_SOURCES.map((s) => {
                const meta = SOURCE_META[s]
                return (
                  <li key={s}>
                    <span className="inline-flex items-center gap-1.5 pl-1.5 pr-2.5 py-1 rounded-full border border-bh-border bg-bh-surface text-xs font-medium text-bh-text-muted">
                      <meta.Icon className="w-3.5 h-3.5 shrink-0" title={meta.label} />
                      {meta.label}
                    </span>
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </header>

      {/* Search input + filters */}
      <form onSubmit={handleSearch} className="mb-6" role="search" aria-label="Search builders">
        {/* Below `sm`, the keyword input plus Search/semantic-toggle/filter-
            trigger siblings don't fit one row without squeezing typed text
            into a sliver — `flex-wrap` + a full-width-until-`sm` input lets
            the input claim its own row instead of shrinking. */}
        <div className="flex flex-wrap gap-2">
          <div className="relative min-w-full sm:min-w-0 sm:flex-1">
            <Search
              className="absolute left-5 top-1/2 -translate-y-1/2 w-5 h-5 text-bh-text-dim pointer-events-none"
              aria-hidden="true"
            />
            <Input
              ref={inputRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="e.g. rust async runtime, indie hackers, AI agents..."
              className="!pl-14 pr-32 py-3.5 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2"
              aria-label="Search keywords"
              autoComplete="off"
            />
            {query && (
              <button
                type="button"
                onClick={() => { setQuery(''); inputRef.current?.focus() }}
                className="absolute right-4 top-1/2 -translate-y-1/2 p-1 text-bh-text-dim hover:text-bh-text rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2"
                aria-label="Clear search"
              >
                <X className="w-4 h-4" />
              </button>
            )}
            {!query && (
              <kbd className="hidden sm:flex absolute right-4 top-1/2 -translate-y-1/2 items-center gap-1 px-2 py-0.5 rounded border border-bh-border bg-bh-bg-alt text-[10px] font-mono text-bh-text-dim">
                ⌘K
              </kbd>
            )}
          </div>
          <Button
            type="submit"
            disabled={loading || !query.trim() || activeSources.size === 0}
            loading={loading}
            size="md"
            className="px-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent"
          >
            {loading ? 'Searching' : 'Search'}
          </Button>

          {/* Semantic toggle (Plan: semantic-search) — hidden entirely when
              the AI platform is disabled or has no server tier configured;
              locked with a Pro pill until the plan is positively known to
              be pro/pro_max/team (fail-closed while /api/plans/me is loading, for
              anonymous visitors, and for free-plan users). */}
          {!aiCaps.disabled && aiCaps.serverAI && (
            <Tooltip
              label={
                semanticSearchAllowed
                  ? 'Semantic search — find builders by meaning, not just keywords'
                  : planStaleSession
                    ? 'Semantic search — sign in again to check your plan'
                    : 'Semantic search — a Pro feature. Opens Billing settings.'
              }
            >
              {semanticSearchAllowed ? (
                <button
                  type="button"
                  onClick={toggleSemanticMode}
                  aria-pressed={semanticMode}
                  aria-label="Toggle semantic search"
                  data-testid="semantic-toggle"
                  className={`relative shrink-0 w-11 h-11 rounded-full border flex items-center justify-center transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2 ${
                    semanticMode
                      ? 'bg-bh-accent-soft text-bh-accent border-bh-accent/30'
                      : 'bg-transparent text-bh-text-muted border-bh-border hover:border-bh-border-strong hover:text-bh-text'
                  }`}
                >
                  <Wand2 className="w-4 h-4" aria-hidden="true" />
                </button>
              ) : planStaleSession ? (
                <Link
                  to="/auth/sign-in"
                  search={{ redirect: routerLocation.pathname }}
                  className="relative shrink-0 w-11 h-11 rounded-full border border-bh-border bg-transparent text-bh-text-dim flex items-center justify-center hover:border-bh-border-strong hover:text-bh-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2"
                  aria-label="Semantic search — sign in again to check your plan"
                  data-testid="semantic-toggle-locked"
                >
                  <Wand2 className="w-4 h-4" aria-hidden="true" />
                  <Lock className="w-2.5 h-2.5 absolute -bottom-0.5 -right-0.5 bg-bh-bg-alt rounded-full p-0.5" aria-hidden="true" />
                </Link>
              ) : (
                <Link
                  to="/settings/billing"
                  className="relative shrink-0 w-11 h-11 rounded-full border border-bh-border bg-transparent text-bh-text-dim flex items-center justify-center hover:border-bh-border-strong hover:text-bh-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2"
                  aria-label="Semantic search — Pro feature, upgrade to unlock"
                  data-testid="semantic-toggle-locked"
                >
                  <Wand2 className="w-4 h-4" aria-hidden="true" />
                  <Lock className="w-2.5 h-2.5 absolute -bottom-0.5 -right-0.5 bg-bh-bg-alt rounded-full p-0.5" aria-hidden="true" />
                </Link>
              )}
            </Tooltip>
          )}

          {/* Sources & filters — compact trigger next to Search, opens a
              dialog instead of an inline panel so it stays out of the way
              and has room to grow (more filters later) without reflowing
              the page. */}
          <Tooltip label={`Sources & filters — ${activeSources.size} of ${ALL_SOURCES.length} sources${filtersActiveCount > 0 ? ', customized' : ''}`}>
            <button
              type="button"
              onClick={() => setFiltersOpen(true)}
              aria-haspopup="dialog"
              aria-label="Sources & filters"
              className={`relative shrink-0 w-11 h-11 rounded-full border flex items-center justify-center transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2 ${
                filtersActiveCount > 0
                  ? 'bg-bh-accent-soft text-bh-accent border-bh-accent/30'
                  : 'bg-transparent text-bh-text-muted border-bh-border hover:border-bh-border-strong hover:text-bh-text'
              }`}
            >
              <Filter className="w-4 h-4" aria-hidden="true" />
              {filtersActiveCount > 0 && (
                <span className="absolute -top-1 -right-1 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-bh-accent text-[color:var(--color-bh-accent-contrast)] text-[10px] font-bold">
                  {filtersActiveCount}
                </span>
              )}
            </button>
          </Tooltip>
        </div>

        <Dialog open={filtersOpen} onClose={() => setFiltersOpen(false)} title="Sources & filters">
          {/* Sources & filters — one unified control. Previously an
              always-expanded 12-pill row (6 rows on mobile) plus a separate
              Filters button/panel — merged into one dialog so the page
              isn't permanently occupied by controls most searches never
              touch, and there's room to add more filters later. */}
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-semibold text-bh-text-dim uppercase tracking-wider">
              Sources
            </span>
            <div className="flex items-center gap-3 text-xs">
              <button
                type="button"
                onClick={() => setActiveSources(new Set(ALL_SOURCES))}
                className="text-bh-text-dim hover:text-bh-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent rounded"
              >
                Select all
              </button>
              <button
                type="button"
                onClick={() => setActiveSources(new Set())}
                className="text-bh-text-dim hover:text-bh-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent rounded"
              >
                Clear all
              </button>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {ALL_SOURCES.map((s) => {
              const meta = SOURCE_META[s]
              const active = activeSources.has(s)
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => toggleSource(s)}
                  data-testid={`search-source-${s}`}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium border transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2 ${
                    active
                      ? 'bg-bh-accent-soft text-bh-accent border-bh-accent shadow-sm'
                      : 'bg-transparent text-bh-text-dim border-bh-border hover:border-bh-border-strong hover:text-bh-text-muted'
                  }`}
                  aria-pressed={active}
                >
                  <meta.Icon className="w-3.5 h-3.5" title={meta.label} />
                  {meta.label}
                </button>
              )
            })}
          </div>

          {activeSources.size === 0 && (
            <p className="text-xs text-bh-danger mt-2">
              Pick at least one source before searching.
            </p>
          )}

          <div className="grid sm:grid-cols-2 gap-3 mt-4 pt-4 border-t border-bh-border">
            <div>
              <label htmlFor="location-input" className="text-xs font-semibold uppercase tracking-wider text-bh-text-dim block mb-1.5">
                Location
              </label>
              <Input
                id="location-input"
                type="text"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="e.g. France, Spain, Brazil"
                className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2"
                autoComplete="off"
              />
              <p className="text-[10px] text-bh-text-dim mt-1 leading-snug">
                Only GitHub supports this. Other sources don't expose location.
              </p>
            </div>
            <div>
              <label htmlFor="language-input" className="text-xs font-semibold uppercase tracking-wider text-bh-text-dim block mb-1.5">
                Primary language
              </label>
              <Input
                id="language-input"
                type="text"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                placeholder="e.g. TypeScript, Rust, Go"
                className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2"
                autoComplete="off"
              />
              <p className="text-[10px] text-bh-text-dim mt-1 leading-snug">
                Only GitHub supports this. Other sources don't expose primary language.
              </p>
            </div>
          </div>

          <div className="flex justify-end mt-3 pt-3 border-t border-bh-border">
            <button
              type="button"
              onClick={resetFilters}
              className="text-xs text-bh-text-dim hover:text-bh-text inline-flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent rounded"
            >
              <RotateCcw className="w-3 h-3" aria-hidden="true" />
              Reset to defaults
            </button>
          </div>
        </Dialog>
      </form>

      {/* Inline save bar */}
      {showSave && (
        <div className="card flex flex-wrap items-center gap-3 mb-6 animate-fade-in-up">
          <Bookmark className="w-4 h-4 text-bh-warning shrink-0" aria-hidden="true" />
          <Input
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            placeholder="Name this search..."
            className="flex-1 min-w-[200px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2"
            autoFocus
            onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), handleSaveSearch())}
          />
          <Button onClick={handleSaveSearch} loading={saving} disabled={!saveName.trim()} size="sm" className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent">
            <Save className="w-4 h-4" /> Save
          </Button>
          <Button
            onClick={() => { setShowSave(false); setSaveName(''); setSaveMsg(null) }}
            variant="ghost"
            size="sm"
            aria-label="Cancel"
            className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent"
          >
            <X className="w-4 h-4" />
          </Button>
        </div>
      )}

      {saveMsg && (
        <div
          role="status"
          className={`mb-6 p-3 rounded-lg border text-sm ${
            saveMsg.ok
              ? 'border-bh-success/30 bg-bh-success/10 text-bh-success'
              : 'border-bh-danger/30 bg-bh-danger/10 text-bh-danger'
          }`}
        >
          {saveMsg.text}
        </div>
      )}

      {/* Landing state (before first search) */}
      {!searched && (
        <LandingState
          recent={recent}
          featured={featured}
          onPickQuery={(q) => { setQuery(q); runSearch(q) }}
          onClearRecent={clearRecent}
          onTracked={handleTracked}
        />
      )}

      {/* Loading skeleton */}
      {loading && <SearchSkeleton />}

      {/* Results header — count, tabs, sort and save on the top line; matched
          tags (when any) get their own row of removable pills below so they
          have room to breathe instead of being crammed into a sentence. */}
      {searched && !loading && results.length > 0 && (
        <div className="mb-4 pb-3 border-b border-bh-border">
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
              {/* "N results" was here, and N was the loaded count. Neither backend can report a
                  total — the federation would have to exhaust thirteen upstreams — so the number
                  says what it actually is, and "so far" is dropped once the walk ends. */}
              <p className="text-sm text-bh-text-muted whitespace-nowrap">
                <span className="font-semibold text-bh-text" data-testid="search-loaded-count">{results.length}</span> result
                {results.length === 1 ? '' : 's'}{cursor ? ' so far' : ''}
                {displayKeywords.length === 0 && (
                  <>
                    {' '}matching <span className="font-medium text-bh-text">"{query}"</span>
                  </>
                )}
              </p>

              {/* Tabs: People | Resources */}
              <div role="tablist" aria-label="Result type" className="flex items-center gap-1">
                <ResultTabButton
                  active={activeTab === 'people'}
                  onClick={() => setActiveTab('people')}
                  icon={Users}
                  label="People"
                  count={people.length}
                />
                <ResultTabButton
                  active={activeTab === 'resources'}
                  onClick={() => setActiveTab('resources')}
                  icon={BookMarked}
                  label="Resources"
                  count={resources.length}
                  disabled={resources.length === 0}
                />
              </div>
            </div>

            <div className="flex items-center gap-2">
              {/* The sort menu was here. It re-ordered the loaded prefix and called it a sort of
                  the results; see the `visible` memo. Relevance is the only ordering either
                  backend can serve, and it is not a choice. */}
              {searched && !showSave && (
                <Button onClick={() => setShowSave(true)} variant="secondary" size="sm" className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent">
                  <Bookmark className="w-4 h-4" /> Save search
                </Button>
              )}
            </div>
          </div>

          {/* Matched tags — click the × to drop that one tag and re-search
              with what's left. */}
          {displayKeywords.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <span className="text-xs font-medium text-bh-text-muted">Matching</span>
              {displayKeywords.map((k) => (
                <span
                  key={k}
                  className="group inline-flex items-center gap-1 rounded-full border border-bh-accent/20 bg-bh-accent/10 py-1 pl-2.5 pr-1 text-xs font-medium text-bh-accent"
                >
                  {k}
                  <button
                    type="button"
                    onClick={() => handleRemoveKeyword(k)}
                    aria-label={`Remove "${k}" and search again`}
                    className="rounded-full p-0.5 text-bh-accent/70 transition-colors hover:bg-bh-accent/20 hover:text-bh-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent"
                  >
                    <X className="w-3 h-3" aria-hidden="true" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Error state */}
      {error && (
        <div
          role="alert"
          className="card border border-bh-danger/30 bg-bh-danger/10 text-bh-danger p-6 text-center"
        >
          <p className="font-semibold mb-1">Search failed</p>
          <p className="text-sm">{error}</p>
          <Button onClick={() => runSearch(query)} variant="secondary" size="sm" className="mt-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent">
            Try again
          </Button>
        </div>
      )}

      {/* Degraded source notice — shown whenever a source did not answer, with or without results.
          Above the empty state on purpose: zero results from a search where GitHub timed out is not
          evidence that nobody matched, and `NoResults`' "try a different query" advice is actively
          misleading there. */}
      {searched && !loading && !error && unansweredSources.length > 0 && (
        <div
          className="mb-4 rounded-xl border border-bh-warning/30 bg-bh-warning/10 px-4 py-3 text-sm text-bh-text"
          role="status"
          data-testid="search-degraded-notice"
        >
          <p className="font-medium">
            {results.length === 0
              ? 'No results — but not every source answered.'
              : 'Some sources did not answer, so these results are partial.'}
          </p>
          <ul className="mt-1.5 space-y-0.5 text-xs text-bh-text-muted">
            {unansweredSources.map((status) => (
              <li key={status.source} data-testid={`search-source-status-${status.source}`}>
                <span className="font-medium text-bh-text">{SOURCE_META[status.source as Source]?.label ?? status.source}</span>
                {' — '}
                {status.detail ?? UNANSWERED_LABEL[status.health]}
              </li>
            ))}
          </ul>
          <Button
            onClick={() => runSearch(query)}
            variant="secondary"
            size="sm"
            className="mt-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent"
            data-testid="search-degraded-retry"
          >
            Search again
          </Button>
        </div>
      )}

      {/* No results */}
      {searched && !loading && !error && results.length === 0 && unansweredSources.length === 0 && (
        <NoResults query={query} onTryPopular={(q) => { setQuery(q); runSearch(q) }} />
      )}

      {/* Empty active tab (results exist but none in this kind) */}
      {searched && !loading && !error && results.length > 0 && visible.length === 0 && (
        <div className="card text-center py-12">
          <div className="inline-flex w-12 h-12 rounded-xl bg-bh-surface-2 border border-bh-border items-center justify-center mb-3">
            {activeTab === 'people' ? <Users className="w-6 h-6 text-bh-text-muted" /> : <BookMarked className="w-6 h-6 text-bh-text-muted" />}
          </div>
          <p className="font-semibold text-bh-text mb-1">
            No {activeTab === 'people' ? 'people' : 'resources'} in this search
          </p>
          <p className="text-sm text-bh-text-muted max-w-sm mx-auto">
            {activeTab === 'people'
              ? `We found ${resources.length} resource${resources.length === 1 ? '' : 's'} but no people matching "${query}".`
              : `We found ${people.length} people but no resources. Check the People tab or try GitHub.`
            }
          </p>
          {activeTab === 'people' && resources.length > 0 && (
            <Button
              onClick={() => setActiveTab('resources')}
              variant="secondary"
              size="sm"
              className="mt-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent"
            >
              View {resources.length} resource{resources.length === 1 ? '' : 's'}
            </Button>
          )}
        </div>
      )}

      {/* Semantic mode notice — degradation ladder is silent otherwise;
          this is the one line that tells the user why federated/keyword
          results are mixed in (spec.md's UX integration). */}
      {searched && !loading && !error && semanticMode && (resultMode === 'hybrid' || resultMode === 'keyword-fallback') && (
        <div className="mb-4 rounded-xl border border-bh-border bg-bh-surface-2 px-4 py-2.5 text-xs text-bh-text-muted flex items-center gap-2">
          <Sparkles className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          {resultMode === 'hybrid'
            ? 'Not enough indexed matches yet — showing live search results too.'
            : 'Semantic search unavailable right now — showing keyword results.'}
        </div>
      )}

      {/* Results list */}
      {searched && !loading && !error && visible.length > 0 && (
        <>
          <DataTable<SearchRow>
            label={activeTab === 'people' ? 'Search results — people' : 'Search results — resources'}
            columns={resultColumns}
            page={resultPage}
            query={EMPTY_TABLE_QUERY}
            // The shell's toolbar controls nothing here: the query, the sources, the language and
            // the country are this page's own inputs, and each of them re-runs the federation from
            // page one rather than re-viewing a set already fetched. So the toolbar is fed a frozen
            // query and a no-op, and the real controls stay where the user found them.
            onQueryChange={NO_TABLE_QUERY_CHANGE}
            searchable={false}
            rowTestId={(row) => `search-result-${row.builder.id}`}
            rowId={(row) => row.id}
            rowHeight={SEARCH_ROW_HEIGHT}
            maxHeight="70vh"
            onLoadMore={cursor ? loadMore : undefined}
            // One column called "Result": a column-visibility menu over it is meaningless and a
            // header reading "RESULT" above a list of people reads as a mistake.
            chrome="minimal"
            className="border-0 bg-transparent"
          />

          {/* Infinite scroll sentinel + status */}
          <div
            ref={sentinelRef}
            className="h-4 mt-2"
            aria-hidden="true"
            data-testid="infinite-scroll-sentinel"
          />

          {/* Loading more indicator */}
          {loadingMore && (
            <div
              className="flex items-center justify-center gap-2 py-6 text-sm text-bh-text-muted"
              role="status"
              aria-live="polite"
            >
              <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
              Loading more results…
            </div>
          )}

          {/* Explicit Load more fallback (for users w/o IO) */}
          {!loadingMore && cursor && (
            <div className="flex justify-center py-6">
              <Button
                variant="secondary"
                size="sm"
                onClick={loadMore}
                data-testid="load-more-button"
                className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent"
              >
                Load more results
              </Button>
            </div>
          )}

          {/* End of results */}
          {!cursor && (
            <div
              className="flex items-center justify-center gap-2 py-8 text-xs text-bh-text-dim"
              role="status"
              data-testid="end-of-results"
            >
              <span className="h-px w-8 bg-bh-border" aria-hidden="true" />
              {/* "N total" was here, over `results.length`, and it was only ever the loaded count —
                  the endpoints cannot report a total at all. At the end of the walk the two do
                  coincide, which is the one moment the old wording was accidentally right. */}
              End of results · {results.length} loaded
              <span className="h-px w-8 bg-bh-border" aria-hidden="true" />
            </div>
          )}
        </>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Subcomponents                                                              */
/* -------------------------------------------------------------------------- */

function LandingState({
  recent,
  featured,
  onPickQuery,
  onClearRecent,
  onTracked,
}: {
  recent: string[]
  featured: Builder[]
  onPickQuery: (q: string) => void
  onClearRecent: () => void
  onTracked: (builderId: string, organizationBuilderId: string) => void
}) {
  return (
    <div className="grid lg:grid-cols-[1fr_260px] gap-8 mt-2">
      {/* `min-w-0`: a grid item defaults to `min-width: auto`, which means it refuses to shrink below its
          widest child. One wide row in the featured list therefore pushed the whole column — and the document —
          104px past a 390px phone. The column is meant to be `1fr`, and this is what makes it actually be one. */}
      <div className="min-w-0 space-y-8">
        {/* Featured — a few real, live results before you've typed anything */}
        {featured.length > 0 && (
          <section aria-labelledby="featured-heading">
            <h2 id="featured-heading" className="text-xs font-semibold uppercase tracking-widest text-bh-text-dim mb-3 flex items-center gap-2">
              <Sparkles className="w-3.5 h-3.5" /> See what's out there right now
            </h2>
            <ul className="space-y-3" role="list">
              {featured.map((b) => (
                <li key={`${b.source}-${b.id}`}>
                  <PersonResultCard
                    builder={b}
                    query={FEATURED_QUERY}
                    onTracked={onTracked}
                  />
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      {/* Sidebar — utility panels grouped together (tips, shortcuts, history)
          so the main column stays focused on real results. */}
      <div className="space-y-6 lg:self-start">
        <aside aria-labelledby="tips-heading" className="card">
          <h2 id="tips-heading" className="text-xs font-semibold uppercase tracking-widest text-bh-text-dim flex items-center gap-2 mb-3">
            <Lightbulb className="w-3.5 h-3.5 text-bh-warning" aria-hidden="true" />
            Search tips
          </h2>
          <ul className="space-y-2.5">
            {PRO_TIPS.map((tip, i) => (
              <li key={i} className="flex items-start gap-2.5 text-xs text-bh-text-muted leading-snug">
                <tip.icon className="w-3.5 h-3.5 text-bh-text-dim shrink-0 mt-0.5" aria-hidden="true" />
                <span>{tip.text}</span>
              </li>
            ))}
          </ul>
        </aside>

        {/* Popular queries */}
        <section aria-labelledby="popular-heading" className="card">
          <h2 id="popular-heading" className="text-xs font-semibold uppercase tracking-widest text-bh-text-dim mb-3 flex items-center gap-2">
            <TrendingUp className="w-3.5 h-3.5" /> Popular searches
          </h2>
          <div className="flex flex-col gap-1.5">
            {POPULAR_QUERIES.map((p) => (
              <button
                key={p.label}
                onClick={() => onPickQuery(p.label)}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-bh-surface-2 border border-transparent text-sm text-bh-text hover:border-bh-accent hover:text-bh-accent hover:bg-bh-accent-soft/30 transition-all text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2"
              >
                <span aria-hidden="true">{p.emoji}</span>
                <span className="truncate">{p.label}</span>
              </button>
            ))}
          </div>
        </section>

        {/* Recent searches */}
        {recent.length > 0 && (
          <section aria-labelledby="recent-heading" className="card">
            <div className="flex items-center justify-between mb-3">
              <h2 id="recent-heading" className="text-xs font-semibold uppercase tracking-widest text-bh-text-dim flex items-center gap-2">
                <Clock className="w-3.5 h-3.5" /> Your recent searches
              </h2>
              <button
                onClick={onClearRecent}
                className="text-xs text-bh-text-dim hover:text-bh-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2 rounded"
              >
                Clear
              </button>
            </div>
            <ul className="space-y-1">
              {recent.map((q) => (
                <li key={q}>
                  <button
                    onClick={() => onPickQuery(q)}
                    className="w-full text-left flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-bh-text-muted hover:bg-bh-surface hover:text-bh-text transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent"
                  >
                    <Search className="w-3.5 h-3.5 text-bh-text-dim shrink-0" aria-hidden="true" />
                    <span className="flex-1 truncate">{q}</span>
                    <ChevronDown className="w-3.5 h-3.5 -rotate-90 text-bh-text-dim shrink-0" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  )
}

function SearchSkeleton() {
  return (
    <ul className="space-y-3" role="list" aria-busy="true" aria-label="Loading search results">
      {[...Array(4)].map((_, i) => (
        <li key={i} className="card animate-pulse">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 rounded-full bg-bh-surface-2 shrink-0" />
            <div className="flex-1 space-y-2">
              <div className="h-4 w-1/3 bg-bh-surface-2 rounded" />
              <div className="h-3 w-1/2 bg-bh-surface-2 rounded" />
              <div className="h-3 w-2/3 bg-bh-surface-2 rounded" />
            </div>
          </div>
        </li>
      ))}
    </ul>
  )
}

function NoResults({ query, onTryPopular }: { query: string; onTryPopular: (q: string) => void }) {
  return (
    <div className="card text-center py-16">
      <div className="inline-flex w-14 h-14 rounded-2xl bg-bh-surface-2 border border-bh-border items-center justify-center mb-4">
        <Search className="w-7 h-7 text-bh-text-muted" aria-hidden="true" />
      </div>
      <h2 className="text-xl font-semibold mb-2">No builders found for "{query}"</h2>
      <p className="text-bh-text-muted max-w-md mx-auto mb-6">
        Try fewer keywords, broader terms, or enable more sources. The most successful
        searches use 1-3 specific terms.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <span className="text-xs text-bh-text-dim uppercase tracking-wider mr-1">Try instead</span>
        {POPULAR_QUERIES.slice(0, 3).map((p) => (
          <button
            key={p.label}
            onClick={() => onTryPopular(p.label)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-bh-surface border border-bh-border text-xs text-bh-text-muted hover:border-bh-accent hover:text-bh-accent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2"
          >
            <span aria-hidden="true">{p.emoji}</span>
            {p.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function BuilderResultCard({ builder, query, onTracked }: { builder: Builder; query: string; onTracked: (builderId: string, organizationBuilderId: string) => void }) {
  if (builder.kind === 'repo') {
    return <ResourceResultCard builder={builder} query={query} />
  }
  return <PersonResultCard builder={builder} query={query} onTracked={onTracked} />
}

/* -------------------------------------------------------------------------- */
/*  Match highlights — find query terms that hit topics, name, handle, or bio */
/* -------------------------------------------------------------------------- */
function getMatchHighlights(builder: Builder, query: string): {
  topics: string[]
  terms: string[]    // query terms that matched somewhere
  fields: Array<'topic' | 'name' | 'handle' | 'bio'>
} {
  const queryTerms = query
    .toLowerCase()
    .split(/[,\s]+/)
    .filter(Boolean)
  if (queryTerms.length === 0) return { topics: [], terms: [], fields: [] }

  const topics = (builder.topics ?? []).filter((t) =>
    queryTerms.some((term) => t.toLowerCase().includes(term)),
  )

  const haystack = {
    name: (builder.displayName ?? '').toLowerCase(),
    handle: builder.username.toLowerCase(),
    bio: (builder.bio ?? '').toLowerCase(),
  }

  const matchedTerms = new Set<string>()
  const fields = new Set<'topic' | 'name' | 'handle' | 'bio'>()

  for (const term of queryTerms) {
    if (topics.some((t) => t.toLowerCase().includes(term))) {
      fields.add('topic')
      matchedTerms.add(term)
    }
    if (haystack.name && haystack.name.includes(term)) {
      fields.add('name')
      matchedTerms.add(term)
    }
    if (haystack.handle && haystack.handle.includes(term)) {
      fields.add('handle')
      matchedTerms.add(term)
    }
    if (haystack.bio && haystack.bio.includes(term)) {
      fields.add('bio')
      matchedTerms.add(term)
    }
  }

  return { topics, terms: [...matchedTerms], fields: [...fields] }
}

/* -------------------------------------------------------------------------- */
/*  PersonResultCard — compact single-line                                   */
/* -------------------------------------------------------------------------- */
function PersonResultCard({ builder, query, onTracked }: { builder: Builder; query: string; onTracked: (builderId: string, organizationBuilderId: string) => void }) {
  const location = useLocation()
  const from = resolveSafeBuilderFrom(`${location.pathname}${location.searchStr}`)
  const meta = SOURCE_META[builder.source]
  const { topics: matchedTopics, terms: matchedTerms, fields } = getMatchHighlights(builder, query)
  const lastSeenMs = getLastSeenMs(builder)

  // Matched topics first (they explain the ranking), then whatever other
  // topics we know about — as much signal for "who is this" as we have.
  const otherTopics = (builder.topics ?? []).filter((t) => !matchedTopics.includes(t))
  const displayTopics = [...matchedTopics.map((t) => ({ t, matched: true })), ...otherTopics.map((t) => ({ t, matched: false }))].slice(0, 6)

  return (
    <article className="card card-hover group rounded-3xl p-4">
      <div className="flex items-start gap-4">
        {/* Avatar */}
        {builder.avatarUrl ? (
          <img
            src={builder.avatarUrl}
            alt={`${builder.displayName ?? builder.username} avatar`}
            className="w-11 h-11 rounded-full border border-bh-border shrink-0"
            loading="lazy"
            width={44}
            height={44}
          />
        ) : (
          <div
            className="w-11 h-11 rounded-full bg-gradient-to-br from-bh-accent to-bh-cyan flex items-center justify-center text-white font-semibold shrink-0 text-base"
            aria-hidden="true"
          >
            {(builder.displayName ?? builder.username)[0]?.toUpperCase()}
          </div>
        )}

        <div className="flex-1 min-w-0">
          {/* Row 1: name + handle (truncates) — score + actions to the right.
              The source badge lives in the wrapping meta row below, not here — it doesn't
              fit alongside score+view on narrow screens without squeezing the name to 0.

              "Always one line" was the original intent and it was wrong below ~500px: the action group is
              ~330px of buttons and `shrink-0` made it refuse to give any of that back, so the whole document
              scrolled sideways on a phone. Both levels wrap now; on desktop nothing moves, because there is
              room for one line and flex-wrap only acts when there is not. */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1 truncate">
              <span className="font-semibold text-bh-text text-sm">
                {builder.displayName ?? builder.username}
              </span>
              {builder.displayName && (
                <span className="text-xs text-bh-text-dim ml-1.5">@{builder.username}</span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2.5">
              {builder.similarity != null ? (
                <span
                  className="badge inline-flex items-center gap-1 border-bh-accent/30 bg-bh-accent-soft text-bh-accent text-[11px] font-semibold"
                  title="Cosine similarity to your query"
                  data-testid={`similarity-badge-${builder.id}`}
                >
                  {Math.round(builder.similarity * 100)}% match
                </span>
              ) : builder.score != null && (
                <ScoreRing
                  score={builder.score}
                  size={38}
                  showLabel={false}
                  breakdown={getScoreBreakdown(builder)}
                />
              )}
              <BuilderResultActions
                builder={builder}
                from={from}
                onTracked={(organizationBuilderId) => onTracked(builder.id, organizationBuilderId)}
              />
            </div>
          </div>

          {/* Row 2: bio — the single most useful "who is this" signal we have */}
          {builder.bio && (
            <p className="text-sm text-bh-text-muted mt-1.5 line-clamp-2 leading-relaxed">
              {builder.bio}
            </p>
          )}

          {/* Row 3: source, followers, location, last-active, topics */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 mt-2 text-xs text-bh-text-muted">
            <span className={`badge ${meta.color} inline-flex items-center gap-1`}>
              <meta.Icon className="w-3 h-3" title={meta.label} />
              {meta.label}
            </span>
            {builder.followersCount != null && (
              <span className="inline-flex items-center gap-1">
                <Users className="w-3 h-3" aria-hidden="true" />
                {(builder.followersCount ?? 0).toLocaleString()}
              </span>
            )}
            {builder.country && (
              <span className="inline-flex items-center gap-1">
                <MapPin className="w-3 h-3" aria-hidden="true" />
                {builder.country}
              </span>
            )}
            {lastSeenMs != null && (
              <span className="inline-flex items-center gap-1">
                <Clock className="w-3 h-3" aria-hidden="true" />
                Active {formatRelativeDate(lastSeenMs)}
              </span>
            )}
            {displayTopics.map(({ t, matched }) => (
              <span
                key={t}
                className={matched ? 'badge text-xs border-bh-accent/30 bg-bh-accent-soft text-bh-accent' : 'badge text-xs'}
              >
                {t}
              </span>
            ))}
          </div>

          {/* Row 4: why this match */}
          <div className="flex items-center gap-1 text-xs text-bh-text-dim min-w-0 mt-1.5">
            {matchedTerms.length > 0 ? (
              <>
                <Sparkles className="w-3 h-3 text-bh-accent shrink-0" aria-hidden="true" />
                <span>
                  matches{' '}
                  {matchedTerms.slice(0, 3).map((t, i) => (
                    <span key={t}>
                      <span className="text-bh-text-muted font-medium">"{t}"</span>
                      {i < Math.min(matchedTerms.length, 3) - 1 && ', '}
                    </span>
                  ))}
                  {matchedTerms.length > 3 && ` +${matchedTerms.length - 3}`}
                  {' '}
                  <span className="text-bh-text-dim">in {fields.join(' + ')}</span>
                </span>
              </>
            ) : (
              <>
                <TrendingUp className="w-3 h-3 text-bh-text-dim shrink-0" aria-hidden="true" />
                <span>ranked by reach &amp; recent activity, not a direct keyword hit</span>
              </>
            )}
          </div>
        </div>
      </div>
    </article>
  )
}

/* -------------------------------------------------------------------------- */
/*  ResourceResultCard — taller, with description                             */
/* -------------------------------------------------------------------------- */
function ResourceResultCard({ builder, query }: { builder: Builder; query: string }) {
  const meta = SOURCE_META[builder.source]
  const { topics: matchedTopics, terms: matchedTerms, fields } = getMatchHighlights(builder, query)

  return (
    <article className="card card-hover group rounded-3xl p-4">
      <div className="flex items-start gap-4">
        {/* Icon */}
        <div
          className="w-10 h-10 rounded-lg bg-gradient-to-br from-yellow-500 to-orange-500 flex items-center justify-center text-white shrink-0"
          aria-hidden="true"
        >
          <GitFork className="w-5 h-5" />
        </div>

        {/* Body */}
        <div className="flex-1 min-w-0">
          {/* Name + source */}
          <div className="flex flex-wrap items-center gap-2 mb-1.5">
            <h3 className="font-semibold text-bh-text text-base">
              {builder.displayName ?? builder.username}
            </h3>
            <span className={`badge ${meta.color} inline-flex items-center gap-1`}>
              <meta.Icon className="w-3 h-3" title={meta.label} />
              {meta.label}
            </span>
            <span className="badge-neutral badge text-xs inline-flex items-center gap-1">
              <GitFork className="w-3 h-3" /> Repository
            </span>
            {matchedTopics.slice(0, 3).map((t) => (
              <span key={t} className="badge text-xs">
                {t}
              </span>
            ))}
          </div>

          {/* Description */}
          {builder.bio && (
            <p className="text-sm text-bh-text-muted line-clamp-2 mb-3 leading-relaxed">
              {builder.bio}
            </p>
          )}

          {/* Meta row */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-bh-text-muted mb-2">
            <a
              href={builder.profileUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-bh-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2 rounded"
            >
              <Code className="w-3 h-3" aria-hidden="true" />
              {builder.username}
              <ExternalLink className="w-2.5 h-2.5" aria-hidden="true" />
            </a>
            {builder.followersCount != null && (
              <span className="inline-flex items-center gap-1">
                <Star className="w-3 h-3" aria-hidden="true" />
                {(builder.followersCount ?? 0).toLocaleString()} stars
              </span>
            )}
            {builder.language && <span>{builder.language}</span>}
          </div>

          {/* Why this match — always show a reason */}
          <p className="text-xs text-bh-text-dim flex items-start gap-1.5">
            {matchedTerms.length > 0 ? (
              <>
                <Sparkles className="w-3 h-3 text-bh-accent shrink-0 mt-0.5" aria-hidden="true" />
                <span>
                  Matches{' '}
                  {matchedTerms.slice(0, 4).map((t, i) => (
                    <span key={t}>
                      <span className="text-bh-text-muted font-medium">"{t}"</span>
                      {i < Math.min(matchedTerms.length, 4) - 1 && ', '}
                    </span>
                  ))}
                  {matchedTerms.length > 4 && ` +${matchedTerms.length - 4} more`}
                  {fields.length > 0 && (
                    <span className="text-bh-text-dim"> · in {fields.join(' + ')}</span>
                  )}
                </span>
              </>
            ) : (
              <>
                <TrendingUp className="w-3 h-3 text-bh-text-dim shrink-0 mt-0.5" aria-hidden="true" />
                <span>Ranked by reach &amp; recent activity, not a direct keyword hit</span>
              </>
            )}
          </p>
        </div>

        {/* Score + actions */}
        <div className="flex flex-col items-end gap-3 shrink-0">
          {builder.score != null && (
            <ScoreRing
              score={builder.score}
              size={56}
              breakdown={getScoreBreakdown(builder)}
            />
          )}
          <a
            href={builder.profileUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-secondary btn-sm rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent"
          >
            View <ExternalLink className="w-3 h-3" aria-hidden="true" />
          </a>
        </div>
      </div>
    </article>
  )
}

function ResultTabButton({
  active,
  onClick,
  icon: Icon,
  label,
  count,
  disabled = false,
}: {
  active: boolean
  onClick: () => void
  icon: React.ComponentType<{ className?: string }>
  label: string
  count: number
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      disabled={disabled}
      className={`relative inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2 ${
        active
          ? 'text-bh-text'
          : disabled
            ? 'text-bh-text-dim cursor-not-allowed'
            : 'text-bh-text-muted hover:text-bh-text'
      }`}
    >
      <Icon className="w-4 h-4" aria-hidden="true" />
      {label}
      <span className={`inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-xs font-bold ${
        active
          ? 'bg-bh-accent-soft text-bh-accent'
          : 'bg-bh-surface-2 text-bh-text-muted'
      }`}>
        {count}
      </span>
      {active && (
        <span
          className="absolute bottom-0 left-2 right-2 h-0.5 bg-bh-accent rounded-t"
          aria-hidden="true"
        />
      )}
    </button>
  )
}

