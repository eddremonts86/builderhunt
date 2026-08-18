/**
 * The three home-page sections (plan: phase-2/08-homing-page-content-and-sections).
 *
 * These assertions exist because the markdown drafts they replace failed every one of them: a shipped
 * feature badged "Coming soon", a source count that was wrong and typed by hand, and credit
 * allowances that appear nowhere in this repository.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  AI_HELPERS_SECTION,
  isShipped,
  LANDING_SECTIONS,
  PIPELINE_SECTION,
  ROADMAP_SECTION,
} from '~/modules/landing/content/landing-sections'

const ALL_ITEMS = LANDING_SECTIONS.flatMap((section) => section.items)

describe('every item names a plan that exists', () => {
  /**
   * The whole scheme rests on this. `isShipped` reads the path, so a path that does not resolve makes
   * the badge meaningless rather than merely wrong — and a bad link on a landing page is a click that
   * ends in a 404 for a reader who was already sceptical.
   */
  it.each(ALL_ITEMS.map((item) => [item.title, item.planPath] as const))(
    '%s → plans/%s/spec.md',
    (_title, planPath) => {
      expect(existsSync(join(process.cwd(), 'plans', planPath, 'spec.md'))).toBe(true)
    },
  )
})

describe('the roadmap advertises only what has not shipped', () => {
  /**
   * The error this makes unwriteable. An earlier draft listed Solutions Intelligence as upcoming while
   * `43-solutions-intelligence` sat in `implemented/`, and badged Team shortlists "Coming soon" for
   * the same reason. Underselling is the failure nobody catches, because no reviewer audits a landing
   * page for modesty.
   */
  it('contains nothing already implemented', () => {
    const shipped = ROADMAP_SECTION.items.filter((item) => isShipped(item.planPath))
    expect(shipped.map((item) => item.title)).toEqual([])
  })

  it('is seven items, not the eight an earlier draft claimed', () => {
    expect(ROADMAP_SECTION.items).toHaveLength(7)
  })
})

describe('the shipped sections claim only what has shipped', () => {
  it('pipeline is entirely implemented plans', () => {
    const unshipped = PIPELINE_SECTION.items.filter((item) => !isShipped(item.planPath))
    expect(unshipped.map((item) => item.title)).toEqual([])
  })

  /** One tile is deliberately not shipped, and it must be the CV one — hence naming it. */
  it('ai helpers is implemented except the CV tile', () => {
    const unshipped = AI_HELPERS_SECTION.items.filter((item) => !isShipped(item.planPath))
    expect(unshipped.map((item) => item.title)).toEqual(['CV generation and tailoring'])
  })
})

describe('no number is typed into the copy', () => {
  /**
   * "12 sources" reached nine surfaces and went stale on all nine the same day; "Pro: 140
   * credits/month" appears nowhere `grep -rn` can find. A bare integer in this file is the same
   * defect waiting to happen, so the only numbers allowed are ones interpolated from a constant —
   * which by definition are not in the source text.
   */
  const NUMERIC = /\b\d+\b/
  it.each(ALL_ITEMS.map((item) => [item.title, item.copy] as const))('%s has no hand-written number', (_t, copy) => {
    expect(copy).not.toMatch(NUMERIC)
  })

  it.each(LANDING_SECTIONS.map((s) => [s.heading, s.subheading] as const))(
    '%s: the subheading has no hand-written number',
    (_h, subheading) => {
      expect(subheading).not.toMatch(NUMERIC)
    },
  )
})

describe('the copy keeps the promises this product may not make', () => {
  const text = JSON.stringify(LANDING_SECTIONS)

  /** Email alerts are a paid action; a free workspace gets the feed link. */
  it('never promises email alerts without the paid qualifier', () => {
    expect(text).not.toMatch(/email alert/i)
  })

  it('makes no claim about a builder being available or looking', () => {
    expect(text).not.toMatch(/available for hire|open to offers|actively looking/i)
  })

  it('promises no outcome it does not control', () => {
    expect(text).not.toMatch(/guarantee|get noticed|recruiters will|land (a|your) job/i)
  })
})
