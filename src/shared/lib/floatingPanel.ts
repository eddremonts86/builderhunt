/** Shared inset margin for clamping a fixed-position floating panel (dropdown
 * menu, mobile nav sheet) so it never renders partially off-screen on narrow
 * viewports — matches the codebase's existing small-gap spacing scale. */
export const FLOATING_PANEL_VIEWPORT_MARGIN = 8

/**
 * Clamp a right-anchored floating panel (positioned via CSS `right`, i.e. its
 * right edge sits `rightFromTrigger` px from the viewport's right edge and it
 * extends *leftward* from there by `panelWidth`) so its left edge never
 * crosses the viewport's left edge on narrow screens.
 *
 * `rightFromTrigger` is typically `window.innerWidth - triggerRect.right`.
 * `panelWidth` should come from measuring the actual rendered panel
 * (`panelRef.current?.getBoundingClientRect().width`); pass `0` before first
 * paint, which safely clamps to `margin`.
 */
export function clampRightAnchoredPanel(
  rightFromTrigger: number,
  panelWidth: number,
  margin = FLOATING_PANEL_VIEWPORT_MARGIN,
): number {
  const maxRight = window.innerWidth - panelWidth - margin
  return Math.min(rightFromTrigger, Math.max(margin, maxRight))
}
