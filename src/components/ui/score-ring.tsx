import * as React from 'react'
import { Sparkles, Users, Clock, Tag, Star, Info } from 'lucide-react'

/* -------------------------------------------------------------------------- */
/*  Types                                                                      */
/* -------------------------------------------------------------------------- */

export interface ScoreBreakdownItem {
  label: string
  value: number   // points this component contributed (0-100 scale)
  icon: 'sparkles' | 'users' | 'clock' | 'tag' | 'star'
}

interface ScoreRingProps {
  score: number             // 0-100
  size?: number             // px
  showLabel?: boolean       // "Match" label below
  breakdown?: ScoreBreakdownItem[]
}

/* -------------------------------------------------------------------------- */
/*  Icons                                                                      */
/* -------------------------------------------------------------------------- */

const ICON_MAP: Record<ScoreBreakdownItem['icon'], React.ComponentType<{ className?: string }>> = {
  sparkles: Sparkles,
  users: Users,
  clock: Clock,
  tag: Tag,
  star: Star,
}

/* -------------------------------------------------------------------------- */
/*  ScoreRing — radial progress with optional breakdown tooltip                */
/* -------------------------------------------------------------------------- */

export function ScoreRing({ score, size = 56, showLabel = true, breakdown }: ScoreRingProps) {
  const [tooltipOpen, setTooltipOpen] = React.useState(false)
  const radius = 16
  const circumference = 2 * Math.PI * radius // ≈ 100.5
  const clamped = Math.max(0, Math.min(100, score))

  // Continuous gradient (brand accent orange → success green) instead of a
  // few wide buckets — real score distributions cluster tightly (e.g. most
  // results land 45-67), and 3 buckets made a strong and a mediocre match
  // look identical. HSL computed inline (not a CSS var) because inline SVG
  // `stroke="var(...)"` doesn't resolve Tailwind v4's --color- names reliably.
  const t = clamped / 100
  const hue = 21 + t * 121 // 21° ≈ --color-bh-accent, 142° ≈ --color-bh-success
  const lightness = 55 - t * 19
  const color = `hsl(${hue.toFixed(0)} 74% ${lightness.toFixed(0)}%)`

  const dashArray = `${(clamped / 100) * circumference} ${circumference}`

  return (
    <div className="relative inline-flex flex-col items-center" style={{ width: size }}>
      <div
        className="relative cursor-help"
        style={{ width: size, height: size }}
        onMouseEnter={() => breakdown && setTooltipOpen(true)}
        onMouseLeave={() => setTooltipOpen(false)}
        onFocus={() => breakdown && setTooltipOpen(true)}
        onBlur={() => setTooltipOpen(false)}
        tabIndex={breakdown ? 0 : -1}
        aria-label={breakdown ? `Match score ${clamped}. Hover or focus for breakdown.` : `Match score ${clamped}`}
      >
        <svg
          className="w-full h-full pointer-events-none"
          viewBox="0 0 36 36"
          aria-hidden="true"
        >
          {/* Track */}
          <circle
            cx="18" cy="18" r={radius}
            fill="none"
            stroke="#334155"
            strokeWidth="3"
            opacity="0.5"
          />
          {/* Progress (rotated so it starts at 12 o'clock) */}
          <g style={{ transform: 'rotate(-90deg)', transformOrigin: '50% 50%' }}>
            <circle
              cx="18" cy="18" r={radius}
              fill="none"
              stroke={color}
              strokeWidth="3"
              strokeDasharray={dashArray}
              strokeLinecap="round"
            />
          </g>
        </svg>
        <div
          className="absolute inset-0 flex items-center justify-center font-bold pointer-events-none"
          style={{ fontSize: size * 0.32, color: 'var(--bh-text)' }}
        >
          {Math.round(clamped)}
        </div>

        {/* Tooltip with breakdown */}
        {breakdown && breakdown.length > 0 && tooltipOpen && (
          <div
            role="tooltip"
            className="absolute z-50 top-full mt-2 right-0 w-64 rounded-xl border border-bh-border-strong bg-bh-bg p-3 shadow-2xl animate-fade-in"
            style={{ textAlign: 'left' }}
          >
            <div className="flex items-center gap-2 mb-2 pb-2 border-b border-bh-border">
              <Info className="w-3.5 h-3.5 text-bh-accent" aria-hidden="true" />
              <p className="text-xs font-semibold text-bh-text">
                Match score {Math.round(clamped)}
              </p>
            </div>
            <ul className="space-y-1.5">
              {breakdown.map((item) => {
                const Icon = ICON_MAP[item.icon]
                return (
                  <li
                    key={item.label}
                    className="flex items-center justify-between gap-2 text-xs"
                  >
                    <span className="flex items-center gap-1.5 text-bh-text-muted">
                      <Icon className="w-3 h-3" aria-hidden="true" />
                      {item.label}
                    </span>
                    <span className="font-mono text-bh-text tabular-nums">+{item.value}</span>
                  </li>
                )
              })}
            </ul>
            <p className="text-[10px] text-bh-text-dim mt-2 pt-2 border-t border-bh-border leading-snug">
              Recency-weighted. Recent activity counts more than old.
            </p>
          </div>
        )}
      </div>
      {showLabel && (
        <p className="text-[10px] text-bh-text-dim uppercase tracking-wider mt-1">Match</p>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Helper: compute the breakdown for a builder                               */
/*  Mirrors src/lib/score.ts — kept in sync intentionally to avoid coupling   */
/* -------------------------------------------------------------------------- */

interface MinimalBuilder {
  source: string
  followersCount?: number | null
  topics?: string[] | null
  displayName?: string | null
  bio?: string | null
  avatarUrl?: string | null
  profileUrl?: string | null
  metadata?: Record<string, unknown> | null
}

export function getScoreBreakdown(b: MinimalBuilder): ScoreBreakdownItem[] {
  const items: ScoreBreakdownItem[] = []
  const now = Date.now()
  const meta = b.metadata ?? {}

  // Popularity
  const followers = b.followersCount ?? 0
  const pop = Math.round(Math.log1p(followers) * 3.0)
  if (pop > 0) {
    items.push({
      label: 'Popularity',
      value: Math.min(30, pop),
      icon: 'users',
    })
  }

  // Recency
  const lastSeen = (meta.lastSeen as number | undefined) ?? null
  if (lastSeen !== null) {
    const days = (now - lastSeen) / (1000 * 60 * 60 * 24)
    let recency = 0
    if (days < 1) recency = 30
    else if (days < 7) recency = 22
    else if (days < 30) recency = 12
    else if (days < 90) recency = 5
    else if (days < 365) recency = 1
    if (recency > 0) {
      items.push({
        label: days < 7 ? 'Active this week' : days < 30 ? 'Active this month' : 'Recent activity',
        value: recency,
        icon: 'clock',
      })
    }
  } else {
    items.push({ label: 'Activity recency', value: 5, icon: 'clock' })
  }

  // Topics
  const topicCount = b.topics?.length ?? 0
  if (topicCount > 0) {
    items.push({
      label: `Topics (${topicCount})`,
      value: Math.min(15, topicCount * 2),
      icon: 'tag',
    })
  }

  // Quality
  let quality = 0
  if (b.bio) quality += 4
  if (b.avatarUrl) quality += 2
  if (b.displayName) quality += 3
  if (quality > 0) {
    items.push({ label: 'Profile quality', value: quality, icon: 'sparkles' })
  }

  return items
}
