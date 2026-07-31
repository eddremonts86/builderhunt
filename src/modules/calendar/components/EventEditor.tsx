import { useState } from 'react'
import { Loader2, Trash2 } from 'lucide-react'
import { Button, Input, Label } from '~/components/ui'
import {
  CALENDAR_EVENT_TYPES,
  EVENT_PARTICIPANT_ROLES,
  REMINDER_CHANNELS,
  REMINDER_OFFSET_MINUTES,
} from '~/shared/lib/calendar'

/**
 * Create/edit form for a calendar event (plans/UI Wave 3 "Build complete event create, detail, and
 * edit UI").
 *
 * The field set is split deliberately by what the server can actually persist, not by what a
 * calendar "usually" lets you edit:
 * - Create (`POST /api/calendar/events`) accepts type, reminders, participants, and a recurrence
 *   rule.
 * - Patch (`PATCH /api/calendar/events/:id`) accepts only the scalar fields (title, times,
 *   timezone, location, meeting URL, all-day, busy). It has no field for reminders, participants,
 *   or the recurrence rule, and editing a single occurrence returns `not_implemented` server-side —
 *   only a whole-series edit is supported.
 *
 * So edit mode hides the create-only controls rather than rendering inputs whose changes the PATCH
 * route would silently drop, and a recurring edit is announced as applying to the whole series and
 * submitted with `recurrenceScope: 'series'`. This mirrors `CalendarPage`/`CalendarView`'s existing
 * decision to stay off drag/resize until per-occurrence editing exists server-side.
 */

export type RecurrenceScope = 'this' | 'following' | 'series'
type EventType = (typeof CALENDAR_EVENT_TYPES)[number]
type ReminderChannel = (typeof REMINDER_CHANNELS)[number]
type ParticipantRole = (typeof EVENT_PARTICIPANT_ROLES)[number]
type RepeatFrequency = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly'

export interface EventReminderInput {
  channel: ReminderChannel
  offsetMinutes: number
}

export interface EventParticipantInput {
  displayName?: string
  externalEmail?: string
  userId?: string
  role: ParticipantRole
}

export interface EventFormValue {
  type: EventType
  title: string
  description: string | null
  location: string | null
  meetingUrl: string | null
  startsAt: string
  endsAt: string
  timezone: string
  allDay: boolean
  busy: boolean
  reminders: EventReminderInput[]
  participants: EventParticipantInput[]
  rrule: string | null
  recurrenceUntil: string | null
}

export interface EventEditorSubmitMeta {
  acknowledgeOverlapWarning: boolean
  recurrenceScope?: RecurrenceScope
}

export interface EventEditorProps {
  mode: 'create' | 'edit'
  defaultTimezone: string
  timezoneOptions?: string[]
  /** The date the grid was showing, so a new event lands where the user was looking. */
  defaultDate?: Date
  initial?: Partial<EventFormValue> & { version?: number }
  /** Edit mode only: the event has a recurrence rule, so a change applies to the whole series. */
  isRecurring?: boolean
  onSubmit: (value: EventFormValue, meta: EventEditorSubmitMeta) => Promise<{ ok: boolean; error?: string }>
  onCancel: () => void
}

const FREQUENCY_RRULE: Record<Exclude<RepeatFrequency, 'none'>, string> = {
  daily: 'DAILY',
  weekly: 'WEEKLY',
  monthly: 'MONTHLY',
  yearly: 'YEARLY',
}

const SELECT_CLASS = 'h-9 w-full rounded-md border border-bh-border bg-bh-surface px-3 text-sm'

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function addOneDay(day: string): string {
  const date = new Date(`${day}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + 1)
  return date.toISOString().slice(0, 10)
}

/** Split an ISO instant into the UTC calendar day and HH:mm the native inputs expect. */
function splitInstant(iso?: string): { day: string; time: string } {
  if (!iso) return { day: '', time: '' }
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return { day: '', time: '' }
  return { day: date.toISOString().slice(0, 10), time: date.toISOString().slice(11, 16) }
}

function typeLabel(type: EventType): string {
  return type === 'interview' ? 'Interview' : 'Personal'
}

function channelLabel(channel: ReminderChannel): string {
  return channel === 'email' ? 'Email' : 'In-app'
}

const ROLE_LABELS: Record<ParticipantRole, string> = {
  organizer: 'Organizer',
  attendee: 'Attendee',
}

function roleLabel(role: ParticipantRole): string {
  return ROLE_LABELS[role]
}

function offsetLabel(minutes: number): string {
  if (minutes === 0) return 'At start time'
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes / 1440 > 1 ? 's' : ''} before`
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes / 60 > 1 ? 's' : ''} before`
  return `${minutes} minutes before`
}

function messageForError(code?: string): string {
  switch (code) {
    case 'state_changed':
      return 'This event changed since you opened it. Close and reopen it to see the latest version.'
    case 'not_implemented':
      return 'Editing a single occurrence is not supported yet — edit the whole series instead.'
    case 'slot_unavailable':
      return 'That time conflicts with an existing booking.'
    case 'forbidden':
      return 'You do not have permission to change this event.'
    case 'not_found':
      return 'This event no longer exists. Close and refresh your calendar.'
    default:
      return 'We could not save that event. Check the details and try again.'
  }
}

export function EventEditor({
  mode,
  defaultTimezone,
  timezoneOptions,
  defaultDate,
  initial,
  isRecurring = false,
  onSubmit,
  onCancel,
}: EventEditorProps) {
  const initialStart = splitInstant(initial?.startsAt)
  const initialEnd = splitInstant(initial?.endsAt)

  const [type, setType] = useState<EventType>(initial?.type ?? 'personal')
  const [title, setTitle] = useState(initial?.title ?? '')
  const [allDay, setAllDay] = useState(initial?.allDay ?? false)
  const [day, setDay] = useState(initialStart.day || isoDay(defaultDate ?? new Date()))
  const [startTime, setStartTime] = useState(initialStart.time || '09:00')
  const [endTime, setEndTime] = useState(initialEnd.time || '09:30')
  const [timezone, setTimezone] = useState(initial?.timezone ?? defaultTimezone)
  const [location, setLocation] = useState(initial?.location ?? '')
  const [meetingUrl, setMeetingUrl] = useState(initial?.meetingUrl ?? '')
  const [busy, setBusy] = useState(initial?.busy ?? true)
  const [description, setDescription] = useState(initial?.description ?? '')
  const [reminders, setReminders] = useState<EventReminderInput[]>(
    initial?.reminders ?? [{ channel: 'in_app', offsetMinutes: 30 }],
  )
  const [participants, setParticipants] = useState<EventParticipantInput[]>(initial?.participants ?? [])
  const [repeat, setRepeat] = useState<RepeatFrequency>('none')
  const [interval, setIntervalValue] = useState('1')
  const [until, setUntil] = useState('')

  const [error, setError] = useState<string | null>(null)
  const [overlapPending, setOverlapPending] = useState(false)
  const [saving, setSaving] = useState(false)

  const timezones = timezoneOptions && timezoneOptions.length > 0 ? timezoneOptions : [timezone]
  const isCreate = mode === 'create'

  function buildValue(): EventFormValue {
    const startsAt = allDay ? `${day}T00:00:00.000Z` : `${day}T${startTime}:00.000Z`
    const endsAt = allDay ? `${addOneDay(day)}T00:00:00.000Z` : `${day}T${endTime}:00.000Z`
    const rrule = repeat === 'none' ? null : `FREQ=${FREQUENCY_RRULE[repeat]};INTERVAL=${Number(interval) || 1}`
    const recurrenceUntil = repeat === 'none' || !until ? null : `${until}T23:59:59.000Z`
    const cleanParticipants = participants
      .map((participant) => ({
        ...(participant.displayName?.trim() ? { displayName: participant.displayName.trim() } : {}),
        ...(participant.externalEmail?.trim() ? { externalEmail: participant.externalEmail.trim() } : {}),
        ...(participant.userId?.trim() ? { userId: participant.userId.trim() } : {}),
        role: participant.role,
      }))
      .filter((participant) => 'displayName' in participant || 'externalEmail' in participant || 'userId' in participant)

    return {
      type,
      title,
      description: description.trim() ? description : null,
      location: location.trim() ? location : null,
      meetingUrl: meetingUrl.trim() ? meetingUrl : null,
      startsAt,
      endsAt,
      timezone,
      allDay,
      busy,
      reminders,
      participants: cleanParticipants,
      rrule,
      recurrenceUntil,
    }
  }

  async function runSubmit(acknowledge: boolean) {
    setSaving(true)
    setError(null)
    try {
      const meta: EventEditorSubmitMeta = {
        acknowledgeOverlapWarning: acknowledge,
        recurrenceScope: !isCreate && isRecurring ? 'series' : undefined,
      }
      const result = await onSubmit(buildValue(), meta)
      if (result.ok) {
        setOverlapPending(false)
        return
      }
      if (result.error === 'overlap_warning') {
        setOverlapPending(true)
        return
      }
      setOverlapPending(false)
      setError(messageForError(result.error))
    } finally {
      setSaving(false)
    }
  }

  function handleSubmit(formEvent: React.FormEvent) {
    formEvent.preventDefault()
    void runSubmit(false)
  }

  function updateReminder(index: number, patch: Partial<EventReminderInput>) {
    setReminders((current) => current.map((reminder, i) => (i === index ? { ...reminder, ...patch } : reminder)))
  }

  function updateParticipant(index: number, patch: Partial<EventParticipantInput>) {
    setParticipants((current) => current.map((participant, i) => (i === index ? { ...participant, ...patch } : participant)))
  }

  return (
    <form onSubmit={handleSubmit} className="mb-6 rounded-xl border border-bh-border bg-bh-surface p-4" data-testid="event-editor">
      <div className="grid gap-4 sm:grid-cols-2">
        {isCreate && (
          <div>
            <Label htmlFor="ev-type">Type</Label>
            <select
              id="ev-type"
              className={SELECT_CLASS}
              value={type}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setType(e.target.value as EventType)}
              data-testid="event-editor-type"
            >
              {CALENDAR_EVENT_TYPES.map((option) => (
                <option key={option} value={option}>{typeLabel(option)}</option>
              ))}
            </select>
          </div>
        )}

        <div className="sm:col-span-2">
          <Label htmlFor="ev-title">Title</Label>
          <Input
            id="ev-title"
            value={title}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTitle(e.target.value)}
            required
            maxLength={200}
            data-testid="event-editor-title"
          />
        </div>

        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input
            type="checkbox"
            checked={allDay}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAllDay(e.target.checked)}
            data-testid="event-editor-all-day"
          />
          All day
        </label>

        <div>
          <Label htmlFor="ev-date">Date</Label>
          <Input
            id="ev-date"
            type="date"
            value={day}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDay(e.target.value)}
            required
            data-testid="event-editor-date"
          />
        </div>

        {!allDay && (
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label htmlFor="ev-start">Starts</Label>
              <Input
                id="ev-start"
                type="time"
                value={startTime}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setStartTime(e.target.value)}
                required
                data-testid="event-editor-start"
              />
            </div>
            <div>
              <Label htmlFor="ev-end">Ends</Label>
              <Input
                id="ev-end"
                type="time"
                value={endTime}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEndTime(e.target.value)}
                required
                data-testid="event-editor-end"
              />
            </div>
          </div>
        )}

        <div>
          <Label htmlFor="ev-tz">Timezone</Label>
          <select
            id="ev-tz"
            className={`${SELECT_CLASS} truncate`}
            value={timezone}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setTimezone(e.target.value)}
            data-testid="event-editor-timezone"
          >
            {timezones.map((tz) => (
              <option key={tz} value={tz}>{tz}</option>
            ))}
          </select>
        </div>

        <div>
          <Label htmlFor="ev-busy">Shows as</Label>
          <select
            id="ev-busy"
            className={SELECT_CLASS}
            value={busy ? 'busy' : 'free'}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setBusy(e.target.value === 'busy')}
            data-testid="event-editor-busy"
          >
            <option value="busy">Busy</option>
            <option value="free">Free</option>
          </select>
        </div>

        <div>
          <Label htmlFor="ev-location">Location</Label>
          <Input
            id="ev-location"
            value={location}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setLocation(e.target.value)}
            maxLength={500}
            data-testid="event-editor-location"
          />
        </div>

        <div>
          <Label htmlFor="ev-url">Meeting link</Label>
          <Input
            id="ev-url"
            type="url"
            value={meetingUrl}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setMeetingUrl(e.target.value)}
            placeholder="https://…"
            data-testid="event-editor-meeting-url"
          />
        </div>

        <div className="sm:col-span-2">
          <Label htmlFor="ev-desc">Notes (private)</Label>
          <textarea
            id="ev-desc"
            className="w-full rounded-md border border-bh-border bg-bh-surface px-3 py-2 text-sm"
            value={description}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDescription(e.target.value)}
            maxLength={5000}
            rows={2}
            data-testid="event-editor-description"
          />
        </div>
      </div>

      {isCreate && (
        <div className="mt-4 space-y-4">
          <fieldset>
            <legend className="text-sm font-medium">Reminders</legend>
            <div className="mt-2 space-y-2">
              {reminders.map((reminder, index) => (
                <div key={index} className="flex items-center gap-2">
                  <select
                    className={SELECT_CLASS}
                    value={reminder.channel}
                    onChange={(e: React.ChangeEvent<HTMLSelectElement>) => updateReminder(index, { channel: e.target.value as ReminderChannel })}
                    data-testid={`event-editor-reminder-channel-${index}`}
                    aria-label={`Reminder ${index + 1} channel`}
                  >
                    {REMINDER_CHANNELS.map((channel) => (
                      <option key={channel} value={channel}>{channelLabel(channel)}</option>
                    ))}
                  </select>
                  <select
                    className={SELECT_CLASS}
                    value={reminder.offsetMinutes}
                    onChange={(e: React.ChangeEvent<HTMLSelectElement>) => updateReminder(index, { offsetMinutes: Number(e.target.value) })}
                    data-testid={`event-editor-reminder-offset-${index}`}
                    aria-label={`Reminder ${index + 1} timing`}
                  >
                    {REMINDER_OFFSET_MINUTES.map((minutes) => (
                      <option key={minutes} value={minutes}>{offsetLabel(minutes)}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => setReminders((current) => current.filter((_, i) => i !== index))}
                    aria-label={`Remove reminder ${index + 1}`}
                    data-testid={`event-editor-reminder-remove-${index}`}
                  >
                    <Trash2 className="size-4 text-bh-text-muted" aria-hidden />
                  </button>
                </div>
              ))}
            </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="mt-2"
              disabled={reminders.length >= 20}
              onClick={() => setReminders((current) => [...current, { channel: 'in_app', offsetMinutes: 30 }])}
              data-testid="event-editor-add-reminder"
            >
              Add reminder
            </Button>
          </fieldset>

          <fieldset>
            <legend className="text-sm font-medium">Participants</legend>
            <div className="mt-2 space-y-2">
              {participants.map((participant, index) => (
                <div key={index} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto_auto]">
                  <Input
                    value={participant.displayName ?? ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateParticipant(index, { displayName: e.target.value })}
                    placeholder="Name"
                    aria-label={`Participant ${index + 1} name`}
                    data-testid={`event-editor-participant-name-${index}`}
                  />
                  <Input
                    type="email"
                    value={participant.externalEmail ?? ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateParticipant(index, { externalEmail: e.target.value })}
                    placeholder="email@example.com"
                    aria-label={`Participant ${index + 1} email`}
                    data-testid={`event-editor-participant-email-${index}`}
                  />
                  <select
                    className={SELECT_CLASS}
                    value={participant.role}
                    onChange={(e: React.ChangeEvent<HTMLSelectElement>) => updateParticipant(index, { role: e.target.value as ParticipantRole })}
                    data-testid={`event-editor-participant-role-${index}`}
                    aria-label={`Participant ${index + 1} role`}
                  >
                    {EVENT_PARTICIPANT_ROLES.map((role) => (
                      <option key={role} value={role}>{roleLabel(role)}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => setParticipants((current) => current.filter((_, i) => i !== index))}
                    aria-label={`Remove participant ${index + 1}`}
                    data-testid={`event-editor-participant-remove-${index}`}
                  >
                    <Trash2 className="size-4 text-bh-text-muted" aria-hidden />
                  </button>
                </div>
              ))}
            </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="mt-2"
              disabled={participants.length >= 50}
              onClick={() => setParticipants((current) => [...current, { displayName: '', externalEmail: '', role: 'attendee' }])}
              data-testid="event-editor-add-participant"
            >
              Add participant
            </Button>
          </fieldset>

          <fieldset>
            <legend className="text-sm font-medium">Repeat</legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              <select
                className={SELECT_CLASS}
                value={repeat}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setRepeat(e.target.value as RepeatFrequency)}
                data-testid="event-editor-repeat"
                aria-label="Repeat frequency"
              >
                <option value="none">Does not repeat</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
                <option value="yearly">Yearly</option>
              </select>
              {repeat !== 'none' && (
                <>
                  <Input
                    type="number"
                    min={1}
                    max={99}
                    value={interval}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setIntervalValue(e.target.value)}
                    aria-label="Repeat interval"
                    data-testid="event-editor-interval"
                  />
                  <Input
                    type="date"
                    value={until}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setUntil(e.target.value)}
                    aria-label="Repeat until"
                    data-testid="event-editor-until"
                  />
                </>
              )}
            </div>
          </fieldset>
        </div>
      )}

      {!isCreate && isRecurring && (
        <p className="mt-4 text-sm text-bh-text-muted" data-testid="event-editor-series-note">
          This is a recurring event. Changes apply to the whole series.
        </p>
      )}

      {overlapPending && (
        <div className="mt-4 rounded-md border border-bh-warning/40 bg-bh-warning-soft p-3 text-sm" data-testid="event-editor-overlap-warning">
          <p>This time overlaps an existing event.</p>
          <Button type="button" size="sm" className="mt-2" disabled={saving} onClick={() => void runSubmit(true)} data-testid="event-editor-save-anyway">
            Save anyway
          </Button>
        </div>
      )}

      {error && <p className="mt-4 text-sm text-bh-danger" data-testid="event-editor-error">{error}</p>}

      <div className="mt-4 flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel} data-testid="event-editor-cancel">
          Cancel
        </Button>
        <Button type="submit" disabled={saving} data-testid="event-editor-submit">
          {saving && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />}
          {isCreate ? 'Create event' : 'Save changes'}
        </Button>
      </div>
    </form>
  )
}
