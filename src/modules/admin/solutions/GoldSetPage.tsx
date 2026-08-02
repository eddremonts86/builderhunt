/**
 * The human half of the Solutions gold set (plan 43 Phase 0, "Create the synthetic gold set, its CRUD, and the
 * baseline report").
 *
 * ## Why this page exists rather than just the API
 *
 * The 60 seeded briefs are machine-authored, and tasks.md is blunt about what that makes them: scaffolding for
 * regression detection, never evidence of quality, because the generator and the grader share assumptions.
 * **Only human-authored judgments may be cited as a quality gate** — so until a person writes some, every
 * evaluation run prints "SYNTHETIC ONLY" and no number in it can be quoted. That is the state today, and this
 * page is the thing that changes it.
 *
 * ## The one rule the form enforces
 *
 * A judgment written here is `authorship: 'human'` and the field is not on the form. The server forces it too;
 * both, because the whole authorship split collapses the moment a synthetic record can enter the human
 * population, and it would be indistinguishable a week later.
 *
 * The synthetic set is deliberately not editable here. It lives in `tests/fixtures/solutions/gold-set.json`,
 * version-controlled, and changing it should be a diff someone reviews rather than a form submission.
 */
import * as React from 'react'
import { AlertTriangle, FlaskConical, Trash2 } from 'lucide-react'
import { Button, Input, Label, Textarea } from '~/components/ui'
import { BRIEF_DOMAINS, RANKING_MODES, SOLUTION_CAPABILITIES, ROUTE_TYPES } from '~/shared/lib/solutions/contracts'

interface GoldBriefRow {
  id: string
  authorship: string
  briefText: string
  expected: {
    domain: string
    capabilityKeys: string[]
    offerableLanes: string[]
    rankingMode: string
  }
  notes: string | null
  createdAt: string
}

export interface GoldSetPageProps {
  /** Injected for tests — defaults to the real admin endpoint. */
  fetchBriefs?: () => Promise<{ briefs: GoldBriefRow[] }>
  createBrief?: (input: unknown) => Promise<{ id: string }>
  deleteBrief?: (id: string) => Promise<void>
}

export function GoldSetPage({ fetchBriefs, createBrief, deleteBrief }: GoldSetPageProps = {}) {
  const [briefs, setBriefs] = React.useState<GoldBriefRow[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)

  const [briefText, setBriefText] = React.useState('')
  const [domain, setDomain] = React.useState<string>('software_and_ai')
  const [capabilities, setCapabilities] = React.useState<string[]>([])
  const [lanes, setLanes] = React.useState<string[]>(['human', 'ai', 'hybrid'])
  const [rankingMode, setRankingMode] = React.useState<string>('recommended')
  const [notes, setNotes] = React.useState('')

  const load = React.useCallback(() => {
    const fetcher = fetchBriefs ?? defaultFetchBriefs
    fetcher()
      .then((data) => setBriefs(data.briefs))
      .catch(() => setError('Could not load the gold set.'))
  }, [fetchBriefs])

  React.useEffect(() => { load() }, [load])

  const humanCount = (briefs ?? []).filter((row) => row.authorship === 'human').length

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (briefText.trim().length === 0 || capabilities.length === 0) return
    setSaving(true)
    setError(null)
    try {
      const create = createBrief ?? defaultCreateBrief
      await create({
        briefText: briefText.trim(),
        expected: {
          domain,
          capabilityKeys: capabilities,
          offerableLanes: lanes,
          hardConstraints: [],
          unacceptableComponentKinds: [],
          rankingMode,
        },
        notes: notes.trim() === '' ? null : notes.trim(),
      })
      setBriefText('')
      setCapabilities([])
      setNotes('')
      load()
    } catch {
      setError('Could not save this judgment. Nothing was written.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="container py-8 max-w-4xl" data-testid="gold-set-page">
      <header className="mb-6">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <FlaskConical className="w-6 h-6 text-bh-accent" aria-hidden="true" />
          Solutions gold set
        </h1>
        <p className="text-bh-text-muted mt-1">
          Human-authored briefs and the judgments an evaluation run is scored against.
        </p>
      </header>

      {/* The state of the world, stated before the form. A curator who does not know why their work matters
          writes less of it. */}
      <div
        className={`card p-4 mb-6 rounded-xl text-sm border ${humanCount === 0 ? 'border-bh-warning/40 bg-bh-warning-soft' : 'border-bh-border/60 bg-bh-bg-alt'}`}
        data-testid="gold-set-status"
      >
        {humanCount === 0 ? (
          <p className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5" aria-hidden="true" />
            <span>
              No human judgments yet, so <strong>every evaluation run is uncitable</strong>. The 60 seeded briefs
              are machine-authored: the generator and the grader share assumptions, which detects regressions and
              proves nothing about quality. One judgment written here changes that.
            </span>
          </p>
        ) : (
          <p>
            {humanCount} human {humanCount === 1 ? 'judgment' : 'judgments'}. Evaluation runs report these
            separately from the 60 synthetic briefs and never blend the two.
          </p>
        )}
      </div>

      {error && (
        <div className="card p-4 mb-6 border border-bh-danger/40 bg-bh-danger-soft rounded-xl text-sm" data-testid="gold-set-error">
          {error}
        </div>
      )}

      <form onSubmit={submit} className="card p-6 space-y-5 border border-bh-border/60 rounded-2xl mb-8" data-testid="gold-brief-form">
        <div>
          <Label htmlFor="gold-brief-text">The brief, as a user would type it</Label>
          <Textarea
            id="gold-brief-text"
            rows={4}
            required
            placeholder="e.g. Translate 200 product pages into German by 30 September. Budget max 5000 EUR."
            value={briefText}
            onChange={(event) => setBriefText(event.target.value)}
            data-testid="gold-brief-text"
          />
          <p className="text-xs text-bh-text-dim mt-1">
            Interpretation is part of what is measured, so write it the way a real user would rather than in
            structured fields.
          </p>
        </div>

        <div>
          <Label htmlFor="gold-domain">Expected domain</Label>
          <select
            id="gold-domain"
            className="w-full bg-bh-surface border border-bh-border/60 rounded-md px-3 py-2 text-sm"
            value={domain}
            onChange={(event) => setDomain(event.target.value)}
            data-testid="gold-domain"
          >
            {BRIEF_DOMAINS.map((entry) => <option key={entry} value={entry}>{entry.replace(/_/g, ' ')}</option>)}
          </select>
        </div>

        <fieldset>
          <legend className="text-sm font-medium mb-2">Expected capabilities</legend>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            {SOLUTION_CAPABILITIES.map((capability) => (
              <label key={capability.key} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={capabilities.includes(capability.key)}
                  onChange={(event) => setCapabilities((current) => (
                    event.target.checked
                      ? [...current, capability.key]
                      : current.filter((key) => key !== capability.key)
                  ))}
                  data-testid={`gold-capability-${capability.key}`}
                />
                {capability.label}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className="text-sm font-medium mb-2">Lanes a competent answer should be able to offer</legend>
          <div className="flex gap-4">
            {ROUTE_TYPES.map((lane) => (
              <label key={lane} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={lanes.includes(lane)}
                  onChange={(event) => setLanes((current) => (
                    event.target.checked ? [...current, lane] : current.filter((entry) => entry !== lane)
                  ))}
                  data-testid={`gold-lane-${lane}`}
                />
                {lane}
              </label>
            ))}
          </div>
        </fieldset>

        <div>
          <Label htmlFor="gold-ranking">Ranking mode</Label>
          <select
            id="gold-ranking"
            className="w-full bg-bh-surface border border-bh-border/60 rounded-md px-3 py-2 text-sm"
            value={rankingMode}
            onChange={(event) => setRankingMode(event.target.value)}
            data-testid="gold-ranking"
          >
            {RANKING_MODES.map((mode) => <option key={mode} value={mode}>{mode.replace(/_/g, ' ')}</option>)}
          </select>
        </div>

        <div>
          <Label htmlFor="gold-notes">Why this judgment (optional)</Label>
          <Input
            id="gold-notes"
            placeholder="What a reviewer should know if they disagree with it later"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            data-testid="gold-notes"
          />
        </div>

        <Button
          type="submit"
          disabled={saving || briefText.trim().length === 0 || capabilities.length === 0}
          data-testid="gold-submit"
        >
          {saving ? 'Saving…' : 'Add human judgment'}
        </Button>
      </form>

      <h2 className="text-lg font-semibold mb-3">Stored judgments</h2>
      {briefs === null ? (
        <p className="text-sm text-bh-text-muted" aria-live="polite">Loading…</p>
      ) : briefs.length === 0 ? (
        <p className="text-sm text-bh-text-muted" data-testid="gold-empty">
          Nothing yet. The 60 synthetic briefs live in the repository, not here.
        </p>
      ) : (
        <ul className="space-y-3" data-testid="gold-list">
          {briefs.map((row) => (
            <li key={row.id} className="card p-4 border border-bh-border/60 rounded-xl" data-testid={`gold-row-${row.id}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm">{row.briefText}</p>
                  <p className="text-xs text-bh-text-dim mt-1">
                    {row.expected.domain.replace(/_/g, ' ')} · {row.expected.capabilityKeys.join(', ')} ·{' '}
                    {new Date(row.createdAt).toLocaleDateString()}
                  </p>
                  {row.notes && <p className="text-xs text-bh-text-muted mt-1">{row.notes}</p>}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    const remove = deleteBrief ?? defaultDeleteBrief
                    void remove(row.id).then(load).catch(() => setError('Could not delete that judgment.'))
                  }}
                  data-testid={`gold-delete-${row.id}`}
                  aria-label={`Delete judgment ${row.id}`}
                >
                  <Trash2 className="w-4 h-4" aria-hidden="true" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const ENDPOINT = '/api/admin/solutions/gold-briefs'

const defaultFetchBriefs = (): Promise<{ briefs: GoldBriefRow[] }> =>
  fetch(ENDPOINT, { credentials: 'include' }).then((response) => {
    if (!response.ok) throw new Error('failed')
    return response.json()
  })

const defaultCreateBrief = (input: unknown): Promise<{ id: string }> =>
  fetch(ENDPOINT, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }).then((response) => {
    if (!response.ok) throw new Error('failed')
    return response.json()
  })

const defaultDeleteBrief = (id: string): Promise<void> =>
  fetch(ENDPOINT, {
    method: 'DELETE',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  }).then((response) => {
    if (!response.ok) throw new Error('failed')
  })
