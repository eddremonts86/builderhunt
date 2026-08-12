import * as React from 'react'
import { Button } from '~/components/ui'

interface BetaModeState {
  enabled: boolean
  revision: number
  updatedAt: string
  updatedBy: string | null
}

type Phase = 'loading' | 'ready' | 'confirming' | 'saving' | 'unavailable'

/**
 * The switch that grants every organization in the system Pro Max product access (plan 58, task 8).
 *
 * ## Why it confirms
 *
 * This is not a preference. Enabling it changes what every tenant may spend and disabling it stops
 * provider-backed work for all of them at once — a misclick is an incident either way. So the control
 * states what will happen, in the direction it is about to go, and waits.
 *
 * ## Why the revision is on screen
 *
 * The `PUT` carries `expectedRevision` and the server answers `409` if it has moved. Showing the number
 * is not decoration: when a conflict happens, the operator needs to see that the value they were looking
 * at is not the value that exists, and a page that silently reloaded would leave them unsure whether
 * their click did anything.
 *
 * ## Why a conflict is not an error
 *
 * A `409` means somebody else already made a decision. It adopts the winning state rather than showing a
 * red failure, tells the operator exactly that, and leaves them to decide again against the truth. The
 * server sends the current document with the conflict precisely so this can happen in one round trip.
 */
export function BetaModeControl() {
  const [state, setState] = React.useState<BetaModeState | null>(null)
  const [phase, setPhase] = React.useState<Phase>('loading')
  const [notice, setNotice] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    try {
      const response = await fetch('/api/admin/billing/beta-mode', { credentials: 'include' })
      if (!response.ok) {
        setPhase('unavailable')
        return
      }
      setState(await response.json() as BetaModeState)
      setPhase('ready')
    } catch {
      setPhase('unavailable')
    }
  }, [])

  React.useEffect(() => { void load() }, [load])

  async function commit(enabled: boolean) {
    if (!state) return
    setPhase('saving')
    setNotice(null)
    try {
      const response = await fetch('/api/admin/billing/beta-mode', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, expectedRevision: state.revision }),
      })
      const body = await response.json().catch(() => null) as (BetaModeState & { error?: string }) | null

      if (response.status === 409 && body) {
        // Adopt reality, say so, and let them decide again. Not a failure — someone else decided first.
        setState({ enabled: body.enabled, revision: body.revision, updatedAt: body.updatedAt, updatedBy: body.updatedBy })
        setNotice('Someone else changed beta mode while this page was open. Showing the current state — review it and try again.')
        setPhase('ready')
        return
      }
      if (!response.ok || !body) {
        setNotice('The change could not be saved. Nothing was altered.')
        setPhase('ready')
        return
      }
      setState({ enabled: body.enabled, revision: body.revision, updatedAt: body.updatedAt, updatedBy: body.updatedBy })
      setPhase('ready')
    } catch {
      setNotice('The change could not be saved. Nothing was altered.')
      setPhase('ready')
    }
  }

  if (phase === 'loading') {
    return (
      <section className="card p-4" data-testid="beta-mode-control">
        <p className="text-sm text-bh-text-muted">Loading beta mode…</p>
      </section>
    )
  }

  if (phase === 'unavailable' || !state) {
    return (
      <section className="card p-4" data-testid="beta-mode-control">
        <h2 className="font-bold mb-1">Beta mode</h2>
        {/*
          Unavailable is not "off". Rendering a switch in the off position for a state we could not read
          would invite an operator to "turn it on" when it may already be on.
        */}
        <p className="text-sm text-bh-warning" data-testid="beta-mode-unavailable">
          The current state could not be read, so no control is shown.
        </p>
        <Button type="button" variant="ghost" className="mt-2 text-sm" onClick={() => { setPhase('loading'); void load() }}>
          Try again
        </Button>
      </section>
    )
  }

  const busy = phase === 'saving'
  const next = !state.enabled

  return (
    <section className="card p-4" data-testid="beta-mode-control" data-enabled={state.enabled ? 'true' : 'false'}>
      <h2 className="font-bold mb-1">Beta mode</h2>
      <p className="text-sm text-bh-text-muted mb-3">
        While enabled, every organization can use Pro Max product capabilities and receives{' '}
        <strong className="text-bh-text">700 beta credits per month</strong>. Purchased plans, seat limits and
        payment blocks are unchanged.
      </p>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-bh-text-dim mb-3">
        <dt>State</dt>
        <dd className="text-bh-text" data-testid="beta-mode-state">{state.enabled ? 'Enabled' : 'Disabled'}</dd>
        <dt>Revision</dt>
        <dd data-testid="beta-mode-revision">{state.revision}</dd>
        <dt>Last change</dt>
        <dd>{state.revision === 0 ? 'never' : new Date(state.updatedAt).toLocaleString()}</dd>
        <dt>Changed by</dt>
        <dd data-testid="beta-mode-actor">{state.updatedBy ?? '—'}</dd>
      </dl>

      {notice && (
        <p className="mb-3 rounded border border-bh-warning/30 bg-bh-warning/5 p-2 text-xs text-bh-warning" role="status" data-testid="beta-mode-notice">
          {notice}
        </p>
      )}

      {phase === 'confirming' ? (
        <div className="rounded border border-bh-border p-3" data-testid="beta-mode-confirm">
          <p className="text-sm text-bh-text mb-2">
            {next
              ? 'Enable beta mode? Every organization will immediately be able to use Pro Max capabilities and spend beta credits.'
              : 'Disable beta mode? Every organization loses Pro Max capabilities and unused beta credits stop being spendable immediately. Purchased and pack credits are unaffected.'}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {/* Cancel first in the DOM, so tab order reaches the reversible action before the committing one. */}
            <Button type="button" variant="ghost" className="text-sm" disabled={busy} onClick={() => setPhase('ready')} data-testid="beta-mode-cancel">
              Cancel
            </Button>
            <Button type="button" variant="primary" className="text-sm" disabled={busy} onClick={() => void commit(next)} data-testid="beta-mode-commit">
              {busy ? 'Saving…' : next ? 'Enable beta mode' : 'Disable beta mode'}
            </Button>
          </div>
        </div>
      ) : (
        <Button type="button" variant={state.enabled ? 'ghost' : 'primary'} className="text-sm" disabled={busy} onClick={() => setPhase('confirming')} data-testid="beta-mode-toggle">
          {state.enabled ? 'Disable beta mode' : 'Enable beta mode'}
        </Button>
      )}
    </section>
  )
}
