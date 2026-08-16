import { describe, expect, it } from 'vitest'
import { contrastRatio, CONTRAST_MINIMUMS } from '~/shared/lib/accessibility'

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

/**
 * The `--tbl-*` table contract (plan phase-3/14).
 *
 * The reference these literals came from is a warm stone ramp tuned for a white
 * page, and four of its roles do not clear the contrast the same specification
 * demands. Those four moved one step down the reference's own ramp; these
 * assertions are what pins that, and what would catch a future edit putting the
 * original values back because they "look closer to the design".
 *
 * Values are copied from the `--tbl-*` block in src/shared/styles/globals.css.
 */
const TBL_LIGHT = {
  surface: '#ffffff',
  surfaceSubtle: '#fafaf9',
  textPrimary: '#1b1917',
  textSecondary: '#44403c',
  textMuted: '#57534e', // reference #a8a29e measured 2.52:1 on white; #78716c only 4.48:1 on the selected row
  headerIdle: '#78716c',
  headerActive: '#44403c',
  focusRing: '#ca5d25', // reference accent #e8703a measured 2.93:1 on the selected row
  rowSelected: '#fdf6f1',
  rowDanger: '#fef9f8',
  chips: {
    success: ['#166534', '#eaf7ee'],
    warning: ['#9a5b0b', '#fef3e7'],
    danger: ['#9f2d20', '#fdecea'],
    neutral: ['#57534e', '#f5f4f2'], // reference #78716c measured 4.36:1 on #f5f4f2
    accent: ['#9a4318', '#fdf0e9'],
  },
} as const

const TBL_DARK = {
  surface: '#16161c', // --color-bh-surface
  surfaceSubtle: '#1c1c24', // --color-bh-surface-2
  textPrimary: '#f4f4f5',
  textSecondary: '#a1a1aa',
  textMuted: '#a4a4ab',
  headerIdle: '#a4a4ab',
  headerActive: '#f4f4f5',
  focusRing: '#e07338',
  rowSelected: '#241a15',
  rowDanger: '#241416',
  chips: {
    success: ['#4ade80', '#152a1e'],
    warning: ['#fbbf24', '#2a1e0c'],
    danger: ['#f26464', '#2c1616'],
    neutral: ['#a4a4ab', '#232329'],
    accent: ['#f5a878', '#2e1c11'],
  },
} as const

describe('table tokens: cell and header text (WCAG 1.4.3, >= 4.5:1)', () => {
  for (const [mode, tokens] of [['light', TBL_LIGHT], ['dark', TBL_DARK]] as const) {
    /** Every row background a cell can sit on. Ink has to clear AA on all of them, not just the resting one. */
    const backgrounds = [tokens.surface, tokens.surfaceSubtle, tokens.rowSelected, tokens.rowDanger]

    it(`${mode} mode: primary and secondary ink on every row state`, () => {
      for (const background of backgrounds) {
        expect(contrastRatio(tokens.textPrimary, background)).toBeGreaterThanOrEqual(CONTRAST_MINIMUMS.normalText)
        expect(contrastRatio(tokens.textSecondary, background)).toBeGreaterThanOrEqual(CONTRAST_MINIMUMS.normalText)
      }
    })

    /**
     * The em dash in an empty cell and every cell's second line are this colour.
     * The reference's own value fails here; that is why the token is not it.
     */
    it(`${mode} mode: muted ink on every row state`, () => {
      for (const background of backgrounds) {
        expect(contrastRatio(tokens.textMuted, background)).toBeGreaterThanOrEqual(CONTRAST_MINIMUMS.normalText)
      }
    })

    /** 11px bold is not "large text" (that starts at 18.66px bold), so the header is held to 4.5:1 too. */
    it(`${mode} mode: idle and active header ink on the header's own surface`, () => {
      expect(contrastRatio(tokens.headerIdle, tokens.surfaceSubtle)).toBeGreaterThanOrEqual(CONTRAST_MINIMUMS.normalText)
      expect(contrastRatio(tokens.headerActive, tokens.surfaceSubtle)).toBeGreaterThanOrEqual(CONTRAST_MINIMUMS.normalText)
    })

    /** The reference's whole point about the active column: it reads stronger than the idle ones. */
    it(`${mode} mode: the active header is stronger than an idle one`, () => {
      expect(contrastRatio(tokens.headerActive, tokens.surfaceSubtle))
        .toBeGreaterThan(contrastRatio(tokens.headerIdle, tokens.surfaceSubtle))
    })
  }
})

describe('table tokens: status chips (WCAG 1.4.3, >= 4.5:1 on their own fill)', () => {
  for (const [mode, tokens] of [['light', TBL_LIGHT], ['dark', TBL_DARK]] as const) {
    it(`${mode} mode: every tone`, () => {
      for (const [tone, [foreground, background]] of Object.entries(tokens.chips)) {
        expect(
          contrastRatio(foreground, background),
          `${mode} ${tone} chip`,
        ).toBeGreaterThanOrEqual(CONTRAST_MINIMUMS.normalText)
      }
    })
  }
})

describe('table tokens: focus and interactive boundaries (WCAG 1.4.11, >= 3:1)', () => {
  it('the 2px focus ring is visible against every row state it is drawn on', () => {
    for (const tokens of [TBL_LIGHT, TBL_DARK]) {
      for (const background of [tokens.surface, tokens.surfaceSubtle, tokens.rowSelected, tokens.rowDanger]) {
        expect(contrastRatio(tokens.focusRing, background)).toBeGreaterThanOrEqual(CONTRAST_MINIMUMS.nonText)
      }
    }
  })

  /**
   * Why the ring is not simply `--tbl-accent`. The reference's terracotta clears
   * 3:1 on white and fails it on the selected-row tint — which is the row you
   * are most likely to be operating on with a keyboard.
   */
  it('records why the ring is a darker token than the decorative accent', () => {
    expect(contrastRatio('#e8703a', TBL_LIGHT.rowSelected)).toBeLessThan(CONTRAST_MINIMUMS.nonText)
    expect(contrastRatio(TBL_LIGHT.focusRing, TBL_LIGHT.rowSelected)).toBeGreaterThanOrEqual(CONTRAST_MINIMUMS.nonText)
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
