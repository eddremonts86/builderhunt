/**
 * Admin → Sources. One page for both source registers.
 *
 * The maintainer's requirement was simply "every source has to be switchable on and off from the UI".
 * Two registers back that: `search_sources` for the connectors that look for people, `solution_sources`
 * for the ones that describe tools. They are separate tables because their obligations differ, but an
 * operator does not care about that distinction while deciding what this product is allowed to contact
 * — so they get one page with two sections and identical controls.
 *
 * The interesting design work here is refusing to show a toggle that cannot work. A switch that looks
 * live and then answers 409 teaches an operator to distrust the page. Three reasons a source cannot be
 * enabled are surfaced as text where the toggle would be:
 *
 * - no connector exists (the four hard-blocked platforms, permanently);
 * - a public-scrape source has no recorded terms review (fixable right here, via Record review);
 * - the source is already in the requested state.
 *
 * `Record review` is a separate control from the toggle for the same reason the API keeps them apart:
 * approving a crawl and starting it are two decisions, and one button doing both is the shortcut the
 * whole gate exists to prevent.
 */
import * as React from 'react'
import { AlertTriangle, Ban, CheckCircle2, ExternalLink, FileCheck2, Loader2, MinusCircle } from 'lucide-react'
import { Button } from '~/components/ui'

type SourceKind =
  | 'official_api' | 'feed' | 'licensed_dataset' | 'user_submission' | 'public_scrape' | 'external_link_only'

interface SearchSource {
  key: string
  kind: SourceKind
  label: string
  homepageUrl: string
  enabled: boolean
  connectorImplemented: boolean
  allowedHosts: string[]
  storesPersonalData: boolean
  geography: string | null
  retentionDays: number | null
  termsReviewedAt: string | null
  registerNotes: string | null
}

interface SolutionSource {
  key: string
  kind: SourceKind
  label: string
  homepageUrl: string
  enabled: boolean
  allowedFields: string[]
  geography: string | null
  retentionDays: number | null
  termsReviewedAt: string | null
  registerNotes: string | null
}

/** What the two registers have in common, which is everything this page renders. */
interface Row {
  key: string
  label: string
  kind: SourceKind
  homepageUrl: string
  enabled: boolean
  termsReviewedAt: string | null
  registerNotes: string | null
  geography: string | null
  retentionDays: number | null
  /** `search_sources` only. Solution sources always have an adapter or simply never ingest. */
  connectorImplemented: boolean
  /** Hosts for a search source, permitted fields for a solutions source. Different facts, both
   * answering "what can this source reach or contribute", so they share a column. */
  scopeLabel: string
  scope: string[]
}

const KIND_LABELS: Record<SourceKind, string> = {
  official_api: 'Official API',
  feed: 'Feed',
  licensed_dataset: 'Licensed dataset',
  user_submission: 'User submission',
  public_scrape: 'Public scrape',
  external_link_only: 'Link only',
}

const REGISTERS = {
  search: { endpoint: '/api/admin/search-sources', title: 'People search', blurb: 'Connectors that look for builders. Switching one off stops the next search from contacting it.' },
  solutions: { endpoint: '/api/admin/solutions/sources', title: 'Solutions catalog', blurb: 'Sources that describe models, tools, services and open roles.' },
} as const

type RegisterId = keyof typeof REGISTERS

export function SourcesPage() {
  const [rows, setRows] = React.useState<Record<RegisterId, Row[]> | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [busyKey, setBusyKey] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<{ key: string; text: string; tone: 'ok' | 'warn' } | null>(null)
  const [reviewing, setReviewing] = React.useState<{ register: RegisterId; key: string } | null>(null)
  const [reviewNotes, setReviewNotes] = React.useState('')

  const load = React.useCallback(async () => {
    try {
      const [searchRes, solutionsRes] = await Promise.all([
        fetch(REGISTERS.search.endpoint, { credentials: 'include' }),
        fetch(REGISTERS.solutions.endpoint, { credentials: 'include' }),
      ])
      if (!searchRes.ok || !solutionsRes.ok) {
        setError(`Failed to load registers (${searchRes.status}/${solutionsRes.status})`)
        return
      }
      const searchBody = (await searchRes.json()) as { sources: SearchSource[] }
      const solutionsBody = (await solutionsRes.json()) as { sources: SolutionSource[] }
      setRows({
        search: searchBody.sources.map(searchToRow),
        solutions: solutionsBody.sources.map(solutionToRow),
      })
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => { void load() }, [load])

  const post = React.useCallback(async (register: RegisterId, body: Record<string, unknown>) => {
    const key = String(body.key)
    setBusyKey(key)
    setNotice(null)
    try {
      const res = await fetch(REGISTERS[register].endpoint, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const payload = (await res.json().catch(() => ({}))) as { error?: string; detail?: string; changed?: boolean }
      if (!res.ok) {
        // The API's refusal reasons are already written for a human. Showing `detail` verbatim beats
        // mapping each code to a second, vaguer sentence.
        setNotice({ key, text: payload.detail ?? payload.error ?? `Request failed (${res.status})`, tone: 'warn' })
        return
      }
      await load()
      setNotice({
        key,
        text: payload.changed === false ? 'Already in that state — nothing changed.' : 'Saved.',
        tone: 'ok',
      })
    } catch (e) {
      setNotice({ key, text: e instanceof Error ? e.message : String(e), tone: 'warn' })
    } finally {
      setBusyKey(null)
    }
  }, [load])

  const submitReview = React.useCallback(async () => {
    if (!reviewing || reviewNotes.trim().length === 0) return
    await post(reviewing.register, { action: 'record-review', key: reviewing.key, notes: reviewNotes.trim() })
    setReviewing(null)
    setReviewNotes('')
  }, [post, reviewing, reviewNotes])

  if (loading) {
    return (
      <div className="p-6 text-sm text-bh-text-muted" data-testid="admin-sources-loading">
        <Loader2 className="mr-2 inline size-4 animate-spin" aria-hidden />Loading source registers…
      </div>
    )
  }
  if (error || !rows) {
    return (
      <div className="p-6 text-sm text-bh-danger" data-testid="admin-sources-error" role="alert">
        {error ?? 'No register data.'}
      </div>
    )
  }

  return (
    <div className="space-y-8 p-6" data-testid="admin-sources">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-bh-text">Sources</h1>
        <p className="max-w-3xl text-sm text-bh-text-muted">
          Every external source this product may contact, and a switch for each. A source that is off is
          never contacted — the search and ingestion paths read this register on every run, so a change
          takes effect immediately and does not need a deploy.
        </p>
      </header>

      {(Object.keys(REGISTERS) as RegisterId[]).map((register) => (
        <section key={register} className="space-y-3" data-testid={`admin-sources-section-${register}`}>
          <div>
            <h2 className="text-base font-medium text-bh-text">{REGISTERS[register].title}</h2>
            <p className="text-sm text-bh-text-muted">{REGISTERS[register].blurb}</p>
          </div>

          <ul className="divide-y divide-bh-border rounded-lg border border-bh-border">
            {rows[register].map((row) => (
              <SourceRow
                key={row.key}
                row={row}
                busy={busyKey === row.key}
                notice={notice?.key === row.key ? notice : null}
                onToggle={() => void post(register, { action: row.enabled ? 'disable' : 'enable', key: row.key })}
                onStartReview={() => { setReviewing({ register, key: row.key }); setReviewNotes('') }}
              />
            ))}
          </ul>
        </section>
      ))}

      {reviewing ? (
        <ReviewDialog
          sourceKey={reviewing.key}
          notes={reviewNotes}
          onNotesChange={setReviewNotes}
          onCancel={() => { setReviewing(null); setReviewNotes('') }}
          onSubmit={() => void submitReview()}
        />
      ) : null}
    </div>
  )
}

function SourceRow({
  row, busy, notice, onToggle, onStartReview,
}: {
  row: Row
  busy: boolean
  notice: { text: string; tone: 'ok' | 'warn' } | null
  onToggle: () => void
  onStartReview: () => void
}) {
  const needsReview = row.kind === 'public_scrape' && row.termsReviewedAt === null
  const blocked = !row.connectorImplemented || (needsReview && !row.enabled)

  return (
    <li className="flex flex-col gap-2 p-3 sm:flex-row sm:items-start sm:justify-between" data-testid={`source-row-${row.key}`}>
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-bh-text">{row.label}</span>
          <code className="rounded bg-bh-surface px-1 py-0.5 text-[11px] text-bh-text-dim">{row.key}</code>
          <span className="rounded bg-bh-surface px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-bh-text-muted">
            {KIND_LABELS[row.kind]}
          </span>
          <StateBadge row={row} />
          {row.geography ? (
            <span className="text-[11px] uppercase tracking-wider text-bh-text-dim">{row.geography}</span>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-bh-text-muted">
          <a href={row.homepageUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:text-bh-text">
            {new URL(row.homepageUrl).hostname}
            <ExternalLink className="size-3" aria-hidden />
          </a>
          {row.scope.length > 0 ? <span>{row.scopeLabel}: {row.scope.join(', ')}</span> : null}
          {row.retentionDays !== null ? <span>Retention: {row.retentionDays}d</span> : null}
          {row.termsReviewedAt ? (
            <span className="inline-flex items-center gap-1">
              <FileCheck2 className="size-3" aria-hidden />
              Reviewed {new Date(row.termsReviewedAt).toISOString().slice(0, 10)}
            </span>
          ) : null}
        </div>

        {row.registerNotes ? (
          <p className="max-w-3xl text-xs leading-relaxed text-bh-text-dim">{row.registerNotes}</p>
        ) : null}

        {notice ? (
          <p
            className={notice.tone === 'ok' ? 'text-xs text-bh-success' : 'text-xs text-bh-warning'}
            role="status"
            data-testid={`source-notice-${row.key}`}
          >
            {notice.text}
          </p>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {needsReview ? (
          <Button variant="secondary" size="sm" onClick={onStartReview} disabled={busy} data-testid={`source-review-${row.key}`}>
            Record review
          </Button>
        ) : null}

        {row.connectorImplemented ? (
          <Button
            variant={row.enabled ? 'secondary' : 'primary'}
            size="sm"
            onClick={onToggle}
            disabled={busy || blocked}
            data-testid={`source-toggle-${row.key}`}
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : row.enabled ? 'Disable' : 'Enable'}
          </Button>
        ) : (
          // No dead toggle. Nothing queries this source, so there is nothing to switch — the register
          // notes above say why, and inventing a control would only produce a 409.
          <span className="inline-flex items-center gap-1 text-xs text-bh-text-dim" data-testid={`source-no-connector-${row.key}`}>
            <Ban className="size-3.5" aria-hidden />
            No connector
          </span>
        )}
      </div>
    </li>
  )
}

function StateBadge({ row }: { row: Row }) {
  if (row.enabled) {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-bh-success/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-bh-success" data-testid={`source-state-${row.key}`}>
        <CheckCircle2 className="size-3" aria-hidden />Enabled
      </span>
    )
  }
  if (row.kind === 'public_scrape' && row.termsReviewedAt === null) {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-bh-warning/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-bh-warning" data-testid={`source-state-${row.key}`}>
        <AlertTriangle className="size-3" aria-hidden />Needs review
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded bg-bh-surface px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-bh-text-muted" data-testid={`source-state-${row.key}`}>
      <MinusCircle className="size-3" aria-hidden />Disabled
    </span>
  )
}

/**
 * Records a terms/robots/privacy review.
 *
 * The note is required, not optional: a review with no record of what was reviewed is indistinguishable
 * from a click, and the whole reason `terms_reviewed_at` gates a scrape is that somebody read something
 * and can say what.
 */
function ReviewDialog({
  sourceKey, notes, onNotesChange, onCancel, onSubmit,
}: {
  sourceKey: string
  notes: string
  onNotesChange: (value: string) => void
  onCancel: () => void
  onSubmit: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="source-review-title">
      <div className="w-full max-w-lg space-y-3 rounded-lg border border-bh-border bg-bh-bg p-4" data-testid="source-review-dialog">
        <h3 id="source-review-title" className="font-medium text-bh-text">Record terms review — {sourceKey}</h3>
        <p className="text-sm text-bh-text-muted">
          State what you reviewed and what it permits: the terms or robots policy you read, the lawful
          basis for processing, and any limit the source imposes. This is stored in the register and your
          user id is recorded against it.
        </p>
        <textarea
          value={notes}
          onChange={(event) => onNotesChange(event.target.value)}
          rows={5}
          maxLength={2000}
          className="w-full rounded border border-bh-border bg-bh-surface p-2 text-sm text-bh-text"
          placeholder="Reviewed https://example.com/terms on 2026-08-01: automated access permitted for indexing, 1 req/s, attribution required. Lawful basis: …"
          data-testid="source-review-notes"
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
          <Button size="sm" onClick={onSubmit} disabled={notes.trim().length === 0} data-testid="source-review-submit">
            Record review
          </Button>
        </div>
      </div>
    </div>
  )
}

function searchToRow(source: SearchSource): Row {
  return {
    key: source.key,
    label: source.label,
    kind: source.kind,
    homepageUrl: source.homepageUrl,
    enabled: source.enabled,
    termsReviewedAt: source.termsReviewedAt,
    registerNotes: source.registerNotes,
    geography: source.geography,
    retentionDays: source.retentionDays,
    connectorImplemented: source.connectorImplemented,
    scopeLabel: 'Hosts',
    scope: source.allowedHosts,
  }
}

function solutionToRow(source: SolutionSource): Row {
  return {
    key: source.key,
    label: source.label,
    kind: source.kind,
    homepageUrl: source.homepageUrl,
    enabled: source.enabled,
    termsReviewedAt: source.termsReviewedAt,
    registerNotes: source.registerNotes,
    geography: source.geography,
    retentionDays: source.retentionDays,
    // Solutions sources carry no `connector_implemented` column: an entry with no adapter simply never
    // ingests, which is a harmless state rather than one worth a constraint. Reported as true so the
    // toggle renders — enabling a source before its adapter lands is a legitimate order of operations.
    connectorImplemented: true,
    scopeLabel: 'Fields',
    scope: source.allowedFields,
  }
}
