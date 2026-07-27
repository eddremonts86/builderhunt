/**
 * Style matching panel (plan: code-fingerprinting Phase 4).
 *
 * Paste a source file, rank your tracked builders by how closely their
 * AI-analyzed code style matches it.
 *
 * Density-gated on purpose: ranking against two fingerprints is noise dressed
 * up as a result. Below the threshold the panel explains how to get there
 * instead of rendering an input that produces a meaningless list — the server
 * returns `eligibleCount` on every response precisely so this can be honest.
 */
import * as React from 'react'
import { Link } from '@tanstack/react-router'
import { Fingerprint, Loader2 } from 'lucide-react'
import { Button, Textarea } from '~/components/ui'

const DENSITY_THRESHOLD = 20

interface Match {
  builderId: string
  username: string
  score: number
}

type PanelState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'results'; matches: Match[] }
  | { kind: 'plan' }
  | { kind: 'error'; message: string }

export function StyleMatchPanel() {
  const [eligibleCount, setEligibleCount] = React.useState<number | null>(null)
  const [content, setContent] = React.useState('')
  const [state, setState] = React.useState<PanelState>({ kind: 'idle' })

  // GET is the density probe: it spends no budget and never reaches the
  // model. Deliberately not an empty POST — POST validates the body first and
  // would report 0 regardless of the real count.
  React.useEffect(() => {
    let cancelled = false
    fetch('/api/fingerprint/match', { credentials: 'include' })
      .then((r) => r.json())
      .then((data) => { if (!cancelled) setEligibleCount(data.eligibleCount ?? 0) })
      .catch(() => { if (!cancelled) setEligibleCount(0) })
    return () => { cancelled = true }
  }, [])

  const submit = async () => {
    if (!content.trim()) return
    setState({ kind: 'loading' })
    try {
      const res = await fetch('/api/fingerprint/match', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, filename: 'pasted-sample' }),
      })
      const data = await res.json().catch(() => ({}))
      if (typeof data.eligibleCount === 'number') setEligibleCount(data.eligibleCount)
      if (res.status === 429 && data.error === 'plan') return setState({ kind: 'plan' })
      if (!res.ok || !Array.isArray(data.matches)) {
        return setState({ kind: 'error', message: 'Could not match that sample right now.' })
      }
      setState({ kind: 'results', matches: data.matches })
    } catch {
      setState({ kind: 'error', message: 'Could not match that sample right now.' })
    }
  }

  if (eligibleCount === null) return null

  return (
    <div className="card p-5" data-testid="style-match-panel" data-eligible-count={eligibleCount}>
      <h3 className="text-base font-semibold text-bh-text flex items-center gap-2 mb-1">
        <Fingerprint className="w-4 h-4 text-bh-accent" aria-hidden="true" />
        Match a code sample
      </h3>

      {eligibleCount < DENSITY_THRESHOLD ? (
        <p className="text-xs text-bh-text-dim" data-testid="style-match-locked">
          Analyze the real code of at least {DENSITY_THRESHOLD} tracked builders to unlock style
          matching — {eligibleCount} of {DENSITY_THRESHOLD} so far. Use “Analyze real code” on a{' '}
          {/*
            Underlined at rest, not only on hover. This link sits inside a sentence, and against the
            surrounding `text-bh-text-dim` the accent colour measures 1.26:1 — far under the 3:1 that
            WCAG 1.4.1 requires before colour alone may carry the distinction. Hover does not help a
            reader who never hovers, and nothing helps one who cannot perceive the hue. Standalone
            accent links elsewhere are fine and deliberately left as they are: axe flags only links in
            a text block, because those are the ones a reader has to pick out of running prose.
          */}
          <Link to="/search" className="text-bh-accent underline">GitHub builder&apos;s profile</Link>{' '}
          to add one.
        </p>
      ) : (
        <>
          <p className="text-xs text-bh-text-dim mb-3">
            Paste a source file and we'll rank your {eligibleCount} analyzed builders by style
            similarity.
          </p>
          <Textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Paste a source file…"
            className="font-mono text-xs"
            data-testid="style-match-input"
          />
          <div className="mt-2">
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={submit}
              disabled={state.kind === 'loading' || !content.trim()}
              data-testid="style-match-submit"
            >
              {state.kind === 'loading'
                ? <><Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />Matching…</>
                : 'Find similar builders'}
            </Button>
          </div>

          {state.kind === 'plan' && (
            <p className="text-xs text-bh-text-muted mt-3">
              Style matching is a Pro feature — upgrade to rank builders by code style.
            </p>
          )}
          {state.kind === 'error' && <p className="text-xs text-bh-danger mt-3">{state.message}</p>}
          {state.kind === 'results' && (
            <ul className="mt-3 space-y-1.5" data-testid="style-match-results">
              {state.matches.length === 0 && (
                <li className="text-xs text-bh-text-dim">No close matches among your analyzed builders.</li>
              )}
              {state.matches.map((match) => (
                <li key={match.builderId} className="flex items-center justify-between gap-3 text-sm">
                  <Link
                    to="/builder/$builderId"
                    params={{ builderId: match.builderId }}
                    className="text-bh-text hover:text-bh-accent truncate"
                  >
                    {match.username}
                  </Link>
                  <span className="text-xs font-semibold text-bh-accent shrink-0">
                    {Math.round(match.score)}% match
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
