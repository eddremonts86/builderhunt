import { describe, expect, it } from 'vitest'
import { contrastRatio, CONTRAST_MINIMUMS } from './accessibility'

/**
 * Regression guard for the semantic token pairs used across the app —
 * `pnpm test:a11y` (axe-core, live DOM) is the ground truth that found every
 * fix encoded here, but it only runs against whatever routes/states happen
 * to be in the matrix. These pure assertions pin the *tokens themselves* so
 * a future edit to globals.css can't silently regress a pair axe isn't
 * currently exercising.
 *
 * Values are copied from src/shared/styles/globals.css — if a token value
 * changes there, update it here too (there's no shared source at build time
 * since one is CSS and the other is a plain TS constant).
 */

const LIGHT = {
  bg: '#ececf0',
  surface: '#ffffff',
  text: '#18181b',
  textMuted: '#52525b',
  textDim: '#616168', // fixed 2026-07-24 — was #71717a, measured 4.1:1 against bg (below 4.5:1)
  accent: '#e07338',
  danger: '#b91c1c', // fixed 2026-07-24 — was #dc2626, measured 4.1:1 against bg (below 4.5:1)
}

const DARK = {
  bg: '#0a0a0d',
  surface: '#16161c',
  text: '#f4f4f5',
  textMuted: '#a1a1aa',
  textDim: '#a4a4ab', // fixed 2026-07-24 — was #71717a, measured 3.1-3.7:1 (axe: color-contrast); given extra margin beyond the bare floor since nested card contexts can measure ~0.1 lower than the flat-surface calculation
  accent: '#e07338',
  danger: '#dc2626',
  dangerText: '#f26464', // .dark override on .text-bh-danger / .btn-danger-outline; danger itself
  // stays #dc2626 (also used as a solid fill on .btn-danger, which reads fine with white text)
}

describe('semantic text-contrast pairs (WCAG 1.4.3, normal text >= 4.5:1)', () => {
  it('light mode: text on bg and surface', () => {
    expect(contrastRatio(LIGHT.text, LIGHT.bg)).toBeGreaterThanOrEqual(CONTRAST_MINIMUMS.normalText)
    expect(contrastRatio(LIGHT.text, LIGHT.surface)).toBeGreaterThanOrEqual(CONTRAST_MINIMUMS.normalText)
  })

  it('light mode: text-muted on bg and surface', () => {
    expect(contrastRatio(LIGHT.textMuted, LIGHT.bg)).toBeGreaterThanOrEqual(CONTRAST_MINIMUMS.normalText)
    expect(contrastRatio(LIGHT.textMuted, LIGHT.surface)).toBeGreaterThanOrEqual(CONTRAST_MINIMUMS.normalText)
  })

  it('light mode: text-dim on bg and surface', () => {
    expect(contrastRatio(LIGHT.textDim, LIGHT.bg)).toBeGreaterThanOrEqual(CONTRAST_MINIMUMS.normalText)
    expect(contrastRatio(LIGHT.textDim, LIGHT.surface)).toBeGreaterThanOrEqual(CONTRAST_MINIMUMS.normalText)
  })

  it('light mode: danger text on bg and surface', () => {
    expect(contrastRatio(LIGHT.danger, LIGHT.bg)).toBeGreaterThanOrEqual(CONTRAST_MINIMUMS.normalText)
    expect(contrastRatio(LIGHT.danger, LIGHT.surface)).toBeGreaterThanOrEqual(CONTRAST_MINIMUMS.normalText)
  })

  it('dark mode: text on bg and surface', () => {
    expect(contrastRatio(DARK.text, DARK.bg)).toBeGreaterThanOrEqual(CONTRAST_MINIMUMS.normalText)
    expect(contrastRatio(DARK.text, DARK.surface)).toBeGreaterThanOrEqual(CONTRAST_MINIMUMS.normalText)
  })

  it('dark mode: text-muted on bg and surface', () => {
    expect(contrastRatio(DARK.textMuted, DARK.bg)).toBeGreaterThanOrEqual(CONTRAST_MINIMUMS.normalText)
    expect(contrastRatio(DARK.textMuted, DARK.surface)).toBeGreaterThanOrEqual(CONTRAST_MINIMUMS.normalText)
  })

  it('dark mode: text-dim on bg and surface (regression guard for the 2026-07-24 fix)', () => {
    expect(contrastRatio(DARK.textDim, DARK.bg)).toBeGreaterThanOrEqual(CONTRAST_MINIMUMS.normalText)
    expect(contrastRatio(DARK.textDim, DARK.surface)).toBeGreaterThanOrEqual(CONTRAST_MINIMUMS.normalText)
  })

  it('dark mode: .text-bh-danger override on bg and surface (regression guard)', () => {
    expect(contrastRatio(DARK.dangerText, DARK.bg)).toBeGreaterThanOrEqual(CONTRAST_MINIMUMS.normalText)
    expect(contrastRatio(DARK.dangerText, DARK.surface)).toBeGreaterThanOrEqual(CONTRAST_MINIMUMS.normalText)
  })
})

describe('accent-contrast (fixed 2026-07-25 — was a pinned known-failing exception)', () => {
  it('dark-ink accent-contrast text on the solid accent fill clears 4.5:1', () => {
    // Was white (#ffffff), 3.14:1 — below the 4.5:1 text minimum. Rather than
    // darken the signature terracotta accent (used everywhere: badges,
    // links, focus rings, the brand mark), --color-bh-accent-contrast
    // became a dark ink (#1a0f0a). The corresponding EXPECTED_EXCEPTIONS
    // entries in test/test-accessibility.mjs and the "known gap" note in
    // docs/accessibility-verification.md were removed alongside this fix.
    const accentContrast = '#1a0f0a'
    expect(contrastRatio(accentContrast, LIGHT.accent)).toBeGreaterThanOrEqual(CONTRAST_MINIMUMS.normalText)
    expect(contrastRatio(accentContrast, '#ca5d25')).toBeGreaterThanOrEqual(CONTRAST_MINIMUMS.normalText) // --color-bh-accent-hover, the gradient's other stop
  })
})
