/**
 * List detail page — plan 28 (shared-resources) task 8; edit dialog added by
 * plans/UI/tasks.md Wave 2 "Shortlist metadata and visibility editing".
 *
 * Shows the members of a builder shortlist and lets an authorized member edit
 * its metadata or remove entries. Both actions share the same permission
 * shape as the server (`resource:update` — creator, or an elevated owner/admin
 * member of an organization-visible list), computed by `canEditList` below so
 * the button a viewer sees always matches what `/api/lists/:id` will actually
 * accept.
 */
import * as React from 'react'
import { useNavigate, useParams, useLocation, Link } from '@tanstack/react-router'
import { AlertTriangle, ArrowLeft, Lock, Pencil, Search, Trash2, Users, UserMinus } from 'lucide-react'
import { Button, Dialog, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea } from '~/components/ui'
import { useEntityBreadcrumbLabel } from '~/modules/dashboard/ui/shell/breadcrumb-context'
import { can, type TenantPrincipal } from '~/shared/lib/authorization/permissions'
import { resolveSafeBuilderFrom } from '~/shared/lib/safe-next'

export interface BuilderListDetail extends Record<string, unknown> {
  id: string
  organizationId: string
  createdByUserId: string
  name: string
  description: string | null
  visibility: 'private' | 'organization'
  version: number
  createdAt: string
  updatedAt: string
}

export interface BuilderListItemDetail {
  id: string
  listId: string
  organizationId: string
  builderIdentityId: string
  createdByUserId: string
  createdAt: string
  /** The tenant-scoped id `/builder/$builderId` navigates by — never `builderIdentityId`, which is global. */
  organizationBuilderId?: string | null
  /** Optional denormalized display fields the API may surface for UX. */
  displayName?: string | null
  username?: string | null
  profileUrl?: string | null
  avatarUrl?: string | null
  source?: string | null
}

export interface ListDetailPageProps {
  initialList: BuilderListDetail
  initialItems: BuilderListItemDetail[]
  currentUser: { userId: string; role: 'owner' | 'admin' | 'member' }
}

function toPrincipal(list: BuilderListDetail, currentUser: { userId: string; role: 'owner' | 'admin' | 'member' }): TenantPrincipal {
  return { userId: currentUser.userId, organizationId: list.organizationId, role: currentUser.role, requestId: 'client' }
}

/** Same check the server's `resource:update`/`resource:delete` boundary makes — creator always, or an elevated (owner/admin) member when the list is organization-visible. A plain member of a shared list can see it but not edit or remove from it. */
function canEditList(
  list: BuilderListDetail,
  currentUser: { userId: string; role: 'owner' | 'admin' | 'member' },
): boolean {
  return can(toPrincipal(list, currentUser), 'resource:update', {
    creatorUserId: list.createdByUserId,
    visibility: list.visibility === 'organization' ? 'organization' : 'private',
  })
}

function canRemoveFromList(
  list: BuilderListDetail,
  _item: BuilderListItemDetail,
  currentUser: { userId: string; role: 'owner' | 'admin' | 'member' },
): boolean {
  return can(toPrincipal(list, currentUser), 'resource:delete', {
    creatorUserId: list.createdByUserId,
    visibility: list.visibility === 'organization' ? 'organization' : 'private',
  })
}

export function ListDetailPage({ initialList, initialItems, currentUser }: ListDetailPageProps) {
  const params = useParams({ strict: false }) as { listId?: string }
  const listId = params.listId ?? initialList.id
  const navigate = useNavigate()
  const location = useLocation()
  const from = resolveSafeBuilderFrom(`${location.pathname}${location.searchStr}`)
  const [list, setList] = React.useState<BuilderListDetail>(initialList)
  const [items, setItems] = React.useState<BuilderListItemDetail[]>(initialItems)
  const [removingId, setRemovingId] = React.useState<string | null>(null)
  const [loadError, setLoadError] = React.useState<string | null>(null)

  useEntityBreadcrumbLabel(list.name)

  const load = React.useCallback(async () => {
    setLoadError(null)
    try {
      const [listRes, itemsRes] = await Promise.all([
        fetch(`/api/lists/${listId}`, { credentials: 'include' }),
        fetch(`/api/lists/${listId}/items`, { credentials: 'include' }),
      ])
      if (listRes.status === 404 || itemsRes.status === 404) {
        setLoadError('List not found.')
        setList((prev) => prev)
        setItems([])
        return
      }
      if (!listRes.ok || !itemsRes.ok) {
        setLoadError('Could not load list.')
        return
      }
      const listData = (await listRes.json()) as BuilderListDetail
      const itemsData = (await itemsRes.json()) as BuilderListItemDetail[]
      setList(listData)
      setItems(Array.isArray(itemsData) ? itemsData : [])
    } catch {
      setLoadError('Could not load list.')
    }
  }, [listId])

  React.useEffect(() => {
    if (initialItems.length === 0) load()
  }, [load, initialItems.length])

  const removeItem = async (itemId: string) => {
    setRemovingId(itemId)
    try {
      await fetch(`/api/lists/${listId}/items/${itemId}`, {
        method: 'DELETE',
        credentials: 'include',
      })
      await load()
    } finally {
      setRemovingId(null)
    }
  }

  const [editOpen, setEditOpen] = React.useState(false)
  const [editName, setEditName] = React.useState(list.name)
  const [editDescription, setEditDescription] = React.useState(list.description ?? '')
  const [editVisibility, setEditVisibility] = React.useState<'private' | 'organization'>(list.visibility)
  const [editSaving, setEditSaving] = React.useState(false)
  const [editError, setEditError] = React.useState<string | null>(null)
  const [editConflict, setEditConflict] = React.useState(false)

  const openEdit = () => {
    setEditName(list.name)
    setEditDescription(list.description ?? '')
    setEditVisibility(list.visibility)
    setEditError(null)
    setEditConflict(false)
    setEditOpen(true)
  }

  const saveEdit = async (event: React.FormEvent) => {
    event.preventDefault()
    setEditSaving(true)
    setEditError(null)
    setEditConflict(false)
    try {
      const res = await fetch(`/api/lists/${listId}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedVersion: list.version,
          name: editName.trim(),
          description: editDescription.trim() || null,
          visibility: editVisibility,
        }),
      })
      if (res.status === 409) {
        setEditConflict(true)
        return
      }
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setEditError(body.message ?? 'Could not save changes. Please try again.')
        return
      }
      setList(body as BuilderListDetail)
      setEditOpen(false)
    } catch {
      setEditError('Could not save changes. Please try again.')
    } finally {
      setEditSaving(false)
    }
  }

  const reloadAfterConflict = async () => {
    await load()
    setEditConflict(false)
    setEditOpen(false)
  }

  const isShared = list.visibility === 'organization'
  const canEdit = canEditList(list, currentUser)
  const visibilityWillChange = editVisibility !== list.visibility

  return (
    <div data-testid="list-detail-page">
      <button
        type="button"
        onClick={() => navigate({ to: '/lists' })}
        className="inline-flex items-center gap-1 text-sm text-bh-text-muted hover:text-bh-accent mb-4"
        data-testid="back-to-lists"
      >
        <ArrowLeft className="w-4 h-4" aria-hidden="true" />
        All shortlists
      </button>

      <header className="mb-6">
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <h1 className="text-2xl font-bold tracking-tight">{list.name}</h1>
          <span
            className={`inline-flex items-center gap-1 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${
              isShared
                ? 'bg-bh-accent-soft text-bh-accent'
                : 'bg-bh-surface text-bh-text-dim'
            }`}
            data-testid="list-detail-visibility-badge"
          >
            {isShared ? <Users className="w-3 h-3" aria-hidden="true" /> : <Lock className="w-3 h-3" aria-hidden="true" />}
            {isShared ? 'Team' : 'Private'}
          </span>
          {canEdit && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={openEdit}
              className="ml-auto"
              data-testid="list-edit-open"
            >
              <Pencil className="w-3.5 h-3.5" aria-hidden="true" />
              Edit
            </Button>
          )}
        </div>
        {list.description && (
          <p className="text-sm text-bh-text-muted">{list.description}</p>
        )}
      </header>

      <Dialog open={editOpen} onClose={() => setEditOpen(false)} title="Edit shortlist">
        <form onSubmit={saveEdit} className="space-y-4" data-testid="list-edit-form">
          <div>
            <label htmlFor="list-edit-name" className="block text-xs font-medium text-bh-text-muted mb-1">Name</label>
            <Input
              id="list-edit-name"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              required
              maxLength={120}
              data-testid="list-edit-name"
            />
          </div>
          <div>
            <label htmlFor="list-edit-description" className="block text-xs font-medium text-bh-text-muted mb-1">Description</label>
            <Textarea
              id="list-edit-description"
              value={editDescription}
              onChange={(e) => setEditDescription(e.target.value)}
              maxLength={2000}
              rows={3}
              data-testid="list-edit-description"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-bh-text-muted mb-1">Visibility</label>
            <Select value={editVisibility} onValueChange={(v) => setEditVisibility(v as 'private' | 'organization')}>
              <SelectTrigger data-testid="list-edit-visibility">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="private">Private — only you</SelectItem>
                <SelectItem value="organization">Team — anyone in your organization</SelectItem>
              </SelectContent>
            </Select>
            {visibilityWillChange && (
              <p className="mt-2 flex items-start gap-1.5 text-xs text-bh-warning" role="alert" data-testid="list-edit-visibility-warning">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" />
                {editVisibility === 'organization'
                  ? 'Making this shortlist team-visible lets any member of your organization see and manage its builders.'
                  : 'Making this shortlist private hides it from your team — members who could see it will lose access immediately.'}
              </p>
            )}
          </div>

          {editConflict && (
            <p className="text-xs text-bh-danger" role="alert" data-testid="list-edit-conflict">
              This shortlist changed while you were editing.{' '}
              <button type="button" className="underline font-medium" onClick={reloadAfterConflict}>
                Reload to see the newer version
              </button>.
            </p>
          )}
          {editError && (
            <p className="text-xs text-bh-danger" role="alert">{editError}</p>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button type="submit" variant="primary" size="sm" disabled={editSaving || editName.trim().length === 0} data-testid="list-edit-save">
              {editSaving ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </form>
      </Dialog>

      {loadError && (
        <p className="text-sm text-bh-danger mb-4" role="alert">{loadError}</p>
      )}

      {items.length === 0 ? (
        <div className="card p-8 text-center" data-testid="list-empty">
          <UserMinus className="w-8 h-8 mx-auto text-bh-text-dim mb-2" aria-hidden="true" />
          <p className="text-bh-text-muted">No builders in this shortlist yet.</p>
          <p className="text-sm text-bh-text-dim mt-2 mb-4">
            Add builders from search results or the alerts inbox.
          </p>
          <Link to="/search" className="btn-secondary btn-sm inline-flex items-center gap-1.5" data-testid="list-empty-search-cta">
            <Search className="w-3.5 h-3.5" aria-hidden="true" />
            Search builders
          </Link>
        </div>
      ) : (
        <ul className="space-y-2" data-testid="list-items">
          {items.map((item) => {
            const canRemove = canRemoveFromList(list, item, currentUser)
            const label = item.displayName ?? item.username ?? item.builderIdentityId
            return (
              <li key={item.id} className="card p-4 flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  {item.organizationBuilderId ? (
                    <Link
                      to="/builder/$builderId"
                      params={{ builderId: item.organizationBuilderId }}
                      search={{ from }}
                      className="font-semibold text-sm truncate text-bh-text hover:text-bh-accent hover:underline block"
                      data-testid={`list-item-open-${item.id}`}
                    >
                      {label}
                    </Link>
                  ) : (
                    <div className="font-semibold text-sm truncate">{label}</div>
                  )}
                  {item.username && item.displayName && (
                    <div className="text-xs text-bh-text-muted">@{item.username}</div>
                  )}
                  {item.source && (
                    <div className="text-[10px] uppercase tracking-wider text-bh-text-dim mt-0.5">{item.source}</div>
                  )}
                </div>
                {canRemove && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => removeItem(item.id)}
                    disabled={removingId === item.id}
                    aria-label={`Remove ${item.displayName ?? item.username ?? 'builder'} from list`}
                    data-testid={`list-item-remove-${item.id}`}
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
