import * as React from 'react'
import { ArrowUp } from 'lucide-react'

const SHOW_AFTER_PX = 480

/** Floating "back to top" button — shows once the page has scrolled past a
 * threshold, hidden (not just faded) via `pointer-events-none` so it can't
 * eat clicks while invisible. Shared between the dashboard shell and the
 * public landing page. */
export function BackToTop() {
  const [visible, setVisible] = React.useState(false)

  React.useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > SHOW_AFTER_PX)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const scrollToTop = () => {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' })
  }

  return (
    <button
      type="button"
      onClick={scrollToTop}
      aria-label="Back to top"
      title="Back to top"
      className={`fixed bottom-5 right-5 z-40 w-11 h-11 rounded-full bg-bh-surface border border-bh-border/60 shadow-lg flex items-center justify-center text-bh-text-dim hover:text-bh-text hover:-translate-y-0.5 transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none ${
        visible ? 'opacity-100 translate-y-0 pointer-events-auto' : 'opacity-0 translate-y-2 pointer-events-none'
      }`}
    >
      <ArrowUp className="w-4 h-4" aria-hidden="true" />
    </button>
  )
}
