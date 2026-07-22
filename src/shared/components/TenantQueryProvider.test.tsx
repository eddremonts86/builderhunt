import { act, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { QueryClient } from '@tanstack/react-query'
import { useQueryClient } from '@tanstack/react-query'
import { TenantQueryProvider, useActiveOrganizationId } from './TenantQueryProvider'

// No @testing-library/react in this codebase yet — mount directly with
// react-dom/client + act, the same primitives testing-library wraps.
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

function mount(node: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(node))
}

// Captures the live queryClient + activeOrganizationId once per render so
// the test can assert against them directly, instead of depending on
// react-query's own re-render/refetch timing.
function Probe({ onRender }: { onRender: (client: QueryClient, activeOrganizationId: string | null) => void }) {
  const activeOrganizationId = useActiveOrganizationId()
  const queryClient = useQueryClient()
  onRender(queryClient, activeOrganizationId)
  return null
}

describe('TenantQueryProvider', () => {
  it('exposes the active organization id via context', () => {
    let seenOrgId: string | null = null
    mount(
      <TenantQueryProvider activeOrganizationId="org-a">
        <Probe onRender={(_client, orgId) => { seenOrgId = orgId }} />
      </TenantQueryProvider>,
    )
    expect(seenOrgId).toBe('org-a')
  })

  it('clears the entire query cache when the active organization changes', () => {
    let client: QueryClient | null = null
    let setOrg: (id: string) => void = () => {}

    function Wrapper() {
      const [org, setOrgState] = useState('org-a')
      useEffect(() => {
        setOrg = setOrgState
      }, [])
      return (
        <TenantQueryProvider activeOrganizationId={org}>
          <Probe onRender={(c) => { client = c }} />
        </TenantQueryProvider>
      )
    }

    mount(<Wrapper />)
    act(() => client!.setQueryData(['organization', 'org-a', 'probe'], 'data-for-org-a'))
    expect(client!.getQueryData(['organization', 'org-a', 'probe'])).toBe('data-for-org-a')

    act(() => setOrg('org-b'))
    expect(client!.getQueryData(['organization', 'org-a', 'probe'])).toBeUndefined()
  })

  it('leaves the cache alone across a re-render with the same organization id', () => {
    let client: QueryClient | null = null

    function Wrapper() {
      const [, forceRerender] = useState(0)
      return (
        <TenantQueryProvider activeOrganizationId="org-a">
          <Probe onRender={(c) => { client = c }} />
          <button type="button" onClick={() => forceRerender((n) => n + 1)}>rerender</button>
        </TenantQueryProvider>
      )
    }

    mount(<Wrapper />)
    act(() => client!.setQueryData(['organization', 'org-a', 'probe'], 'data-for-org-a'))

    const button = container!.querySelector('button')!
    act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(client!.getQueryData(['organization', 'org-a', 'probe'])).toBe('data-for-org-a')
  })
})
