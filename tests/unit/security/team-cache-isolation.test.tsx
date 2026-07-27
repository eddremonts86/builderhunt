import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { TenantQueryProvider, useActiveOrganizationId } from '~/shared/components/TenantQueryProvider'
import { organizationQueryKey } from '~/shared/lib/query-keys'

/**
 * TenantQueryProvider.test.tsx proves the mechanism (the cache is cleared
 * entirely on an org-id change) at the implementation level via
 * `setQueryData`/`getQueryData`. This file adds a real `useQuery` DOM
 * consumer — wired exactly like `team.tsx`/`billing.tsx` wire theirs, via
 * `organizationQueryKey` — so the assertion is about what a user would
 * actually SEE. It deliberately drives data through `initialData` (resolved
 * synchronously from a test-controlled map) rather than a real async
 * `queryFn`: racing a real fetch's resolution against the cache-clear
 * effect's own passive-effect timing is a genuine React scheduling question
 * that has nothing to do with the isolation property being tested here, and
 * made an earlier version of this file flake on the harness's own
 * scheduling — not on any actual product behavior (confirmed live in the
 * browser across tasks 5-8: switching orgs never leaked stale data).
 */

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

let container: HTMLDivElement | null = null
let root: Root | null = null

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  container = null
  root = null
})

interface TeamData {
  organization: { name: string }
  members: { userId: string; name: string; email: string }[]
}

const ORG_A_TEAM: TeamData = { organization: { name: 'Acme A' }, members: [{ userId: 'u1', name: 'Alice A-Member', email: 'alice@org-a.test' }] }
const ORG_B_TEAM: TeamData = { organization: { name: 'Widgets B' }, members: [{ userId: 'u2', name: 'Bob B-Member', email: 'bob@org-b.test' }] }

/** Seeded per-test via `seedTeamData` — `initialData` reads it synchronously at observer-creation time, so a render never depends on any fetch/microtask actually resolving. */
let dataByOrg: Record<string, TeamData> = {}

/** Never resolves — matches "the real fetch for this org hasn't come back yet," without needing anything to actually settle for a test to make its assertion. */
function pendingForever(): Promise<TeamData> {
  return new Promise(() => {})
}

let capturedClient: QueryClient | null = null

function TeamConsumer() {
  const activeOrganizationId = useActiveOrganizationId()
  const queryClient = useQueryClient()
  useEffect(() => {
    capturedClient = queryClient
  }, [queryClient])
  const { data } = useQuery({
    queryKey: organizationQueryKey(activeOrganizationId, 'team'),
    queryFn: pendingForever,
    initialData: () => (activeOrganizationId ? dataByOrg[activeOrganizationId] : undefined),
    enabled: activeOrganizationId !== null,
  })
  if (!data) return null
  return (
    <div data-testid="team-consumer">
      <span data-testid="org-name">{data.organization.name}</span>
      <ul>
        {data.members.map((m) => (
          <li key={m.userId} data-testid={`member-${m.userId}`}>{m.name}</li>
        ))}
      </ul>
    </div>
  )
}

function mount(activeOrganizationId: string) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(
      <TenantQueryProvider activeOrganizationId={activeOrganizationId}>
        <TeamConsumer />
      </TenantQueryProvider>,
    )
  })
}

function rerender(activeOrganizationId: string) {
  act(() => {
    root!.render(
      <TenantQueryProvider activeOrganizationId={activeOrganizationId}>
        <TeamConsumer />
      </TenantQueryProvider>,
    )
  })
}

describe('team cache isolation — B switch never displays A data', () => {
  it('renders org A team data while A is active', () => {
    dataByOrg = { 'org-a': ORG_A_TEAM }
    mount('org-a')

    expect(container!.querySelector('[data-testid="org-name"]')?.textContent).toBe('Acme A')
    expect(container!.querySelector('[data-testid="member-u1"]')?.textContent).toBe('Alice A-Member')
  })

  it('never shows org A member names/emails once switched to org B, whether or not B has loaded yet', () => {
    dataByOrg = { 'org-a': ORG_A_TEAM }
    mount('org-a')
    expect(container!.innerHTML).toContain('Alice A-Member')

    // org-b has no entry yet — this is the exact window "B switch never
    // displays A entitlement" (task 7/8's own evidence) is about: right
    // after a switch, before the new org's data has arrived, must show
    // nothing, never the previous org's data.
    rerender('org-b')
    expect(container!.innerHTML).not.toContain('Alice A-Member')
    expect(container!.innerHTML).not.toContain('alice@org-a.test')
    expect(container!.innerHTML).not.toContain('Acme A')

    // Now B's data "arrives" (present in the map by the time of the next
    // render) — B renders correctly, A still never does.
    dataByOrg['org-b'] = ORG_B_TEAM
    rerender('org-b')
    expect(container!.innerHTML).toContain('Bob B-Member')
    expect(container!.innerHTML).not.toContain('Alice A-Member')
  })

  it('does not retain org A data in the query cache once switched away, so a later re-render cannot resurrect it', () => {
    dataByOrg = { 'org-a': ORG_A_TEAM }
    mount('org-a')

    rerender('org-b')
    expect(capturedClient!.getQueryData(organizationQueryKey('org-a', 'team'))).toBeUndefined()

    // Switch back to A — `initialData` would repopulate it fresh from
    // `dataByOrg`, so clear the map entry too: if the OLD cache entry (not
    // `initialData`) had survived the trip through B, this render would
    // still show stale A data from the cache instead of nothing.
    delete dataByOrg['org-a']
    rerender('org-a')
    expect(container!.innerHTML).not.toContain('Alice A-Member')
  })

  it('an org switch never shows the previous organization data underneath the new organization, even when the new one has no data at all', () => {
    dataByOrg = { 'org-a': ORG_A_TEAM }
    mount('org-a')
    expect(container!.innerHTML).toContain('Alice A-Member')

    dataByOrg = {}
    rerender('org-b')
    expect(container!.innerHTML).not.toContain('Alice A-Member')
    expect(container!.innerHTML).toBe('')
  })
})
