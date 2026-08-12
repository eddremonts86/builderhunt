import { Link } from '@tanstack/react-router'

/**
 * The status filter strip for an admin list page (plan 57, Admin track).
 *
 * ## Links, not buttons — and that is the whole change
 *
 * These were `<button onClick={setFilter}>`. Rendering them as links to the same route with a different `status`
 * is what makes a filtered view shareable, reloadable and reachable with the browser's Back button, none of
 * which a `useState` filter can be. It also means the filter is one thing — a URL — rather than two: component
 * state and whatever the address bar happens to say.
 *
 * ## Why `data-active` and not our own `aria-current`
 *
 * `Link` computes and writes its own `aria-current` from the router's idea of the active route, and it wins — a
 * value passed in props here is silently replaced. That cost a round of tests asserting on markup that never
 * shipped. The router's answer is the correct one for assistive technology; `data-active` is what the caller
 * knows and what tests read.
 *
 * Kept as one component rather than copied into each page so the three of them cannot drift into three
 * different ideas of what "active" looks like.
 */
export function StatusFilterTabs<Status extends string>({
  to,
  current,
  options,
  testIdPrefix,
  label = 'Filter by status',
}: {
  /** The route these link back to. Same path, different `status`. */
  to: string
  current: Status | 'all'
  options: ReadonlyArray<{ value: Status | 'all'; label: string }>
  /** `admin-claims-filter` produces `admin-claims-filter-pending`, matching what the old buttons carried. */
  testIdPrefix: string
  label?: string
}) {
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label={label}>
      {options.map((option) => (
        <Link
          key={option.value}
          /**
           * `to` and `search` are cast together, and the cast is confined to this one line.
           *
           * `Link` derives the legal `search` shape from the literal route path, so a component that serves
           * three routes cannot have both typed — the path is a parameter here. Casting only `to` is worse than
           * casting both: it resolves `search` to the never-typed reducer form and the object is rejected
           * outright.
           *
           * What replaces the compiler on this line is the route's own `validateSearch`, which normalizes
           * whatever arrives, and a browser case per page asserting the click lands on the filter it names. A
           * wrong `status` here cannot produce a broken page — it produces the fallback, visibly.
           */
          {...({ to, search: { status: option.value } } as unknown as { to: string })}
          className={`rounded px-2.5 py-1 text-xs font-medium ${
            option.value === current
              ? 'bg-bh-accent text-bh-accent-contrast'
              : 'bg-bh-surface text-bh-text-muted hover:text-bh-text'
          }`}
          data-active={option.value === current ? 'true' : undefined}
          data-testid={`${testIdPrefix}-${option.value}`}
        >
          {option.label}
        </Link>
      ))}
    </div>
  )
}
