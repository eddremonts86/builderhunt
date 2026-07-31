/**
 * List detail page — plan 28 (shared-resources) task 8.
 *
 * Shows the members of a builder shortlist and lets a member of the
 * owning organization remove entries. The page is read-only for the
 * list metadata (name, description, visibility are set at create
 * time on the index page; editing those is a future task). Removing
 * an item is allowed for any organization member when the list is
 * organization-visible, and for the creator at any visibility — the
 * server endpoint at `/api/lists/:id/items/:itemId` enforces the
 * real boundary.
 */
import * as React from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import { ArrowLeft, Lock, Trash2, Users, UserMinus } from 'lucide-react'
import { Button } from '~/components/ui/button'

export interface BuilderListDetail extends Record<string, unknown> {
  id: string
  organizationId: string
  createdByUserId: string
  name: string
  description: string | null
  visibility: 'private' | 'organization'
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

function canRemoveFromList(
  list: BuilderListDetail,
  _item: BuilderListItemDetail,
  currentUser: { userId: string; role: 'owner' | 'admin' | 'member' },
): boolean {
  // Creator can always remove their own list's items.
  if (list.createdByUserId === currentUser.userId) return true
  // Organization-visible lists: any member can curate.
  if (list.visibility === 'organization') return true
  return false
}

export function ListDetailPage({ initialList, initialItems, currentUser }: ListDetailPageProps) {
  const params = useParams({ strict: false }) as { listId?: string }
  const listId = params.listId ?? initialList.id
  const navigate = useNavigate()
  const [list, setList] = React.useState<BuilderListDetail>(initialList)
  const [items, setItems] = React.useState<BuilderListItemDetail[]>(initialItems)
  const [removingId, setRemovingId] = React.useState<string | null>(null)
  const [loadError, setLoadError] = React.useState<string | null>(null)

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

  const isShared = list.visibility === 'organization'

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
        </div>
        {list.description && (
          <p className="text-sm text-bh-text-muted">{list.description}</p>
        )}
      </header>

      {loadError && (
        <p className="text-sm text-bh-danger mb-4" role="alert">{loadError}</p>
      )}

      {items.length === 0 ? (
        <div className="card p-8 text-center" data-testid="list-empty">
          <UserMinus className="w-8 h-8 mx-auto text-bh-text-dim mb-2" aria-hidden="true" />
          <p className="text-bh-text-muted">No builders in this shortlist yet.</p>
          <p className="text-sm text-bh-text-dim mt-2">
            Add builders from search results or the alerts inbox.
          </p>
        </div>
      ) : (
        <ul className="space-y-2" data-testid="list-items">
          {items.map((item) => {
            const canRemove = canRemoveFromList(list, item, currentUser)
            return (
              <li key={item.id} className="card p-4 flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-sm truncate">
                    {item.displayName ?? item.username ?? item.builderIdentityId}
                  </div>
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
