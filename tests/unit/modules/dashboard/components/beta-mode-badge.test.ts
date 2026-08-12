import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Plan 58, task 9 — the member badge, asserted structurally.
 *
 * `UserMenu` renders inside a `motion.div` portal that only mounts on click, and the properties worth
 * pinning here are not "does the text appear" — they are *where the read lives* and *what happens when
 * it fails*. Both are structural, and a render test would prove neither: it would mount the component
 * with a prop already set and say nothing about whether the prop costs one request per session or one
 * per navigation.
 */
const root = process.cwd()
const MENU = readFileSync(join(root, 'src', 'modules', 'dashboard', 'components', 'UserMenu.tsx'), 'utf8')
const TOPBAR = readFileSync(join(root, 'src', 'modules', 'dashboard', 'ui', 'shell', 'ContextTopbar.tsx'), 'utf8')
const LAYOUT = readFileSync(join(root, 'src', 'modules', 'dashboard', 'ui', 'shell', 'DashboardLayout.tsx'), 'utf8')

describe('the beta-mode badge', () => {
  it('takes the state as a prop and never fetches for itself', () => {
    // `UserMenu` mounts on every dashboard route. A fetch inside it would be one request per mount, per
    // navigation, for a label.
    expect(MENU).toMatch(/betaModeEnabled\?: boolean/)
    expect(MENU).not.toMatch(/fetch\(/)
  })

  it('is read exactly once, by the shell that owns per-session reads', () => {
    expect(LAYOUT).toMatch(/fetch\('\/api\/beta-mode'/)
    // An empty dependency array is what makes it once per mount rather than once per render.
    expect(LAYOUT).toMatch(/\}, \[\]\)/)
  })

  it('threads through the topbar rather than being read again there', () => {
    expect(TOPBAR).toMatch(/betaModeEnabled\?: boolean/)
    expect(TOPBAR).toMatch(/betaModeEnabled=\{betaModeEnabled\}/)
    expect(TOPBAR).not.toMatch(/fetch\(/)
  })

  it('renders nothing when beta mode is off', () => {
    // Absent, not muted. There is nothing to tell someone about a promotion that is not running.
    expect(MENU).toMatch(/\{betaModeEnabled && \(/)
    expect(MENU).toMatch(/betaModeEnabled = false/)
  })

  it('names the allowance in text rather than signalling with colour alone', () => {
    // A dot says "something is on" and leaves a member guessing why they have capabilities they did not
    // pay for. The number is the part that changes what they can do.
    expect(MENU).toMatch(/Beta · 700 credits\/month/)
    expect(MENU).toMatch(/data-testid="beta-mode-badge"/)
  })

  it('swallows a failed read instead of surfacing it', () => {
    /**
     * Two reasons, and the second is why it is asserted.
     *
     * A badge must never break the shell that carries the navigation. And a `console.error` here would
     * fail the strict browser collectors on *every* dashboard spec — the same trap that made the
     * contextual service-degradation widget get reverted, where polling a 503 endpoint put two console
     * errors on every load.
     */
    const effect = LAYOUT.slice(LAYOUT.indexOf("fetch('/api/beta-mode'"))
    const body = effect.slice(0, effect.indexOf('}, [])'))
    expect(body).toMatch(/catch \{/)
    expect(body).not.toMatch(/console\.(error|warn)/)
  })
})
