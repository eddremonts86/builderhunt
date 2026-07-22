import * as React from 'react'
import { createPortal } from 'react-dom'
import { useNavigate, useRouter } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Building2, Check, ChevronDown } from 'lucide-react'
import { organizationQueryKey } from '~/shared/lib/query-keys'
import { useActiveOrganizationId } from '~/shared/components/TenantQueryProvider'
import { FLOATING_UI_Z } from '~/shared/components/Tooltip'
import { ICON_TRANSITION } from '~/shared/lib/useSlidingIndicator'

interface OrganizationSummary {
  id: string
  name: string
  slug: string
  role: 'owner' | 'admin' | 'member'
  isPersonal: boolean
}

async function fetchMyOrganizations(): Promise<OrganizationSummary[]> {
  const res = await fetch('/api/organizations', { credentials: 'include' })
  if (!res.ok) throw new Error('Failed to load organizations')
  return res.json()
}

export function OrganizationSwitcher() {
  const activeOrganizationId = useActiveOrganizationId()
  const router = useRouter()
  const navigate = useNavigate()
  const [open, setOpen] = React.useState(false)
  const [switchingTo, setSwitchingTo] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [coords, setCoords] = React.useState({ top: 0, left: 0 })
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const panelRef = React.useRef<HTMLDivElement>(null)

  const { data: organizations = [] } = useQuery({
    queryKey: organizationQueryKey(activeOrganizationId, 'my-organizations'),
    queryFn: fetchMyOrganizations,
  })

  const activeOrganization = organizations.find((org) => org.id === activeOrganizationId) ?? null

  const reposition = React.useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    setCoords({ top: rect.bottom + 8, left: rect.right })
  }, [])

  React.useEffect(() => {
    if (!open) return
    reposition()
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, reposition])

  async function handleSwitch(organizationId: string) {
    if (organizationId === activeOrganizationId) {
      setOpen(false)
      return
    }
    setSwitchingTo(organizationId)
    setError(null)
    try {
      const response = await fetch('/api/organizations/switch', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organizationId }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new Error(typeof body.error === 'string' ? body.error : 'Failed to switch organization')
      }
      // Route context's `user.activeOrganizationId` only refreshes when
      // `beforeLoad` re-runs — `invalidate()` forces that, which flows into
      // TenantQueryProvider's own effect and clears every cached query
      // before anything renders under the new organization.
      await router.invalidate()
      setOpen(false)
      navigate({ to: '/dashboard' })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to switch organization')
    } finally {
      setSwitchingTo(null)
    }
  }

  if (organizations.length === 0) return null

  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      onClick={() => setOpen((value) => !value)}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label="Switch organization"
      className={`relative z-10 flex items-center gap-1.5 h-9 pl-2.5 pr-2 rounded-full text-xs font-semibold text-bh-text-dim hover:text-bh-text hover:bg-bh-bg-alt ${ICON_TRANSITION}`}
    >
      <Building2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
      <span className="max-w-[120px] truncate">{activeOrganization?.name ?? 'Select organization'}</span>
      <ChevronDown className="w-3 h-3 shrink-0" aria-hidden="true" />
    </button>
  )

  return (
    <>
      {trigger}
      {open && createPortal(
        <div
          ref={panelRef}
          role="menu"
          aria-label="Organizations"
          className="fixed min-w-[220px] bg-bh-surface border border-bh-border rounded-2xl shadow-lg p-1.5 animate-fade-in-up"
          style={{ zIndex: FLOATING_UI_Z, top: coords.top, left: coords.left, transform: 'translateX(-100%)' }}
        >
          {error && <p className="px-3 py-1.5 text-xs text-bh-danger" role="alert">{error}</p>}
          {organizations.map((org) => {
            const isActive = org.id === activeOrganizationId
            return (
              <button
                key={org.id}
                type="button"
                role="menuitemradio"
                aria-checked={isActive}
                disabled={switchingTo !== null}
                onClick={() => handleSwitch(org.id)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm text-left transition-colors duration-150 disabled:opacity-50 ${
                  isActive
                    ? 'text-bh-accent bg-bh-accent-soft font-semibold'
                    : 'text-bh-text-muted hover:text-bh-text hover:bg-bh-bg-alt'
                }`}
              >
                <span className="flex-1 truncate">
                  {org.name}
                  <span className="block text-[11px] font-normal text-bh-text-dim">
                    {org.isPersonal ? 'Personal' : org.role}
                  </span>
                </span>
                {switchingTo === org.id
                  ? <span className="spinner" aria-hidden="true" />
                  : isActive && <Check className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />}
              </button>
            )
          })}
        </div>,
        document.body,
      )}
    </>
  )
}
