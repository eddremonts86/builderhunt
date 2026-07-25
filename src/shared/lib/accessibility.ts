/** Pure WCAG 2.x relative-luminance contrast — no DOM, no browser, so it can
 * assert design-token pairs as a plain unit test (see accessibility.test.ts)
 * instead of only discovering regressions live via axe-core. */

function channelLuminance(channel: number): number {
  const c = channel / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '')
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean
  const int = parseInt(full, 16)
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255]
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex)
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b)
}

/** WCAG contrast ratio between two colors, in the canonical 1-21 range. */
export function contrastRatio(hexA: string, hexB: string): number {
  const lA = relativeLuminance(hexA)
  const lB = relativeLuminance(hexB)
  const lighter = Math.max(lA, lB)
  const darker = Math.min(lA, lB)
  return (lighter + 0.05) / (darker + 0.05)
}

/** WCAG 2.x text-contrast minimums. "Large" text is >=18.66px bold or
 * >=24px regular (SC 1.4.3); non-text (borders, focus indicators, graphical
 * objects) uses the 3:1 SC 1.4.11 threshold instead of 1.4.3's 4.5:1. */
export const CONTRAST_MINIMUMS = {
  normalText: 4.5,
  largeText: 3,
  nonText: 3,
} as const
