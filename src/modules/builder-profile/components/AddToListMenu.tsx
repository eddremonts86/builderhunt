/**
 * AddToListMenu — plan 28 (shared-resources) task 8.
 *
 * A small "Add to list" affordance that opens a popover listing the
 * active organization's shortlists, plus a "Create new shortlist"
 * link. Picks the canonical `builderIdentityId` from the
 * `organization_builders` table (server-side, via
 * `/api/builders/:id`/`/api/lists/:id/items`).
 *
 * The actual fetch goes to the principal-scoped
 * `/api/lists/:id/items` endpoint, which is idempotent on the
 * `(listId, builderIdentityId)` unique index. A duplicate POST
 * returns 200, so the menu treats any non-error response as success
 * and shows "Already in this list" for the existing entries.
 */
import * as React from 'react'
import { Check, ListPlus, Loader2, Plus } from 'lucide-react'

export interface ShortListOption {
  id: string
  name: string
  visibility: 'private' | 'organization'
  containsBuilder: boolean
}

export interface AddToListMenuProps {
  builderIdentityId: string
  /**
   * Server-side list of shortlists the principal can see, with the
   * "containsBuilder" flag already computed (so we do not have to
   * fetch every list's items on the client). When the page is
   * rendered with the flag pre-computed, this menu is essentially
   * read-only / one click.
   */
  lists?: ShortListOption[]
  /** Called after a successful add; the page can refresh its state. */
  onAdded?: (listId: string) => void
}

export function AddToListMenu({ builderIdentityId, lists, onAdded }: AddToListMenuProps) {
  const [open, setOpen] = React.useState(false)
  const [fetchedLists, setFetchedLists] = React.useState<ShortListOption[] | null>(lists ?? null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [pendingId, setPendingId] = React.useState<string | null>(null)
  const [lastAddedId, setLastAddedId] = React.useState<string | null>(null)
  const containerRef = React.useRef<HTMLDivElement>(null)

  // Close on outside click.
  React.useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  const loadLists = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/lists', { credentials: 'include' })
      if (!res.ok) {
        setError('Could not load your shortlists.')
        return
      }
      const data = (await res.json()) as Array<{ id: string; name: string; visibility: 'private' | 'organization' }>
      setFetchedLists(data.map((l) => ({ ...l, containsBuilder: false })))
    } catch {
      setError('Could not load your shortlists.')
    } finally {
      setLoading(false)
    }
  }, [])

  const onToggle = () => {
    const next = !open
    setOpen(next)
    if (next && !fetchedLists) loadLists()
  }

  const addToList = async (listId: string) => {
    setPendingId(listId)
    setError(null)
    setLastAddedId(null)
    try {
      const res = await fetch(`/api/lists/${listId}/items`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ builderIdentityId }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError(typeof body.error === 'string' ? body.error : 'Could not add to shortlist.')
        return
      }
      setLastAddedId(listId)
      onAdded?.(listId)
      // Mark the list as containing this builder so the next click
      // shows "Already in this list" without a fresh round-trip.
      setFetchedLists((prev) =>
        prev ? prev.map((l) => (l.id === listId ? { ...l, containsBuilder: true } : l)) : prev,
      )
    } catch {
      setError('Could not add to shortlist.')
    } finally {
      setPendingId(null)
    }
  }

  return (
    <div className="relative inline-block" ref={containerRef} data-testid="add-to-list-menu">
      <button
        type="button"
        onClick={onToggle}
        className="btn-secondary btn-sm inline-flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2"
        data-testid="add-to-list-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <ListPlus className="w-4 h-4" aria-hidden="true" />
        Add to shortlist
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-2 z-20 w-72 card p-2 shadow-lg"
          role="menu"
          data-testid="add-to-list-popover"
        >
          {loading && (
            <div className="p-3 text-sm text-bh-text-muted flex items-center gap-2" data-testid="add-to-list-loading">
              <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
              Loading your shortlists…
            </div>
          )}

          {!loading && fetchedLists && fetchedLists.length === 0 && (
            <div className="p-3 text-sm text-bh-text-muted" data-testid="add-to-list-empty">
              You don&apos;t have any shortlists yet. Create one to start grouping builders.
            </div>
          )}

          {!loading && fetchedLists && fetchedLists.length > 0 && (
            <ul className="space-y-1" data-testid="add-to-list-options" role="none">
              {fetchedLists.map((l) => {
                const isPending = pendingId === l.id
                const justAdded = lastAddedId === l.id
                return (
                  <li key={l.id} role="none">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => !l.containsBuilder && addToList(l.id)}
                      disabled={l.containsBuilder || isPending}
                      className="w-full text-left px-2 py-1.5 rounded hover:bg-bh-surface text-sm flex items-center justify-between gap-2 disabled:opacity-60 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent"
                      data-testid={`add-to-list-option-${l.id}`}
                    >
                      <span className="truncate">{l.name}</span>
                      {l.containsBuilder ? (
                        <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-bh-success" data-testid={`add-to-list-in-${l.id}`}>
                          <Check className="w-3 h-3" aria-hidden="true" />
                          In list
                        </span>
                      ) : isPending ? (
                        <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
                      ) : justAdded ? (
                        <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-bh-success" data-testid={`add-to-list-added-${l.id}`}>
                          <Check className="w-3 h-3" aria-hidden="true" />
                          Added
                        </span>
                      ) : null}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}

          {error && (
            <p className="p-2 text-xs text-bh-danger" data-testid="add-to-list-error" role="alert">{error}</p>
          )}

          <div className="border-t border-bh-border mt-1 pt-1">
            <a
              href="/lists"
              className="w-full text-left px-2 py-1.5 rounded hover:bg-bh-surface text-sm flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent"
              data-testid="add-to-list-manage"
            >
              <Plus className="w-3 h-3" aria-hidden="true" />
              Manage shortlists
            </a>
          </div>
        </div>
      )}
    </div>
  )
}
