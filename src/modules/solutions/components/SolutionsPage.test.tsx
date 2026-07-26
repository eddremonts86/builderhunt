import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { SolutionsPage } from './SolutionsPage'

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

async function mount(paidActionsAllowed: boolean) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<SolutionsPage fetchEntitlement={() => Promise.resolve({ paidActionsAllowed })} />)
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function $(selector: string) {
  return container!.querySelector(selector) as HTMLElement
}

function setValue(el: HTMLElement, value: string) {
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  setter?.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('SolutionsPage — Free (locked)', () => {
  it('shows the locked explanation, an upgrade CTA, and a labeled example result — no brief form', async () => {
    await mount(false)
    expect($('[data-testid="solutions-locked"]')).not.toBeNull()
    expect($('[data-testid="solutions-upgrade-cta"]')).not.toBeNull()
    expect($('[data-testid="brief-form"]')).toBeNull()
    expect($('[data-testid="demo-result-lanes"]')).not.toBeNull()
  })
})

describe('SolutionsPage — Paid (unlocked)', () => {
  it('shows the brief form, not the locked panel', async () => {
    await mount(true)
    expect($('[data-testid="brief-form"]')).not.toBeNull()
    expect($('[data-testid="solutions-locked"]')).toBeNull()
  })

  it('disables the preview button until description and capabilities are filled', async () => {
    await mount(true)
    const button = $('[data-testid="brief-preview-button"]') as HTMLButtonElement
    expect(button.disabled).toBe(true)
  })

  it('previewing an interpretation with an unset budget shows exactly one clarifying question', async () => {
    await mount(true)
    await act(async () => {
      setValue($('[data-testid="brief-description-input"]'), 'Translate a manual')
      setValue($('[data-testid="brief-capabilities-input"]'), 'translation')
    })
    await act(async () => {
      $('[data-testid="brief-form"]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect($('[data-testid="interpretation-preview"]')).not.toBeNull()
    expect($('[data-testid="clarifying-question"]')).not.toBeNull()
    expect(container!.textContent).toContain('Translate a manual')
  })

  it('setting the clarified budget removes the clarifying question on the next preview', async () => {
    await mount(true)
    await act(async () => {
      setValue($('[data-testid="brief-description-input"]'), 'Translate a manual')
      setValue($('[data-testid="brief-capabilities-input"]'), 'translation')
    })
    await act(async () => {
      $('[data-testid="brief-form"]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    await act(async () => {
      setValue($('[data-testid="clarify-budget-input"]'), '500')
    })
    await act(async () => {
      ;($('[data-testid="clarify-submit-button"]') as HTMLButtonElement).click()
    })
    await act(async () => {
      ;($('[data-testid="interpretation-back-button"]') as HTMLButtonElement).click()
    })
    await act(async () => {
      $('[data-testid="brief-form"]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect($('[data-testid="clarifying-question"]')).toBeNull()
  })

  it('confirming the interpretation shows the exact maximum credit charge before any generation', async () => {
    await mount(true)
    await act(async () => {
      setValue($('[data-testid="brief-description-input"]'), 'Translate a manual')
      setValue($('[data-testid="brief-capabilities-input"]'), 'translation')
    })
    await act(async () => {
      $('[data-testid="brief-form"]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    await act(async () => {
      ;($('[data-testid="interpretation-confirm-button"]') as HTMLButtonElement).click()
    })
    expect($('[data-testid="credit-confirmation"]')).not.toBeNull()
    expect(container!.textContent).toContain('10 credits')
    expect($('[data-testid="result-lanes"]')).toBeNull()
  })

  it('cancelling at the credit-confirmation step resets to the brief form without generating', async () => {
    await mount(true)
    await act(async () => {
      setValue($('[data-testid="brief-description-input"]'), 'Translate a manual')
      setValue($('[data-testid="brief-capabilities-input"]'), 'translation')
    })
    await act(async () => {
      $('[data-testid="brief-form"]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    await act(async () => {
      ;($('[data-testid="interpretation-confirm-button"]') as HTMLButtonElement).click()
    })
    await act(async () => {
      ;($('[data-testid="charge-cancel-button"]') as HTMLButtonElement).click()
    })
    expect($('[data-testid="brief-form"]')).not.toBeNull()
    expect($('[data-testid="result-lanes"]')).toBeNull()
  })

  it('confirming the charge reveals three result lanes, including one recommended, one available, and one unavailable-with-reason', async () => {
    await mount(true)
    await act(async () => {
      setValue($('[data-testid="brief-description-input"]'), 'Translate a manual')
      setValue($('[data-testid="brief-capabilities-input"]'), 'translation')
    })
    await act(async () => {
      $('[data-testid="brief-form"]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    await act(async () => {
      ;($('[data-testid="interpretation-confirm-button"]') as HTMLButtonElement).click()
    })
    await act(async () => {
      ;($('[data-testid="charge-confirm-button"]') as HTMLButtonElement).click()
    })
    expect($('[data-testid="result-lanes"]')).not.toBeNull()
    expect($('[data-testid="route-human"]')?.dataset.status).toBe('recommended')
    expect($('[data-testid="route-ai"]')?.dataset.status).toBe('available')
    expect($('[data-testid="route-hybrid"]')?.dataset.status).toBe('unavailable')
    expect($('[data-testid="route-hybrid-unavailable-reason"]')).not.toBeNull()
    // Demo results must be clearly labeled — never presented as a real generated result.
    expect($('[data-testid="demo-result-banner"]').textContent).toMatch(/example/i)
  })

  it('starting a new brief from the result screen returns to the empty form', async () => {
    await mount(true)
    await act(async () => {
      setValue($('[data-testid="brief-description-input"]'), 'Translate a manual')
      setValue($('[data-testid="brief-capabilities-input"]'), 'translation')
    })
    await act(async () => {
      $('[data-testid="brief-form"]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    await act(async () => {
      ;($('[data-testid="interpretation-confirm-button"]') as HTMLButtonElement).click()
    })
    await act(async () => {
      ;($('[data-testid="charge-confirm-button"]') as HTMLButtonElement).click()
    })
    await act(async () => {
      ;($('[data-testid="result-reset-button"]') as HTMLButtonElement).click()
    })
    expect($('[data-testid="brief-form"]')).not.toBeNull()
    expect(($('[data-testid="brief-description-input"]') as HTMLTextAreaElement).value).toBe('')
  })
})

describe('SolutionsPage — entitlement fetch failure', () => {
  it('fails closed to the locked state on a fetch error', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(<SolutionsPage fetchEntitlement={() => Promise.reject(new Error('network error'))} />)
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect($('[data-testid="solutions-locked"]')).not.toBeNull()
  })
})
