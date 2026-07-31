import { describe, expect, it } from 'vitest'
import { resolveBreadcrumbSegments } from '~/modules/dashboard/ui/shell/breadcrumbs'

describe('resolveBreadcrumbSegments', () => {
  it('falls back to the area breadcrumb for a non-contextual route', () => {
    expect(resolveBreadcrumbSegments('/settings/security', false, null))
      .toEqual([{ label: 'Workspace' }, { label: 'Security' }])
  })

  it.each([
    ['/builder/abc123', 'Search', '/search', 'Builder'],
    ['/lists/list-1', 'Shortlists', '/lists', 'Shortlist'],
    ['/sprints/sprint-1', 'Sprints', '/sprints', 'Sprint'],
    ['/interviews/interview-1', 'Interviews', '/interviews', 'Interview'],
  ])('uses a safe parent + fallback label for %s when no entity has loaded yet', (pathname, parentLabel, parentTo, fallback) => {
    expect(resolveBreadcrumbSegments(pathname, false, null)).toEqual([
      { label: parentLabel, to: parentTo },
      { label: fallback },
    ])
  })

  it('swaps in the loaded entity name once available', () => {
    expect(resolveBreadcrumbSegments('/builder/abc123', false, 'Ada Lovelace')).toEqual([
      { label: 'Search', to: '/search' },
      { label: 'Ada Lovelace' },
    ])
  })

  it('does not treat "new sprint" as a sprint-id detail route', () => {
    expect(resolveBreadcrumbSegments('/sprints/new', false, 'should be ignored'))
      .toEqual([{ label: 'Pipeline' }, { label: 'New sprint' }])
  })

  it('never lets a foreign entityLabel leak into an unrelated route', () => {
    expect(resolveBreadcrumbSegments('/dashboard', false, 'Ada Lovelace')).toEqual([{ label: 'Home' }, { label: 'Overview' }])
  })
})
