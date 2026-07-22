import { Sun, Moon } from 'lucide-react'
import { useTheme } from '~/shared/lib/theme/ThemeProvider'
import { ICON_TRANSITION } from '~/shared/lib/useSlidingIndicator'

/** Segmented Light/Dark switch, always visible in the topbar (not tucked behind a menu). */
export function ThemeToggle() {
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
            onClick={() => setTheme(option)}
            className={`flex items-center gap-1.5 h-8 px-3 rounded-full text-xs font-semibold capitalize ${ICON_TRANSITION} ${
              active
                ? 'bg-bh-surface text-bh-text shadow-sm'
                : 'text-bh-text-dim hover:text-bh-text'
            }`}
          >
            <Icon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            {option}
          </button>
        )
      })}
    </div>
  )
}
