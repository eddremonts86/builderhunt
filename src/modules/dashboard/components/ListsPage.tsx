/**
 * Lists index page — plan 28 (shared-resources) task 8.
 *
 * Lists are organization-scoped. Two visibility states (private |
 * organization), creator attribution, and a permission-aware delete
 * action — only the creator or an owner/admin of an organization-visible
 * list can delete it. All the writes go through the principal-scoped
 * repository at `/api/lists`, which already enforces the tenant
 * boundary; this page is just the client-side surface.
 */
import * as React from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Lock, Plus, Trash2, Users } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'

export interface BuilderList {
  id: string
  organizationId: string
  createdByUserId: string
  name: string
  description: string | null
  visibility: 'private' | 'organization'
  createdAt: string
  updatedAt: string
}

export interface CurrentUser {
  userId: string
  role: 'owner' | 'admin' | 'member'
}

export interface ListsPageProps {
  initialLists: BuilderList[]
  currentUser: CurrentUser
}

function canDeleteList(list: BuilderList, currentUser: CurrentUser): boolean {
  if (list.createdByUserId === currentUser.userId) return true
  const elevated = currentUser.role === 'owner' || currentUser.role === 'admin'
  return list.visibility === 'organization' && elevated
}

export function ListsPage({ initialLists, currentUser }: ListsPageProps) {
  const navigate = useNavigate()
  const [lists, setLists] = React.useState<BuilderList[]>(initialLists)
  const [showForm, setShowForm] = React.useState(false)
  const [name, setName] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [visibility, setVisibility] = React.useState<'private' | 'organization'>('private')
  const [submitting, setSubmitting] = React.useState(false)
  const [formError, setFormError] = React.useState<string | null>(null)
  const [deletingId, setDeletingId] = React.useState<string | null>(null)
  const [loadError, setLoadError] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    setLoadError(null)
    try {
      const res = await fetch('/api/lists', { credentials: 'include' })
      if (!res.ok) {
        setLoadError(`Could not load lists (${res.status})`)
        return
      }
      const data = (await res.json()) as BuilderList[]
      setLists(Array.isArray(data) ? data : [])
    } catch {
      setLoadError('Could not load lists')
    }
  }, [])

  React.useEffect(() => {
    // Re-fetch whenever the active organization changes (the dashboard
    // shell calls `load()` when the user switches orgs; the component
    // itself just respects whatever initialLists it was given).
    if (initialLists.length === 0 && lists.length === 0) load()
  }, [load, initialLists.length, lists.length])

  const createList = async (e: React.FormEvent) => {
    e.preventDefault()
    setFormError(null)
    setSubmitting(true)
    try {
      const res = await fetch('/api/lists', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || null,
          visibility,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setFormError(typeof data.error === 'string' ? data.error : 'Failed to create list')
        return
      }
      setName('')
      setDescription('')
      setVisibility('private')
      setShowForm(false)
      await load()
    } catch {
      setFormError('Failed to create list')
    } finally {
      setSubmitting(false)
    }
  }

  const deleteList = async (id: string) => {
    setDeletingId(id)
    try {
      await fetch(`/api/lists/${id}`, { method: 'DELETE', credentials: 'include' })
      await load()
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div data-testid="lists-page">
      <header className="mb-6 flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Shortlists</h1>
          <p className="text-sm text-bh-text-muted mt-1">
            Group the builders you are tracking. Share with the team, or keep it private.
          </p>
        </div>
        <Button
          type="button"
          variant="primary"
          data-testid="new-list-button"
          onClick={() => setShowForm((s) => !s)}
        >
          <Plus className="w-4 h-4" aria-hidden="true" />
          {showForm ? 'Cancel' : 'New shortlist'}
        </Button>
      </header>

      {showForm && (
        <form
          onSubmit={createList}
          className="card p-5 mb-6 space-y-4"
          data-testid="list-create-form"
          aria-label="Create a new shortlist"
        >
          <div>
            <label htmlFor="list-name" className="block text-sm font-medium mb-1">Name</label>
            <Input
              id="list-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              required
              data-testid="list-name-input"
            />
          </div>
          <div>
            <label htmlFor="list-description" className="block text-sm font-medium mb-1">Description (optional)</label>
            <Input
              id="list-description"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
              data-testid="list-description-input"
            />
          </div>
          <fieldset>
            <legend className="block text-sm font-medium mb-1">Visibility</legend>
            <div className="flex gap-2" role="radiogroup" aria-label="List visibility">
              <label className="card flex-1 p-3 cursor-pointer has-[:checked]:border-bh-accent has-[:checked]:bg-bh-accent-soft">
                <input
                  type="radio"
                  name="list-visibility"
                  value="private"
                  checked={visibility === 'private'}
                  onChange={() => setVisibility('private')}
                  className="sr-only"
                  data-testid="list-visibility-private"
                />
                <div className="flex items-center gap-2 mb-1">
                  <Lock className="w-4 h-4" aria-hidden="true" />
                  <span className="font-semibold">Private</span>
                </div>
                <p className="text-xs text-bh-text-muted">Only you can see this list.</p>
              </label>
              <label className="card flex-1 p-3 cursor-pointer has-[:checked]:border-bh-accent has-[:checked]:bg-bh-accent-soft">
                <input
                  type="radio"
                  name="list-visibility"
                  value="organization"
                  checked={visibility === 'organization'}
                  onChange={() => setVisibility('organization')}
                  className="sr-only"
                  data-testid="list-visibility-organization"
                />
                <div className="flex items-center gap-2 mb-1">
                  <Users className="w-4 h-4" aria-hidden="true" />
                  <span className="font-semibold">Team</span>
                </div>
                <p className="text-xs text-bh-text-muted">Everyone in this organization can see and edit it.</p>
              </label>
            </div>
          </fieldset>

          {formError && (
            <p className="text-sm text-bh-danger" data-testid="list-form-error" role="alert">{formError}</p>
          )}

          <div className="flex items-center gap-2">
            <Button type="submit" variant="primary" size="sm" disabled={submitting} data-testid="list-submit">
              {submitting ? 'Creating…' : 'Create shortlist'}
            </Button>
            <Button type="button" onClick={() => setShowForm(false)} variant="ghost" size="sm">
              Cancel
            </Button>
          </div>
        </form>
      )}

      {loadError && (
        <p className="text-sm text-bh-danger mb-4" role="alert">{loadError}</p>
      )}

      {lists.length === 0 ? (
        <div className="card p-8 text-center" data-testid="lists-empty">
          <p className="text-bh-text-muted">No shortlists yet.</p>
          <p className="text-sm text-bh-text-dim mt-2">
            Create one and start adding the builders you are tracking.
          </p>
        </div>
      ) : (
        <ul className="space-y-2" data-testid="lists-list">
          {lists.map((list) => {
            const canDelete = canDeleteList(list, currentUser)
            const isShared = list.visibility === 'organization'
            return (
              <li key={list.id} className="card p-4 flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <button
                      type="button"
                      onClick={() => navigate({ to: '/_dashboard/lists/$listId' as never, params: { listId: list.id } as never })}
                      className="font-semibold text-bh-text hover:text-bh-accent truncate text-left"
                      data-testid={`list-link-${list.id}`}
                    >
                      {list.name}
                    </button>
                    <span
                      className={`inline-flex items-center gap-1 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${
                        isShared
                          ? 'bg-bh-accent-soft text-bh-accent'
                          : 'bg-bh-surface text-bh-text-dim'
                      }`}
                      data-testid={`list-visibility-badge-${list.id}`}
                    >
                      {isShared ? <Users className="w-3 h-3" aria-hidden="true" /> : <Lock className="w-3 h-3" aria-hidden="true" />}
                      {isShared ? 'Team' : 'Private'}
                    </span>
                  </div>
                  {list.description && (
                    <p className="text-sm text-bh-text-muted line-clamp-1">{list.description}</p>
                  )}
                </div>
                {canDelete && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => deleteList(list.id)}
                    disabled={deletingId === list.id}
                    aria-label={`Delete list ${list.name}`}
                    data-testid={`list-delete-${list.id}`}
                  >
                    <Trash2 className="w-4 h-4" aria-hidden="true" />
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
