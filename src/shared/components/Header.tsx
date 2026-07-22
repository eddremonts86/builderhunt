import * as React from 'react'
import { Link, useNavigate, useLocation } from '@tanstack/react-router'
import { LinkButton } from '~/components/ui'
import { LayoutDashboard, LogOut } from 'lucide-react'
import { useSession, signOut } from '~/shared/lib/auth/client'
import { BrandLogoMark } from '~/shared/components/BrandLogoMark'
import { ICON_TRANSITION, useSlidingIndicator, SlidingIndicator } from '~/shared/lib/useSlidingIndicator'
import { useScrollSpy } from '~/shared/lib/useScrollSpy'
import { ThemeToggle } from '~/shared/components/ThemeToggle'

const NAV_LINKS = [
  { id: 'how-it-works', label: 'How it works' },
  { id: 'use-cases', label: 'Use cases' },
  { id: 'sources', label: 'Sources' },
  { id: 'faq', label: 'FAQ' },
] as const
const NAV_SECTION_IDS = NAV_LINKS.map((l) => l.id)

export function Header() {
  const session = useSession()
  const navigate = useNavigate()
  const location = useLocation()
  const [signingOut, setSigningOut] = React.useState(false)
  const pillRowRef = React.useRef<HTMLUListElement>(null)
  
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

  const isAuthed = !!session.data?.user

  return (
    <header
      className="fixed top-4 inset-x-4 md:inset-x-6 lg:inset-x-10 z-40 flex items-center justify-between gap-1.5 glass-topbar rounded-full px-2 py-1.5"
      aria-label="Primary"
    >
      <Link to="/" className="flex items-center gap-2.5 group shrink-0 px-1.5" aria-label="BuilderHunt home">
        <BrandLogoMark />
        <span className="font-bold text-base tracking-tight hidden sm:inline">BuilderHunt</span>
      </Link>

      <ul ref={pillRowRef} className="relative hidden md:flex items-center gap-1">
        {isHome && <SlidingIndicator rect={indicator} />}
        {NAV_LINKS.map((l) => {
          const active = isHome && activeSection === l.id
          if (isHome) {
            return (
              <li key={l.id} className="relative z-10">
                <a
                  href={`#${l.id}`}
                  data-active={active || undefined}
                  className={`relative rounded-full flex items-center px-3.5 h-9 text-sm font-medium ${ICON_TRANSITION} ${
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
                  className={`relative rounded-full flex items-center px-3.5 h-9 text-sm font-medium ${ICON_TRANSITION} text-bh-text-muted hover:text-bh-text`}
                >
                  {l.label}
                </Link>
              </li>
            )
          }
        })}
      </ul>

      <div className="flex items-center gap-2 shrink-0">
        <ThemeToggle />
        {isAuthed ? (
          <>
            <LinkButton to="/dashboard" variant="secondary" className="btn-sm">
              <LayoutDashboard className="w-4 h-4" /> Dashboard
            </LinkButton>
            <button
              type="button"
              onClick={handleSignOut}
              disabled={signingOut}
              className="btn-ghost btn-sm"
              aria-label="Sign out"
            >
              {signingOut ? (
                <span className="spinner" aria-hidden="true" />
              ) : (
                <LogOut className="w-4 h-4" aria-hidden="true" />
              )}
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </>
        ) : (
          <>
            <LinkButton to="/auth/sign-in" variant="ghost" className="hidden sm:inline-flex">Sign in</LinkButton>
            <LinkButton to="/auth/sign-up" variant="primary" className="btn-sm">Get started</LinkButton>
          </>
        )}
      </div>
    </header>
  )
}
