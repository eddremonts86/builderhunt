import * as React from 'react'
import { Link, useNavigate, useLocation } from '@tanstack/react-router'
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu'
import { Button, LinkButton } from '~/components/ui'
import { ChevronDown, LayoutDashboard, LogOut, Menu } from 'lucide-react'
import { signOut } from '~/shared/lib/auth/client'
import { BrandLogoMark } from '~/shared/components/BrandLogoMark'
import { PublicNavDrawer, type PublicNavGroup } from '~/shared/components/PublicNavDrawer'
import { ICON_TRANSITION, useSlidingIndicator, SlidingIndicator } from '~/shared/lib/useSlidingIndicator'
import { useScrollSpy } from '~/shared/lib/useScrollSpy'
import { ThemeToggle } from '~/shared/components/ThemeToggle'
import { DESKTOP_NAV_VISIBLE, MOBILE_TRIGGER_VISIBLE } from '~/shared/components/publicNavBreakpoint'

const NAV_LINKS = [
  { id: 'how-it-works', label: 'How it works' },
  { id: 'use-cases', label: 'Use cases' },
  { id: 'sources', label: 'Sources' },
  { id: 'faq', label: 'FAQ' },
] as const
const NAV_SECTION_IDS = NAV_LINKS.map((l) => l.id)

// Breakpoint classes live in `publicNavBreakpoint.ts` — see that file for why 1280 and why one source. 

// Every non-home public destination, grouped the way a first-time visitor
// would look for it — what the product does, how to learn about it, and why
// to trust it. Also the source of truth for the mobile drawer's link list.
const NAV_GROUPS: readonly PublicNavGroup[] = [
  { label: 'Product', items: [{ to: '/explore', label: 'Explore' }, { to: '/pricing', label: 'Pricing' }] },
  { label: 'Learn', items: [{ to: '/blog', label: 'Blog' }, { to: '/changelog', label: 'Changelog' }, { to: '/roadmap', label: 'Roadmap' }] },
  { label: 'Trust', items: [{ to: '/status', label: 'Status' }, { to: '/security', label: 'Security' }] },
]

function NavGroupMenu({ group }: { group: PublicNavGroup }) {
  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        <button
          type="button"
          className={`relative flex items-center gap-1 whitespace-nowrap rounded-full px-3.5 h-9 text-sm font-medium ${ICON_TRANSITION} text-bh-text-muted hover:text-bh-text data-[state=open]:text-bh-text`}
        >
          {group.label}
          <ChevronDown className="size-3.5" aria-hidden="true" />
        </button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align="start"
          sideOffset={8}
          className="z-50 min-w-[10rem] rounded-xl border border-bh-border bg-bh-surface p-1.5 shadow-xl animate-slide-in-up"
        >
          {group.items.map((item) => (
            <DropdownMenuPrimitive.Item key={item.to} asChild>
              <Link
                to={item.to}
                className="block cursor-pointer rounded-lg px-3 py-2 text-sm text-bh-text-muted outline-none hover:bg-bh-bg-alt hover:text-bh-text data-[highlighted]:bg-bh-bg-alt data-[highlighted]:text-bh-text"
              >
                {item.label}
              </Link>
            </DropdownMenuPrimitive.Item>
          ))}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  )
}

export interface HeaderProps {
  /**
   * Passed in rather than read from `useSession()` here.
   *
   * A client hook gives the server no answer, so this header rendered signed-out during SSR and
   * possibly signed-in on the client's first pass — a hydration mismatch, and a flash of the wrong
   * CTA. The caller resolves the session in `beforeLoad`, where the server can answer.
   *
   * A prop rather than route context because this component lives in `shared/`: `_landing/route.tsx`
   * is its only call site today, and reading `useRouteContext({ from: '/_landing' })` from here would
   * pin a shared component to one route id.
   */
  isAuthed: boolean
}

export function Header({ isAuthed }: HeaderProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const [signingOut, setSigningOut] = React.useState(false)
  const [drawerOpen, setDrawerOpen] = React.useState(false)
  const pillRowRef = React.useRef<HTMLUListElement>(null)
  const menuTriggerRef = React.useRef<HTMLButtonElement>(null)

  const isHome = location.pathname === '/'
  const activeSection = useScrollSpy(NAV_SECTION_IDS)
  const indicator = useSlidingIndicator(pillRowRef, [isHome ? activeSection : ''])

  const handleSignOut = async () => {
    setSigningOut(true)
    try {
      await signOut()
    } finally {
      navigate({ to: '/' })
    }
  }

  return (
    <header
      className="topbar-shell z-40 flex items-center justify-between gap-1.5 glass-topbar rounded-full px-2 py-1.5"
      aria-label="Primary"
    >
      <Link to="/" className="flex items-center gap-2.5 group shrink-0 px-1.5" aria-label="BuilderHunt home">
        <BrandLogoMark />
        <span className="font-bold text-base tracking-tight hidden sm:inline">BuilderHunt</span>
      </Link>

      <div className={`relative ${DESKTOP_NAV_VISIBLE} items-center gap-1`}>
        <ul ref={pillRowRef} className="relative flex items-center gap-1">
          {isHome && <SlidingIndicator rect={indicator} />}
          {NAV_LINKS.map((l) => {
            const active = isHome && activeSection === l.id
            if (isHome) {
              return (
                <li key={l.id} className="relative z-10">
                  <a
                    href={`#${l.id}`}
                    data-active={active || undefined}
                    className={`relative rounded-full flex items-center whitespace-nowrap px-3.5 h-9 text-sm font-medium ${ICON_TRANSITION} ${
                      active ? 'text-white' : 'text-bh-text-muted hover:text-bh-text'
                    }`}
                  >
                    {l.label}
                  </a>
                </li>
              )
            } else {
              return (
                <li key={l.id} className="relative z-10">
                  <Link
                    to="/"
                    hash={l.id}
                    className={`relative rounded-full flex items-center whitespace-nowrap px-3.5 h-9 text-sm font-medium ${ICON_TRANSITION} text-bh-text-muted hover:text-bh-text`}
                  >
                    {l.label}
                  </Link>
                </li>
              )
            }
          })}
        </ul>
        {NAV_GROUPS.map((group) => (
          <NavGroupMenu key={group.label} group={group} />
        ))}
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <ThemeToggle compact />
        <button
          ref={menuTriggerRef}
          type="button"
          onClick={() => setDrawerOpen(true)}
          aria-label="Open menu"
          className={`${MOBILE_TRIGGER_VISIBLE} h-9 w-9 place-items-center rounded-full text-bh-text-muted hover:bg-bh-bg-alt hover:text-bh-text`}
        >
          <Menu className="w-4 h-4" aria-hidden="true" />
        </button>
        {isAuthed ? (
          <div className={`${DESKTOP_NAV_VISIBLE} items-center gap-2`}>
            <LinkButton to="/dashboard" variant="secondary" size="sm">
              <LayoutDashboard className="w-4 h-4" /> Dashboard
            </LinkButton>
            <Button
              type="button"
              onClick={handleSignOut}
              disabled={signingOut}
              variant="ghost"
              size="sm"
              aria-label="Sign out"
            >
              {signingOut ? (
                <span className="spinner" aria-hidden="true" />
              ) : (
                <LogOut className="w-4 h-4" aria-hidden="true" />
              )}
              <span className="hidden sm:inline">Sign out</span>
            </Button>
          </div>
        ) : (
          <div className={`${DESKTOP_NAV_VISIBLE} items-center gap-2`}>
            <LinkButton to="/auth/sign-in" variant="ghost">Sign in</LinkButton>
            <LinkButton to="/auth/sign-up" variant="primary" size="sm">Get started</LinkButton>
          </div>
        )}
      </div>

      <PublicNavDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        triggerRef={menuTriggerRef}
        homeAnchors={NAV_LINKS}
        groups={NAV_GROUPS}
        isHome={isHome}
        pathname={location.pathname}
        isAuthed={isAuthed}
        onSignOut={handleSignOut}
        signingOut={signingOut}
      />
    </header>
  )
}
