/**
 * The nine canonical cell presentations.
 *
 * Eight components and one deliberate absence: **`category` has no component**, because the
 * reference's rule for it is "plain text, never a decorative grey chip". A `CategoryCell` would be
 * a component whose whole body is `{value}`, and the first thing anyone would do with it is give it
 * a background — which is the rule it exists to state. So the rule lives in the column kind
 * (`--tbl-col-category` sizes the track) and in the gate, and the cell is a string.
 *
 * A surface reaches for these rather than writing its own JSX so that a date is one date format
 * across nineteen tables, a status is one chip, and a number is right-aligned everywhere without
 * anybody having to remember to align it.
 */

export { ActionsCell } from './ActionsCell'
export { DateCell } from './DateCell'
export { EmptyCell } from './EmptyCell'
export { IdentityCell } from './IdentityCell'
export { NumberCell } from './NumberCell'
export { PrimaryCell } from './PrimaryCell'
export { RatioCell } from './RatioCell'
export { StatusCell, type StatusTone } from './StatusCell'
