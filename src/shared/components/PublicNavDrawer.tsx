import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { MOBILE_DRAWER_VISIBLE } from '~/shared/components/publicNavBreakpoint'
import { Link } from '@tanstack/react-router'
import { LayoutDashboard, LogOut, X } from 'lucide-react'
import { cn } from '~/shared/lib/utils'

export interface PublicNavGroup {
  label: string
  items: Array<{ to: string; label: string }>
}

/**
 * Every destination the marketing header exposes, flattened into one
 * scrollable list — Radix Dialog gives real focus-trap/Escape/overlay-click/
 * focus-restore for free (see `components/ui/dialog.tsx`), so this only needs
 * to worry about layout and current-route state.
 */
export function PublicNavDrawer({
  open,
  onClose,
  homeAnchors,
  groups,
  isHome,
  pathname,
  isAuthed,
  onSignOut,
  signingOut,
  triggerRef,
}: {
  open: boolean
  onClose: () => void
  homeAnchors: ReadonlyArray<{ id: string; label: string }>
  groups: readonly PublicNavGroup[]
  isHome: boolean
  pathname: string
  isAuthed: boolean
  onSignOut: () => void
  signingOut: boolean
  /** Radix restores focus to whatever had it when the dialog opened, which is normally this
   * button — but since it's opened via external state rather than `DialogPrimitive.Trigger`,
   * `onCloseAutoFocus` explicitly re-focuses it as a guaranteed fallback. */
  triggerRef: React.RefObject<HTMLButtonElement | null>
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={`fixed inset-0 z-50 bg-bh-text/25 backdrop-blur-sm animate-fade-in ${MOBILE_DRAWER_VISIBLE}`} />
        <DialogPrimitive.Content
          // A stable hook for the responsive guard. Radix names this dialog via `aria-labelledby` pointing at
          // its Title, but that name does not resolve reliably at every viewport — `getByRole('dialog',
          // { name: 'Menu' })` found it at 1024px+ and not at 375px, and a test that flaky is worse than none.
          data-testid="public-nav-drawer"
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            triggerRef.current?.focus()
          }}
          className={`fixed inset-y-0 right-0 z-50 flex w-[85vw] max-w-[320px] flex-col bg-bh-surface shadow-2xl outline-none animate-slide-in-right ${MOBILE_DRAWER_VISIBLE}`}
        >
          <div className="flex min-h-[57px] items-center justify-between border-b border-bh-border px-4">
            <DialogPrimitive.Title className="text-[0.9375rem] font-bold tracking-tight">Menu</DialogPrimitive.Title>
            <DialogPrimitive.Close
              aria-label="Close menu"
              className="grid h-8 w-8 place-items-center rounded-full text-bh-text-dim hover:bg-bh-bg-alt hover:text-bh-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </DialogPrimitive.Close>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            <div className="mb-1">
              <p className="px-3 pb-1 pt-3 font-mono text-[0.625rem] uppercase tracking-[0.11em] text-bh-text-dim">Home</p>
              {homeAnchors.map((anchor) =>
                isHome ? (
                  <a
                    key={anchor.id}
                    href={`#${anchor.id}`}
                    onClick={onClose}
                    className="block rounded-xl px-3 py-2 text-sm text-bh-text-muted hover:bg-bh-bg-alt hover:text-bh-text"
                  >
                    {anchor.label}
                  </a>
                ) : (
                  <Link
                    key={anchor.id}
                    to="/"
                    hash={anchor.id}
                    onClick={onClose}
                    className="block rounded-xl px-3 py-2 text-sm text-bh-text-muted hover:bg-bh-bg-alt hover:text-bh-text"
                  >
                    {anchor.label}
                  </Link>
                ),
              )}
            </div>

            {groups.map((group) => (
              <div key={group.label} className="mb-1">
                <p className="px-3 pb-1 pt-3 font-mono text-[0.625rem] uppercase tracking-[0.11em] text-bh-text-dim">{group.label}</p>
                {group.items.map((item) => {
                  const active = pathname === item.to || pathname.startsWith(`${item.to}/`)
                  return (
                    <Link
                      key={item.to}
                      to={item.to}
                      onClick={onClose}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'block rounded-xl px-3 py-2 text-sm',
                        active
                          ? 'bg-bh-accent-soft font-semibold text-bh-accent'
                          : 'text-bh-text-muted hover:bg-bh-bg-alt hover:text-bh-text',
                      )}
                    >
                      {item.label}
                    </Link>
                  )
                })}
              </div>
            ))}
          </div>

          <div className="border-t border-bh-border p-3">
            {isAuthed ? (
              <div className="flex flex-col gap-2">
                <Link
                  to="/dashboard"
                  onClick={onClose}
                  className="flex items-center justify-center gap-2 rounded-xl bg-bh-accent px-3 py-2.5 text-sm font-semibold text-bh-accent-contrast"
                >
                  <LayoutDashboard className="h-4 w-4" aria-hidden="true" />
                  Dashboard
                </Link>
                <button
                  type="button"
                  onClick={() => { onSignOut(); onClose() }}
                  disabled={signingOut}
                  className="flex items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-sm font-medium text-bh-text-muted hover:bg-bh-bg-alt hover:text-bh-text"
                >
                  <LogOut className="h-4 w-4" aria-hidden="true" />
                  Sign out
                </button>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <Link
                  to="/auth/sign-up"
                  onClick={onClose}
                  className="flex items-center justify-center rounded-xl bg-bh-accent px-3 py-2.5 text-sm font-semibold text-bh-accent-contrast"
                >
                  Get started
                </Link>
                <Link
                  to="/auth/sign-in"
                  onClick={onClose}
                  className="flex items-center justify-center rounded-xl px-3 py-2.5 text-sm font-medium text-bh-text-muted hover:bg-bh-bg-alt hover:text-bh-text"
                >
                  Sign in
                </Link>
              </div>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
