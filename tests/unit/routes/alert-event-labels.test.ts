import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The radar form's `eventType` options must read as **labels**, not as events
 * the product observes.
 *
 * `plans/phase-1/34-smart-alerts/spec.md` §"Honest v1 semantics" states it
 * directly: those four values "are **match labels, not detected events**". The
 * worker has no per-builder activity stream — it runs the radar's keyword search
 * and files every trigger as `keyword_match` (`src/lib/alerts/worker.ts`, with a
 * comment explaining that echoing the alert's condition back "made the inbox
 * label a person row 'New repository' for an event nobody observed").
 *
 * The dropdown had drifted the other way and was writing full event sentences.
 * The worst of them paired "A developer launches a new repo" with the
 * `any_activity` value, which `evaluateMatch` treats as matching *every* type —
 * so the option a user would pick to get new-repo alerts was the one that could
 * never be narrowed to repos.
 *
 * This is a copy test because the defect is copy: nothing throws, no request
 * fails, and the only symptom is a user believing the product watches something
 * it does not. When `33-unified-timeline` lands real event detection, these
 * labels may legitimately become event sentences — delete this test in that
 * change, deliberately, rather than loosening it.
 */

const ALERTS_ROUTE = readFileSync(
  resolve(import.meta.dirname, '../../../src/routes/_dashboard/alerts.tsx'),
  'utf8',
)

function optionLabels(): string[] {
  const block = ALERTS_ROUTE.match(/const EVENT_TYPE_OPTIONS[^=]*=\s*\[([\s\S]*?)\n\]/)
  expect(block, 'expected to find the EVENT_TYPE_OPTIONS array').not.toBeNull()
  return [...block![1].matchAll(/label:\s*'([^']*)'/g)].map((m) => m[1])
}

describe('radar event-type labels (plan 34: match labels, not detected events)', () => {
  it('finds the option list', () => {
    expect(optionLabels().length).toBe(4)
  })

  /**
   * Verbs that assert an observed occurrence. A label containing one is claiming
   * the product noticed something happen, which it cannot do yet.
   */
  const EVENT_VERBS = [
    'launches', 'launched', 'ships', 'shipped', 'posts', 'posted',
    'pushes', 'pushed', 'publishes', 'published', 'creates', 'created',
  ]

  it('no label asserts an observed event', () => {
    const offenders = optionLabels().flatMap((label) => {
      const hit = EVENT_VERBS.find((verb) => label.toLowerCase().includes(verb))
      return hit ? [`"${label}" (contains "${hit}")`] : []
    })
    expect(
      offenders,
      'these labels describe events the worker never detects — it runs a keyword search and files '
      + `every trigger as keyword_match. Name the label instead:\n  ${offenders.join('\n  ')}`,
    ).toEqual([])
  })

  it('the any_activity option does not name one specific kind of activity', () => {
    const block = ALERTS_ROUTE.match(/\{\s*value:\s*'any_activity',\s*label:\s*'([^']*)'/)
    expect(block, "expected an 'any_activity' option").not.toBeNull()
    const label = block![1].toLowerCase()
    // `evaluateMatch` treats any_activity as matching every event type, so a label
    // naming one type promises a narrowing the value cannot deliver.
    for (const specific of ['repo', 'repository', 'product', 'post', 'role']) {
      expect(
        label.includes(specific),
        `the any_activity label says "${block![1]}" but that value matches every type — `
        + `naming "${specific}" promises a filter it does not apply`,
      ).toBe(false)
    }
  })

  it('the caveat is on the screen, next to the control', () => {
    // The spec being honest is not enough if the UI is not.
    expect(ALERTS_ROUTE).toContain('data-testid="alert-event-type-caveat"')
    expect(ALERTS_ROUTE).toMatch(/not a watched event/i)
  })

  it('the field label does not promise notification on an event', () => {
    expect(ALERTS_ROUTE).not.toContain('Notify me when')
  })
})
