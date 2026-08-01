/**
 * The Solutions surface, bound to the real endpoints (plan 43 Phase 8; plans/UI task 78).
 *
 * Rewritten from the preview shell's tests. The flow changed for a reason worth restating, because these tests
 * are what pin it: interpretation is provider access, spec.md requires the reservation to exist before any
 * provider access, so there is no "here's what we understood" step *before* the user confirms the charge. The
 * old shell had one, backed by a local heuristic — honest as a mock, wrong as a product. The preview-banner
 * tests went with it: the banner said "this is an example, nothing is charged", which is no longer true.
 *
 * Every network call is injected. What is under test is the state machine, the copy, and the announcements; a
 * real fetch would test the browser's.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { SolutionsPage, type BillingStateDto, type SolutionsPageProps } from '~/modules/solutions/components/SolutionsPage'
import type { SolutionRoute } from '~/shared/lib/solutions/contracts'

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

const billingState = (overrides: Partial<BillingStateDto> = {}): BillingStateDto => ({
  balanceUnits: 140,
  generate: { charge: { operation: 'generate', units: 10, rateCardVersion: 1 }, available: true, unavailableReason: null },
  regenerate: { charge: { operation: 'regenerate', units: 3, rateCardVersion: 1 }, available: true, unavailableReason: null },
  ...overrides,
})

const route = (routeType: SolutionRoute['routeType'], status: SolutionRoute['status'] = 'available'): SolutionRoute => ({
  routeType,
  status,
  summary: `${routeType} summary`,
  fitExplanation: `${routeType} fit`,
  steps: ['Step one'],
  components: [{ componentId: 'deepl-pro', componentVersion: 3, role: 'Covers translation', coveredCapabilityKeys: ['translation'] }],
  mandatoryCapabilitiesCovered: true,
  coverageGapCapabilityKeys: [],
  limitations: [],
  ...(status === 'unavailable'
    ? { unavailableReason: 'Every candidate exceeds the stated budget' }
    : { estimate: { costMinCents: 1000, costMaxCents: 2000, currency: 'EUR', timeMinHours: 2, timeMaxHours: 6, assumptions: [] } }),
  risks: [],
  humanReviewPoints: [],
  evidenceIds: ['deepl-pro@3'],
})

const completeRun = (overrides: Record<string, unknown> = {}) => ({
  status: 'complete' as const,
  runId: 'run-1',
  brief: { rankingMode: 'recommended' },
  routes: [route('human'), route('ai', 'recommended'), route('hybrid', 'unavailable')],
  routeExplanations: [
    { provenance: 'model' as const },
    { provenance: 'deterministic' as const, fallbackReason: 'unsupported_figure' },
    { provenance: 'deterministic' as const, fallbackReason: 'route_unavailable' },
  ],
  interpretation: { unknownFields: ['budget'], provenance: 'model', promptVersion: 'solutions-interpret-1' },
  evidenceLevels: { 'deepl-pro@3': 'claimed' },
  attributions: [{ sourceKey: 'remoteok_jobs', text: 'Jobs by RemoteOK', url: 'https://remoteok.com' }],
  warnings: [],
  trace: { composerVersion: 'composer-1', retrievalQueryHash: 'q', compositionHash: 'c', durationMs: 12 },
  settledUnits: 10,
  ...overrides,
})

async function mount(props: SolutionsPageProps) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  // The locked/stale states render router `Link`s (PaidStateActions), so every mount needs a router in context.
  const rootRoute = createRootRoute({ component: () => <SolutionsPage {...props} /> })
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: ['/solutions'] }) })
  await act(async () => {
    root!.render(<RouterProvider router={router as never} />)
    await router.load()
  })
  await settle()
}

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

const unlocked = (overrides: Partial<SolutionsPageProps> = {}): SolutionsPageProps => ({
  fetchEntitlement: () => Promise.resolve({ paidActionsAllowed: true }),
  fetchBillingState: () => Promise.resolve(billingState()),
  ...overrides,
})

function $(selector: string) {
  return container!.querySelector(selector) as HTMLElement | null
}

function setValue(element: HTMLElement, value: string) {
  const proto = element.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

async function click(testId: string) {
  await act(async () => { $(`[data-testid="${testId}"]`)!.click() })
  await settle()
}

async function typeBriefAndContinue(text = 'Translate 200 product pages into German') {
  await act(async () => { setValue($('[data-testid="brief-description-input"]')!, text) })
  await click('brief-continue-button')
}

describe('entitlement gates', () => {
  it('shows the locked panel and an example result, not the brief form', async () => {
    await mount({ fetchEntitlement: () => Promise.resolve({ paidActionsAllowed: false }) })
    expect($('[data-testid="solutions-locked"]')).not.toBeNull()
    expect($('[data-testid="paid-state-billing"]')).not.toBeNull()
    expect($('[data-testid="brief-form"]')).toBeNull()
    // The example is the demo fixture rendered through the *real* route component, so a locked visitor sees
    // exactly the shape a paying one gets rather than a separate, prettier mock.
    expect($('[data-testid="run-result"]')).not.toBeNull()
  })

  it('fails closed to locked when the entitlement call fails', async () => {
    await mount({ fetchEntitlement: () => Promise.reject(new Error('offline')) })
    expect($('[data-testid="solutions-locked"]')).not.toBeNull()
  })

  it('offers only sign-in on a stale session, with a return path', async () => {
    await mount({ fetchEntitlement: () => Promise.resolve({ paidActionsAllowed: false, staleSession: true }) })
    expect($('[data-testid="solutions-stale-session"]')).not.toBeNull()
    expect($('[data-testid="paid-state-billing"]')).toBeNull()
    expect($('[data-testid="paid-state-pricing"]')).toBeNull()
    expect(($('[data-testid="paid-state-sign-in"]') as HTMLAnchorElement).getAttribute('href'))
      .toBe('/auth/sign-in?redirect=%2Fsolutions')
  })
})

describe('the charge is confirmed before anything runs', () => {
  it('shows the exact charge from the server, not a number the client made up', async () => {
    await mount(unlocked())
    await typeBriefAndContinue()
    expect($('[data-testid="confirm-charge-units"]')!.textContent).toBe('10 credits')
    expect($('[data-testid="confirm-balance"]')!.textContent).toContain('140')
  })

  it('never calls generate before the user confirms', async () => {
    /**
     * The invariant the whole flow exists to protect. A page that interpreted the brief to show a preview would
     * be spending provider money on a request nobody had agreed to pay for.
     */
    const runGeneration = vi.fn(async () => {})
    await mount(unlocked({ runGeneration }))
    await typeBriefAndContinue()
    expect(runGeneration).not.toHaveBeenCalled()
    await click('charge-confirm-button')
    expect(runGeneration).toHaveBeenCalledTimes(1)
  })

  it('echoes the server’s charge back as the confirmation', async () => {
    // What makes a stale price get refused rather than silently billed at the new one.
    let captured: unknown
    await mount(unlocked({ runGeneration: async (input) => { captured = input.confirmation } }))
    await typeBriefAndContinue()
    await click('charge-confirm-button')
    expect(captured).toEqual({ acceptedUnits: 10, acceptedRateCardVersion: 1 })
  })

  it('reuses one idempotency key across the clarification round trip', async () => {
    // Two calls, one intent. A fresh key on the second would make a replayed generation a second charge.
    const keys: string[] = []
    await mount(unlocked({
      runGeneration: async (input) => {
        keys.push(input.idempotencyKey)
        if (keys.length === 1) {
          input.onEvent({
            event: 'result',
            data: { status: 'needs_clarification', question: 'What is your deadline?', materiality: 'It decides whether the human route fits' },
          })
        } else {
          input.onEvent({ event: 'result', data: completeRun() })
        }
      },
    }))
    await typeBriefAndContinue()
    await click('charge-confirm-button')
    await act(async () => { setValue($('[data-testid="clarify-answer-input"]')!, 'End of September') })
    await click('clarify-submit-button')
    expect(keys).toHaveLength(2)
    expect(keys[0]).toBe(keys[1])
  })
})

describe('blocked states name the remedy', () => {
  it('sends an out-of-credits organization to a top-up, not an upgrade', async () => {
    await mount(unlocked({
      fetchBillingState: () => Promise.resolve(billingState({
        balanceUnits: 2,
        generate: { charge: { operation: 'generate', units: 10, rateCardVersion: 1 }, available: false, unavailableReason: 'insufficient_credits' },
      })),
    }))
    expect($('[data-testid="solutions-blocked"]')!.textContent).toContain('Top up')
    expect(($('[data-testid="brief-continue-button"]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('says a disabled feature has no remedy the user can buy', async () => {
    await mount(unlocked({
      fetchBillingState: () => Promise.resolve(billingState({
        generate: { charge: { operation: 'generate', units: 10, rateCardVersion: 1 }, available: false, unavailableReason: 'feature_disabled' },
      })),
    }))
    // An upgrade changes nothing here, so the copy must not suggest one.
    const text = $('[data-testid="solutions-blocked"]')!.textContent ?? ''
    expect(text).toContain('switched off')
    expect(text).not.toContain('plan')
  })
})

describe('the run itself', () => {
  it('reports progress and then renders three lanes', async () => {
    await mount(unlocked({
      runGeneration: async (input) => {
        input.onEvent({ event: 'progress', data: { stage: 'interpreting', fraction: 0.1 } })
        input.onEvent({ event: 'progress', data: { stage: 'composing', fraction: 0.55 } })
        input.onEvent({ event: 'result', data: completeRun() })
      },
    }))
    await typeBriefAndContinue()
    await click('charge-confirm-button')

    expect($('[data-testid="route-human"]')).not.toBeNull()
    expect($('[data-testid="route-ai"]')).not.toBeNull()
    expect($('[data-testid="route-hybrid"]')!.getAttribute('data-status')).toBe('unavailable')
    expect($('[data-testid="route-hybrid-unavailable-reason"]')!.textContent).toContain('exceeds the stated budget')
    expect($('[data-testid="result-charge"]')!.textContent).toContain('10 credits')
  })

  it('says a capability was the vendor’s own claim', async () => {
    /**
     * The rule the whole surface exists to keep. Almost everything in the catalog enters at `claimed`, and a
     * badge or a tick would turn a vendor's marketing into our assessment.
     */
    await mount(unlocked({ runGeneration: async (input) => { input.onEvent({ event: 'result', data: completeRun() }) } }))
    await typeBriefAndContinue()
    await click('charge-confirm-button')
    expect($('[data-testid="route-ai-evidence-deepl-pro"]')!.textContent).toContain('Vendor’s own claim')
  })

  it('shows where the prose came from', async () => {
    await mount(unlocked({ runGeneration: async (input) => { input.onEvent({ event: 'result', data: completeRun() }) } }))
    await typeBriefAndContinue()
    await click('charge-confirm-button')
    expect($('[data-testid="route-human-provenance"]')!.textContent).toContain('generated from this route')
    expect($('[data-testid="route-ai-provenance"]')!.textContent).toContain('deterministic composer')
  })

  it('renders the attribution a source requires', async () => {
    // A release blocker, not decoration: `remoteok_jobs` grants access on the condition the notice is shown.
    await mount(unlocked({ runGeneration: async (input) => { input.onEvent({ event: 'result', data: completeRun() }) } }))
    await typeBriefAndContinue()
    await click('charge-confirm-button')
    const attribution = $('[data-testid="attribution-remoteok_jobs"]')
    expect(attribution).not.toBeNull()
    expect(attribution!.textContent).toContain('Jobs by RemoteOK')
  })

  it('states what was left unknown', async () => {
    await mount(unlocked({ runGeneration: async (input) => { input.onEvent({ event: 'result', data: completeRun() }) } }))
    await typeBriefAndContinue()
    await click('charge-confirm-button')
    expect($('[data-testid="unknown-fields"]')!.textContent).toContain('budget')
  })

  it('asks one clarifying question and says it is free', async () => {
    await mount(unlocked({
      runGeneration: async (input) => {
        input.onEvent({
          event: 'result',
          data: { status: 'needs_clarification', question: 'What is your deadline?', materiality: 'It decides whether the human route fits' },
        })
      },
    }))
    await typeBriefAndContinue()
    await click('charge-confirm-button')
    const panel = $('[data-testid="clarifying-question"]')!
    expect(panel.textContent).toContain('What is your deadline?')
    // A user asked to answer a question mid-flow will otherwise assume they are being charged twice.
    expect(panel.textContent).toContain('costs nothing')
  })

  it('surfaces an unreadable brief as a fixable problem', async () => {
    await mount(unlocked({
      runGeneration: async (input) => {
        input.onEvent({ event: 'result', data: { status: 'unreadable', reason: 'No capability could be identified in this brief.' } })
      },
    }))
    await typeBriefAndContinue()
    await click('charge-confirm-button')
    expect($('[data-testid="solutions-error"]')!.textContent).toContain('No capability')
    // Back on the form, not a dead end.
    expect($('[data-testid="brief-form"]')).not.toBeNull()
  })

  it('reports a billing refusal in the words the server used', async () => {
    await mount(unlocked({
      runGeneration: async (input) => {
        input.onEvent({ event: 'error', data: { code: 'insufficient_credits', message: 'Insufficient credits for this operation' } })
      },
    }))
    await typeBriefAndContinue()
    await click('charge-confirm-button')
    expect($('[data-testid="solutions-error"]')!.textContent).toContain('Insufficient credits')
  })

  it('cancels by aborting the request', async () => {
    /**
     * Cancellation is the client disconnecting: the server sees `request.signal` fire and releases the hold.
     * There is no cancel endpoint to authorize and no run id to leak.
     */
    let seenSignal: AbortSignal | null = null
    await mount(unlocked({
      runGeneration: async (input) => {
        seenSignal = input.signal
        input.onEvent({ event: 'progress', data: { stage: 'interpreting', fraction: 0.1 } })
        await new Promise((resolve) => setTimeout(resolve, 50))
      },
    }))
    await typeBriefAndContinue()
    await act(async () => { $('[data-testid="charge-confirm-button"]')!.click() })
    await click('generation-cancel-button')
    expect(seenSignal).not.toBeNull()
    expect((seenSignal as unknown as AbortSignal).aborted).toBe(true)
    expect($('[data-testid="brief-form"]')).not.toBeNull()
  })
})

describe('after a result', () => {
  const mountWithResult = async (extra: Partial<SolutionsPageProps> = {}) => {
    await mount(unlocked({
      runGeneration: async (input) => { input.onEvent({ event: 'result', data: completeRun() }) },
      ...extra,
    }))
    await typeBriefAndContinue()
    await click('charge-confirm-button')
  }

  it('saves only when asked', async () => {
    // spec.md: "Nothing is saved until you explicitly save a result."
    const saveRun = vi.fn(async () => ({ id: 'saved-1' }))
    await mountWithResult({ saveRun })
    expect(saveRun).not.toHaveBeenCalled()
    await click('save-run-button')
    expect(saveRun).toHaveBeenCalledTimes(1)
    expect($('[data-testid="save-run-button"]')!.textContent).toBe('Saved')
  })

  it('keeps the result on screen when the save fails', async () => {
    await mountWithResult({ saveRun: () => Promise.reject(new Error('nope')) })
    await click('save-run-button')
    expect($('[data-testid="solutions-error"]')!.textContent).toContain('still on screen')
    expect($('[data-testid="run-result"]')).not.toBeNull()
  })

  it('records which route the user chose', async () => {
    await mountWithResult()
    await click('route-ai-choose')
    expect($('[data-testid="route-ai-choose"]')!.getAttribute('aria-pressed')).toBe('true')
    expect($('[data-testid="route-human-choose"]')!.getAttribute('aria-pressed')).toBe('false')
  })

  it('reorders without changing what is offered', async () => {
    // Sorting is a view. An unavailable lane still appears, and still last.
    await mountWithResult()
    const select = $('[data-testid="route-sort"]') as HTMLSelectElement
    await act(async () => {
      select.value = 'cost'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const lanes = [...container!.querySelectorAll('[data-status]')]
      .map((element) => element.getAttribute('data-testid'))
      .filter((testId): testId is string => Boolean(testId?.startsWith('route-')))
    expect(lanes).toHaveLength(3)
    expect(lanes[lanes.length - 1]).toBe('route-hybrid')
  })

  it('starts a new brief from an empty form', async () => {
    await mountWithResult()
    await click('result-reset-button')
    expect($('[data-testid="brief-form"]')).not.toBeNull()
    expect(($('[data-testid="brief-description-input"]') as HTMLTextAreaElement).value).toBe('')
  })
})

describe('announcements', () => {
  it('announces the run’s state changes in one polite region', async () => {
    // One region, so a screen reader hears the run start and finish without the focus moving under the user.
    await mount(unlocked({
      runGeneration: async (input) => {
        input.onEvent({ event: 'progress', data: { stage: 'retrieving', fraction: 0.35 } })
        input.onEvent({ event: 'result', data: completeRun() })
      },
    }))
    const announcer = $('[data-testid="solutions-announcer"]')!
    expect(announcer.getAttribute('aria-live')).toBe('polite')
    expect(announcer.getAttribute('role')).toBe('status')

    await typeBriefAndContinue()
    await click('charge-confirm-button')
    expect(announcer.textContent).toContain('Results ready')
  })

  it('gives the progress bar an accessible value', async () => {
    await mount(unlocked({
      runGeneration: async (input) => {
        input.onEvent({ event: 'progress', data: { stage: 'composing', fraction: 0.55 } })
        await new Promise((resolve) => setTimeout(resolve, 50))
      },
    }))
    await typeBriefAndContinue()
    await act(async () => { $('[data-testid="charge-confirm-button"]')!.click() })
    await settle()
    const bar = container!.querySelector('[role="progressbar"]')!
    expect(bar.getAttribute('aria-valuenow')).toBe('55')
  })
})
