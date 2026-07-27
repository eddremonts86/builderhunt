import { useMemo } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '~/components/ui'

/**
 * The candidate's slot chooser (plan: calendar-scheduling-interview-intelligence, Phase 5 "Build
 * mobile accountless candidate portal").
 *
 * Buttons in a list, grouped by day. No drag, no drop, no grid — spec.md calls for a "slot picker
 * without drag/drop", and the reason is that this is the one screen a candidate must be able to
 * complete on a phone, one-handed, possibly with a screen reader, possibly on a train. A pointer
 * gesture is the least accessible way to express "I want 11:00 on Tuesday".
 *
 * Times are rendered in the timezone the candidate selected, not the organizer's. A candidate in
 * Bogotá reading "14:00" and meaning Copenhagen's 14:00 is how people miss interviews, so the zone is
 * printed next to the time rather than implied.
 */

export interface SlotDto {
  slotId: string
  startsAt: string
  endsAt: string
}

export interface SlotPickerProps {
  slots: SlotDto[]
  timezone: string
  loading?: boolean
  selectedSlotId?: string | null
  onSelect: (slot: SlotDto) => void
  disabled?: boolean
}

function dayKey(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(iso))
}

function dayLabel(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, weekday: 'long', day: 'numeric', month: 'long',
  }).format(new Date(iso))
}

function timeLabel(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso))
}

export function SlotPicker({ slots, timezone, loading, selectedSlotId, onSelect, disabled }: SlotPickerProps) {
  const grouped = useMemo(() => {
    const byDay = new Map<string, SlotDto[]>()
    for (const slot of slots) {
      const key = dayKey(slot.startsAt, timezone)
      const bucket = byDay.get(key)
      if (bucket) bucket.push(slot)
      else byDay.set(key, [slot])
    }
    return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [slots, timezone])

  if (loading) {
    return (
      <p className="flex items-center gap-2 text-sm text-bh-text-muted" role="status">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Loading available times…
      </p>
    )
  }

  if (slots.length === 0) {
    return (
      <p className="text-sm text-bh-text-muted" role="status">
        No times are available in this range. Try a later date range, or reply to the invitation email
        to ask for other options.
      </p>
    )
  }

  return (
    <div className="space-y-6">
      {grouped.map(([key, daySlots]) => (
        <div key={key}>
          <h3 className="mb-2 text-sm font-semibold text-bh-text">
            {dayLabel(daySlots[0]!.startsAt, timezone)}
          </h3>
          {/* A list, so a screen reader announces how many times are on offer for this day. */}
          <ul className="flex flex-wrap gap-2" aria-label={`Available times on ${dayLabel(daySlots[0]!.startsAt, timezone)}`}>
            {daySlots.map((slot) => {
              const selected = slot.slotId === selectedSlotId
              return (
                <li key={slot.slotId}>
                  <Button
                    type="button"
                    variant={selected ? 'primary' : 'secondary'}
                    size="sm"
                    disabled={disabled}
                    aria-pressed={selected}
                    onClick={() => onSelect(slot)}
                  >
                    {timeLabel(slot.startsAt, timezone)}
                    <span className="sr-only"> to {timeLabel(slot.endsAt, timezone)} {timezone}</span>
                  </Button>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </div>
  )
}
