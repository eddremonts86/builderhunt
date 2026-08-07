import * as React from 'react'
import { Link } from '@tanstack/react-router'
import { ArrowRight, Compass } from 'lucide-react'
import { BentoTileHeader, BentoTileList } from '~/modules/dashboard/ui/bento/Bento'
import { LinkButton } from '~/components/ui'

/**
 * Sourcing sprints in flight.
 *
 * Backed by `GET /api/sprints` (src/lib/sprints/service.ts `listSprints`), which
 * already returns `resultCount` alongside each sprint's `quota`, so progress is
 * real data rather than a derived guess. Sprints were reachable only from
 * `/sprints` before this; a running sprint is exactly the kind of thing the
 * overview should surface without being asked.
 */

export interface SprintListItem {
  id: string
  name: string
  status: 'active' | 'paused' | 'completed'
  quota: number
  resultCount: number
  lastRunAt: string | null
  createdAt: string
}

const STATUS_TONE: Record<SprintListItem['status'], string> = {
  active: 'bg-bh-success/10 text-bh-success border-bh-success/20',
  paused: 'bg-bh-warning/10 text-bh-warning border-bh-warning/20',
  completed: 'bg-bh-bg-alt text-bh-text-dim border-bh-border',
}

export function SprintsWidget({ sprints }: { sprints: readonly SprintListItem[] }) {
  // Running work first, then whatever is paused; completed sprints are history
  // and belong on the sprints page, not on an overview.
  const live = sprints.filter((s) => s.status !== 'completed')

  return (
    <>
      <BentoTileHeader
        title="Sourcing sprints"
        icon={Compass}
        tone="accent"
        action={live.length > 0 ? (
          <Link
            to="/sprints"
            className="flex items-center gap-1 rounded px-0.5 text-xs font-semibold text-bh-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2"
          >
            All sprints <ArrowRight className="h-3 w-3" aria-hidden="true" />
          </Link>
        ) : undefined}
      />

      {live.length === 0 ? (
        <div className="rounded-xl border border-dashed border-bh-border bg-bh-bg-alt/50 p-4 text-center">
          <Compass className="mx-auto mb-2 h-8 w-8 text-bh-text-dim opacity-50" aria-hidden="true" />
          <p className="mb-1 text-sm font-semibold text-bh-text">No sprint running</p>
          <p className="mb-3 text-xs font-light text-bh-text-muted">
            A sprint keeps sourcing against your criteria in the background.
          </p>
          <LinkButton
            to="/sprints/new"
            variant="secondary"
            size="sm"
            className="py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2"
          >
            Start a sprint
          </LinkButton>
        </div>
      ) : (
        <BentoTileList>
          <ul>
            {live.slice(0, 4).map((sprint) => {
              const pct = sprint.quota > 0
                ? Math.min(100, Math.round((sprint.resultCount / sprint.quota) * 100))
                : 0
              return (
                <li key={sprint.id}>
                  <Link
                    to="/sprints/$sprintId"
                    params={{ sprintId: sprint.id }}
                    search={{}}
                    className="block px-6 py-3 transition-colors hover:bg-bh-surface-2/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bh-accent focus-visible:ring-offset-2"
                  >
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-bh-text" title={sprint.name}>
                        {sprint.name}
                      </span>
                      <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold ${STATUS_TONE[sprint.status]}`}>
                        {sprint.status}
                      </span>
                    </span>

                    <span className="mt-2 flex items-center gap-2">
                      <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-bh-bg-alt">
                        <span
                          className="block h-full rounded-full bg-bh-accent"
                          style={{ width: `${pct}%` }}
                        />
                      </span>
                      <span className="shrink-0 font-mono text-[10px] tabular-nums text-bh-text-dim">
                        {sprint.resultCount}/{sprint.quota}
                      </span>
                    </span>
                  </Link>
                </li>
              )
            })}
          </ul>
        </BentoTileList>
      )}
    </>
  )
}
