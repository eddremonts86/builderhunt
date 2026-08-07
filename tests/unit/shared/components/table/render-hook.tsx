import * as React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

/**
 * A minimal `renderHook`.
 *
 * There is no `@testing-library/react` in this codebase, and the existing component tests
 * (`HydrationSignal.test.tsx`, `TenantQueryProvider.test.tsx`) mount with `react-dom/client` + `act`
 * directly — the same primitives testing-library wraps. This is that pattern, for a hook rather
 * than a component, so the table hooks can be tested without adding a dependency for it.
 */
export interface HookHandle<Value, Props> {
  /** The hook's latest return value. */
  readonly current: Value
  rerender: (props: Props) => void
  unmount: () => void
}

export function renderHookValue<Value, Props extends object = Record<string, never>>(
  hook: (props: Props) => Value,
  initialProps: Props = {} as Props,
): HookHandle<Value, Props> {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  let latest: Value
  let setProps: ((props: Props) => void) | null = null

  function Probe({ initial }: { initial: Props }) {
    const [props, update] = React.useState(initial)
    setProps = update
    latest = hook(props)
    return null
  }

  act(() => root.render(<Probe initial={initialProps} />))

  return {
    get current() {
      return latest
    },
    rerender(props: Props) {
      setProps?.(props)
    },
    unmount() {
      act(() => root.unmount())
      container.remove()
    },
  }
}
