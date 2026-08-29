/**
 * The shared inclusion policy (plan: phase-2/07-perfiles-autogestionados, §"Principio de cobertura
 * universal en matching").
 *
 * A pure module, so these are pure tests. What they pin is the part four surfaces would otherwise
 * each re-derive: that inclusion is the default, that only an explicit choice removes it, which
 * level of choice wins, and that turning it off narrows a list without touching the order of what
 * remains.
 */
import { describe, expect, it } from 'vitest'

import {
  applySelfManagedInclusion,
  decideSelfManagedInclusion,
  decorateSelfManagedProvenance,
  isSelfManagedRow,
  provenanceFor,
  SELF_MANAGED_ORIGIN,
  withSelfManagedOrigin,
} from '~/shared/lib/self-managed/inclusion-policy'
import { INTERNAL_ORIGIN_NAMES } from '~/lib/sources/types'

const claimed = { source: 'github', sourceId: '1' }
const selfManaged = { source: SELF_MANAGED_ORIGIN, sourceId: 'prof-1' }

describe('the decision matrix', () => {
  it('includes by default, when nobody has said anything', () => {
    expect(decideSelfManagedInclusion()).toEqual({ include: true, reason: 'default-on' })
    expect(decideSelfManagedInclusion({})).toEqual({ include: true, reason: 'default-on' })
  })

  it('treats "never chosen" as included and never as excluded', () => {
    // The distinction the nullable column exists for: `null` is not `false`, so a later change of
    // default reaches people who never answered without overwriting the choice of those who did.
    expect(decideSelfManagedInclusion({ accountPreference: null }).include).toBe(true)
    expect(decideSelfManagedInclusion({ accountPreference: undefined }).include).toBe(true)
    expect(decideSelfManagedInclusion({ surfacePreference: null }).include).toBe(true)
  })

  it('excludes only on an explicit no', () => {
    expect(decideSelfManagedInclusion({ accountPreference: false }))
      .toEqual({ include: false, reason: 'account-opted-out' })
    expect(decideSelfManagedInclusion({ surfacePreference: false }))
      .toEqual({ include: false, reason: 'surface-opted-out' })
  })

  it('lets the surface win over the account, in both directions', () => {
    // The spec: "el toggle global solo se aplica si el toggle por superficie no está definido".
    // A sprint narrowing one shortlist must not rewrite a standing preference, and a standing
    // preference must not override a decision somebody just made on the screen in front of them.
    expect(decideSelfManagedInclusion({ accountPreference: true, surfacePreference: false }))
      .toEqual({ include: false, reason: 'surface-opted-out' })
    expect(decideSelfManagedInclusion({ accountPreference: false, surfacePreference: true }))
      .toEqual({ include: true, reason: 'surface-opted-in' })
  })

  it('names the origin the search layer actually knows', () => {
    expect(INTERNAL_ORIGIN_NAMES as readonly string[]).toContain(SELF_MANAGED_ORIGIN)
  })
})

describe('withSelfManagedOrigin', () => {
  const include = { include: true, reason: 'default-on' } as const
  const exclude = { include: false, reason: 'account-opted-out' } as const

  it('appends rather than inserts, so the caller’s own order is untouched', () => {
    expect(withSelfManagedOrigin(['github', 'hn'], include)).toEqual(['github', 'hn', SELF_MANAGED_ORIGIN])
  })

  it('leaves a list alone when the answer is no', () => {
    expect(withSelfManagedOrigin(['github', 'hn'], exclude)).toEqual(['github', 'hn'])
  })

  it('is idempotent — resolving the policy twice cannot search the origin twice', () => {
    const once = withSelfManagedOrigin(['github'], include)
    expect(withSelfManagedOrigin(once, include)).toEqual(once)
  })

  it('removes the origin from a list that already named it when the answer is no', () => {
    // A cached or stored source list written while inclusion was on must stop being honoured the
    // moment somebody opts out, not when the cache expires.
    expect(withSelfManagedOrigin(['github', SELF_MANAGED_ORIGIN], exclude)).toEqual(['github'])
  })

  it('does not manufacture a search out of an empty list', () => {
    // The trap this exists for, found by breaking it: `searchBuilders` treats an *absent* source
    // list as "the defaults" and an *empty* one as "no sources at all". So appending the origin to
    // `[]` produces a search of nothing but self-managed profiles — the opposite of adding one
    // origin to the usual set. The policy stays honest about what it was handed; the caller passes
    // `DEFAULT_SEARCH_SOURCES` when it means the defaults.
    expect(withSelfManagedOrigin([], include)).toEqual([SELF_MANAGED_ORIGIN])
    expect(withSelfManagedOrigin([], exclude)).toEqual([])
  })

  it('does not change the network sources it was handed, ever', () => {
    const sources = ['github', 'hn', 'devto']
    expect(withSelfManagedOrigin(sources, include).slice(0, 3)).toEqual(sources)
    expect(withSelfManagedOrigin(sources, exclude)).toEqual(sources)
  })
})

describe('applySelfManagedInclusion', () => {
  const rows = [claimed, selfManaged, { source: 'hn', sourceId: '2' }]

  it('keeps every row when included, in the order it was given', () => {
    expect(applySelfManagedInclusion(rows, { include: true, reason: 'default-on' })).toEqual(rows)
  })

  it('drops only self-managed rows, and preserves the rank of the rest', () => {
    const filtered = applySelfManagedInclusion(rows, { include: false, reason: 'account-opted-out' })

    expect(filtered).toEqual([claimed, { source: 'hn', sourceId: '2' }])
    // The plan's rule: an opt-out changes inclusion only. The rows that were going to be there are
    // in the same relative order they were in before — nothing is re-ranked to fill the gap.
    expect(filtered.map((row) => row.source)).toEqual(['github', 'hn'])
  })

  it('never mutates the array it was handed', () => {
    const original = [...rows]
    applySelfManagedInclusion(rows, { include: false, reason: 'account-opted-out' })
    expect(rows).toEqual(original)
  })
})

describe('provenance', () => {
  it('marks a self-managed row and only a self-managed row', () => {
    expect(isSelfManagedRow(selfManaged)).toBe(true)
    expect(isSelfManagedRow(claimed)).toBe(false)
    expect(isSelfManagedRow({})).toBe(false)
  })

  it('carries the exact chip label, so no surface invents a kinder synonym', () => {
    expect(provenanceFor(selfManaged)).toEqual({ isSelfManaged: true, chipLabel: 'Self-managed' })
    expect(provenanceFor(claimed)).toEqual({ isSelfManaged: false, chipLabel: null })
  })

  it('decorates every row, not only the self-managed ones', () => {
    const decorated = decorateSelfManagedProvenance([claimed, selfManaged])

    // A field present on some rows and absent on others is one a renderer reads as `undefined` and
    // treats as "no chip" — which is exactly how the chip gets omitted by accident.
    expect(decorated.every((row) => 'isSelfManaged' in row && 'chipLabel' in row)).toBe(true)
    expect(decorated[0]!.chipLabel).toBeNull()
    expect(decorated[1]!.chipLabel).toBe('Self-managed')
  })

  it('leaves the original rows untouched', () => {
    const rows = [claimed]
    decorateSelfManagedProvenance(rows)
    expect(rows[0]).not.toHaveProperty('isSelfManaged')
  })
})

describe('what the policy deliberately does not decide', () => {
  it('says nothing about eligibility — that lives with the rows', () => {
    // Public, undeleted and unsuppressed are decided by the origin's query and `filterSuppressed`.
    // A second copy here would be a second thing to keep in step with the row policies, and the one
    // that lags is the one that shows a withdrawn profile.
    const draftLookingRow = { source: SELF_MANAGED_ORIGIN, sourceId: 'prof-draft' }
    expect(applySelfManagedInclusion([draftLookingRow], { include: true, reason: 'default-on' }))
      .toEqual([draftLookingRow])
  })
})
