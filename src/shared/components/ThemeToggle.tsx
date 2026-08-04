import { Sun, Moon } from 'lucide-react'
import { useTheme } from '~/shared/lib/theme/ThemeProvider'
import { ICON_TRANSITION } from '~/shared/lib/useSlidingIndicator'

/** Segmented Light/Dark switch, always visible in the topbar (not tucked behind a menu).
 * Shared by the dashboard shell and the public/landing header — both mount their own
 * ThemeProvider, so this only ever needs `useTheme()`.
 *
 * `compact` drops the "Light"/"Dark" words and keeps the sun/moon icons, which reclaims roughly 90px.
 * Nothing is lost for assistive technology: each button already carries `aria-label={option}`, and the
 * icons are the conventional signal for this control.
 *
 * It exists because the public header genuinely could not fit otherwise. `.topbar-shell` is capped at
 * `--page-max` minus gutters — about 1158px **at every viewport**, deliberately, so the pill lines up with
 * the landing's content column — and the full nav plus a labelled toggle measured 1176px. That is wider
 * than the container's design maximum, so no screen was ever wide enough and no breakpoint could fix it.
 * Default stays `false` so the five other call sites are untouched. */
export function ThemeToggle({ compact = false }: { compact?: boolean } = {}) {
  const { theme, setTheme } = useTheme()

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="flex items-center gap-0.5 rounded-full border border-bh-border/60 bg-bh-bg-alt/60 p-0.5 shrink-0"
    >
      {(['light', 'dark'] as const).map((option) => {
        const active = theme === option
        const Icon = option === 'light' ? Sun : Moon
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={option}
            onClick={() => setTheme(option)}
            className={`flex items-center gap-1.5 h-8 px-3 rounded-full text-xs font-semibold capitalize ${ICON_TRANSITION} ${
              active
                ? 'bg-bh-surface text-bh-text shadow-sm'
                : 'text-bh-text-dim hover:text-bh-text'
            }`}
          >
            <Icon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            {!compact && <span className="hidden sm:inline">{option}</span>}
          </button>
        )
      })}
    </div>
  )
}
