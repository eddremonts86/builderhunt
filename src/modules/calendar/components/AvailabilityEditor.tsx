import { useEffect, useState } from 'react'
import { Loader2, Trash2 } from 'lucide-react'
import { Button, Input, Label } from '~/components/ui'
import { REMINDER_CHANNELS, REMINDER_OFFSET_MINUTES } from '~/shared/lib/calendar'
import type { AvailabilityOverrideKind } from '~/shared/lib/scheduling'

/**
 * Availability + default-reminder settings editor (plans/UI Wave 3 "Build availability and
 * default-reminder settings").
 *
 * The whole policy is one optimistic-versioned document server-side (`PUT /api/calendar/availability`):
 * overlaps and rule/override interaction are cross-row properties, so the server validates the set
 * as a whole and either merges compatible-but-overlapping windows (returning the normalized rules)
 * or rejects conflicting ones with a readable `invalid_input` message. This editor mirrors that: it
 * re-renders from every saved response (so a merge is reflected without a reload) and surfaces the
 * server's conflict message verbatim rather than inventing its own.
 *
 * Overrides use the dedicated single-override endpoints (`POST/DELETE
 * /api/calendar/availability/overrides`) so a blocked/custom day is added or removed atomically
 * under the current version without re-submitting the entire weekly grid. Each response carries the
 * bumped version, which we adopt so the next mutation is not a stale write.
 *
 * A single IANA timezone applies to every rule and override: availability is authored in the
 * owner's own zone and the server resolves DST boundaries (nonexistent/ambiguous local times) at
 * slot-generation time, not here — the policy only stores local `HH:MM` + timezone.
 *
 * Every control is a native element (no Radix Select/portal) so the whole surface is reachable in a
 * plain jsdom harness, matching `EventEditor`.
 */

type ReminderChannel = (typeof REMINDER_CHANNELS)[number]
type OverrideKind = AvailabilityOverrideKind

/**
 * Client-safe local copy of `AVAILABILITY_OVERRIDE_KINDS`. `~/shared/lib/scheduling` is a server
 * module (`node:crypto` + `@js-temporal/polyfill` + CommonJS `rrule`); importing its VALUES into
 * this browser component pulled `node:crypto` into the calendar client bundle and broke hydration —
 * the whole app root mounted twice. The type-only import above is erased at build, so `satisfies`
 * plus `OVERRIDE_KIND_LABELS: Record<OverrideKind, string>` still guard drift without shipping it.
 */
const AVAILABILITY_OVERRIDE_KINDS = ['available', 'blocked'] as const satisfies readonly AvailabilityOverrideKind[]

export interface AvailabilityRuleValue {
  timeZone: string
  weekdays: number[]
  localStart: string
  localEnd: string
  slotMinutes: number
  bufferBeforeMinutes: number
  bufferAfterMinutes: number
  minNoticeMinutes: number
  horizonDays: number
  enabled: boolean
}

export interface AvailabilityOverrideValue {
  localDate: string
  localStart: string | null
  localEnd: string | null
  kind: OverrideKind
  timeZone: string
}

export interface AvailabilityPolicyValue {
  rules: AvailabilityRuleValue[]
  overrides: AvailabilityOverrideValue[]
  defaultReminderOffsets: number[]
  defaultReminderChannels: ReminderChannel[]
  version: number
}

export interface AvailabilityPutBody {
  version: number
  rules: AvailabilityRuleValue[]
  overrides: AvailabilityOverrideValue[]
  defaultReminderOffsets: number[]
  defaultReminderChannels: ReminderChannel[]
}

export interface AvailabilityMutationResult {
  ok: boolean
  error?: string
  message?: string
  policy?: AvailabilityPolicyValue
}

export interface AvailabilityEditorProps {
  defaultTimezone: string
  timezoneOptions?: string[]
  /** Injected in tests; default implementations hit the real endpoints. */
  loadPolicy?: () => Promise<AvailabilityPolicyValue>
  savePolicy?: (body: AvailabilityPutBody) => Promise<AvailabilityMutationResult>
  createOverride?: (version: number, override: AvailabilityOverrideValue) => Promise<AvailabilityMutationResult>
  deleteOverride?: (version: number, localDate: string) => Promise<AvailabilityMutationResult>
  onClose?: () => void
}

const SELECT_CLASS = 'h-9 w-full rounded-md border border-bh-border bg-bh-surface px-3 text-sm'

// Displayed Monday-first; `value` is the server's weekday index (0=Sunday..6=Saturday).
const WEEKDAYS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 0, label: 'Sun' },
]

function channelLabel(channel: ReminderChannel): string {
  return channel === 'email' ? 'Email' : 'In-app'
}

const OVERRIDE_KIND_LABELS: Record<OverrideKind, string> = {
  available: 'Custom hours',
  blocked: 'Blocked (day off)',
}

function offsetLabel(minutes: number): string {
  if (minutes === 0) return 'At start'
  if (minutes % 1440 === 0) return `${minutes / 1440}d before`
  if (minutes % 60 === 0) return `${minutes / 60}h before`
  return `${minutes}m before`
}

function newRule(timeZone: string): AvailabilityRuleValue {
  return {
    timeZone,
    weekdays: [1, 2, 3, 4, 5],
    localStart: '09:00',
    localEnd: '17:00',
    slotMinutes: 30,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minNoticeMinutes: 60,
    horizonDays: 30,
    enabled: true,
  }
}

function messageForError(result: AvailabilityMutationResult): string {
  switch (result.error) {
    case 'state_changed':
      return 'Your availability changed since you opened it. Reload to see the latest, then re-apply your changes.'
    case 'forbidden':
      return 'You do not have permission to change availability.'
    case 'dependency_unavailable':
      return 'Scheduling is temporarily unavailable. Try again in a moment.'
    case 'invalid_input':
      // The server authors this message and it names only the caller's own windows — e.g. two
      // windows overlapping on the same day with different slot settings. Prefer it so a conflict
      // is explained, not just flagged.
      return result.message ?? 'Some availability values are invalid. Check your windows and try again.'
    default:
      return result.message ?? 'We could not save your availability. Try again.'
  }
}

// ── Default endpoint handlers (overridden in tests) ──────────────────────────────────────────────

async function readMutation(response: Response): Promise<AvailabilityMutationResult> {
  if (response.ok) {
    const policy = (await response.json()) as AvailabilityPolicyValue
    return { ok: true, policy }
  }
  const payload = await response.json().catch(() => ({}))
  return { ok: false, error: String(payload.error ?? 'invalid_input'), message: payload.message ? String(payload.message) : undefined }
}

async function defaultLoadPolicy(): Promise<AvailabilityPolicyValue> {
  const response = await fetch('/api/calendar/availability')
  if (!response.ok) throw new Error('load_failed')
  return (await response.json()) as AvailabilityPolicyValue
}

async function defaultSavePolicy(body: AvailabilityPutBody): Promise<AvailabilityMutationResult> {
  const response = await fetch('/api/calendar/availability', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return readMutation(response)
}

async function defaultCreateOverride(version: number, override: AvailabilityOverrideValue): Promise<AvailabilityMutationResult> {
  const response = await fetch('/api/calendar/availability/overrides', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version, override }),
  })
  return readMutation(response)
}

async function defaultDeleteOverride(version: number, localDate: string): Promise<AvailabilityMutationResult> {
  const response = await fetch('/api/calendar/availability/overrides', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version, localDate }),
  })
  return readMutation(response)
}

export function AvailabilityEditor({
  defaultTimezone,
  timezoneOptions,
  loadPolicy = defaultLoadPolicy,
  savePolicy = defaultSavePolicy,
  createOverride = defaultCreateOverride,
  deleteOverride = defaultDeleteOverride,
  onClose,
}: AvailabilityEditorProps) {
  const [version, setVersion] = useState(1)
  const [timezone, setTimezone] = useState(defaultTimezone)
  const [rules, setRules] = useState<AvailabilityRuleValue[]>([])
  const [reminderOffsets, setReminderOffsets] = useState<number[]>([])
  const [reminderChannels, setReminderChannels] = useState<ReminderChannel[]>([])

  const [overrideDate, setOverrideDate] = useState('')
  const [overrideKind, setOverrideKind] = useState<OverrideKind>('blocked')
  const [overrideStart, setOverrideStart] = useState('09:00')
  const [overrideEnd, setOverrideEnd] = useState('17:00')

  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  const [overrides, setOverrides] = useState<AvailabilityOverrideValue[]>([])

  function adopt(policy: AvailabilityPolicyValue) {
    setVersion(policy.version)
    setRules(policy.rules)
    setOverrides(policy.overrides)
    setReminderOffsets(policy.defaultReminderOffsets)
    setReminderChannels(policy.defaultReminderChannels)
    if (policy.rules[0]?.timeZone) setTimezone(policy.rules[0].timeZone)
  }

  function reload() {
    setLoading(true)
    setLoadFailed(false)
    setError(null)
    void loadPolicy()
      .then((policy) => adopt(policy))
      .catch(() => setLoadFailed(true))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    let cancelled = false
    loadPolicy()
      .then((policy) => {
        if (cancelled) return
        adopt(policy)
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // Load once on mount; injected handlers are stable for a given render tree.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const timezones = timezoneOptions && timezoneOptions.length > 0 ? timezoneOptions : [timezone]

  function updateRule(index: number, patch: Partial<AvailabilityRuleValue>) {
    setRules((current) => current.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)))
  }

  function toggleWeekday(index: number, weekday: number) {
    setRules((current) => current.map((rule, i) => {
      if (i !== index) return rule
      const has = rule.weekdays.includes(weekday)
      return { ...rule, weekdays: has ? rule.weekdays.filter((day) => day !== weekday) : [...rule.weekdays, weekday].sort((a, b) => a - b) }
    }))
  }

  function toggleOffset(minutes: number) {
    setReminderOffsets((current) => (current.includes(minutes) ? current.filter((entry) => entry !== minutes) : [...current, minutes].sort((a, b) => a - b)))
  }

  function toggleChannel(channel: ReminderChannel) {
    setReminderChannels((current) => (current.includes(channel) ? current.filter((entry) => entry !== channel) : [...current, channel]))
  }

  async function handleSave(formEvent: React.FormEvent) {
    formEvent.preventDefault()
    setSaving(true)
    setError(null)
    setSavedAt(null)
    try {
      // One timezone for the whole policy: availability is authored in the owner's own zone.
      const body: AvailabilityPutBody = {
        version,
        rules: rules.map((rule) => ({ ...rule, timeZone: timezone })),
        overrides: overrides.map((override) => ({ ...override, timeZone: timezone })),
        defaultReminderOffsets: reminderOffsets,
        defaultReminderChannels: reminderChannels,
      }
      const result = await savePolicy(body)
      if (result.ok && result.policy) {
        adopt(result.policy)
        setSavedAt(Date.now())
        return
      }
      setError(messageForError(result))
    } finally {
      setSaving(false)
    }
  }

  async function handleAddOverride() {
    if (!overrideDate) {
      setError('Pick a date for the override.')
      return
    }
    setBusy(true)
    setError(null)
    setSavedAt(null)
    try {
      const override: AvailabilityOverrideValue = overrideKind === 'blocked'
        ? { localDate: overrideDate, localStart: null, localEnd: null, kind: 'blocked', timeZone: timezone }
        : { localDate: overrideDate, localStart: overrideStart, localEnd: overrideEnd, kind: 'available', timeZone: timezone }
      const result = await createOverride(version, override)
      if (result.ok && result.policy) {
        adopt(result.policy)
        setOverrideDate('')
        return
      }
      setError(messageForError(result))
    } finally {
      setBusy(false)
    }
  }

  async function handleRemoveOverride(localDate: string) {
    setBusy(true)
    setError(null)
    setSavedAt(null)
    try {
      const result = await deleteOverride(version, localDate)
      if (result.ok && result.policy) {
        adopt(result.policy)
        return
      }
      setError(messageForError(result))
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <div className="mb-6 flex items-center gap-2 rounded-xl border border-bh-border bg-bh-surface p-4 text-sm text-bh-text-muted" data-testid="availability-loading">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Loading your availability…
      </div>
    )
  }

  if (loadFailed) {
    return (
      <div className="mb-6 rounded-xl border border-bh-border bg-bh-surface p-4" data-testid="availability-editor">
        <p className="text-sm text-bh-danger" data-testid="availability-error">We could not load your availability. Try again.</p>
        <div className="mt-3 flex gap-2">
          <Button variant="secondary" size="sm" onClick={reload} data-testid="availability-reload">Reload</Button>
          {onClose && <Button variant="secondary" size="sm" onClick={onClose} data-testid="availability-close">Close</Button>}
        </div>
      </div>
    )
  }

  return (
    <form onSubmit={handleSave} className="mb-6 rounded-xl border border-bh-border bg-bh-surface p-4" data-testid="availability-editor">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Availability</h2>
        <div className="flex items-center gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={reload} data-testid="availability-reload">Reload</Button>
          {onClose && <Button type="button" variant="secondary" size="sm" onClick={onClose} data-testid="availability-close">Close</Button>}
        </div>
      </div>

      <div className="mb-4 max-w-xs">
        <Label htmlFor="av-tz">Timezone</Label>
        <select
          id="av-tz"
          className={`${SELECT_CLASS} truncate`}
          value={timezone}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setTimezone(e.target.value)}
          data-testid="availability-timezone"
        >
          {timezones.map((tz) => (
            <option key={tz} value={tz}>{tz}</option>
          ))}
        </select>
      </div>

      <section className="mb-5">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-medium text-bh-text">Weekly windows</h3>
          <Button type="button" variant="secondary" size="sm" onClick={() => setRules((current) => [...current, newRule(timezone)])} data-testid="availability-add-rule">
            Add window
          </Button>
        </div>

        {rules.length === 0 && (
          <p className="text-sm text-bh-text-muted" data-testid="availability-rules-empty">No weekly windows yet. Add one so people can book you.</p>
        )}

        <div className="space-y-3">
          {rules.map((rule, index) => (
            <div key={index} className="rounded-lg border border-bh-border p-3" data-testid={`availability-rule-${index}`}>
              <div className="mb-2 flex flex-wrap gap-2">
                {WEEKDAYS.map((weekday) => (
                  <label key={weekday.value} className="flex items-center gap-1 text-xs">
                    <input
                      type="checkbox"
                      checked={rule.weekdays.includes(weekday.value)}
                      onChange={() => toggleWeekday(index, weekday.value)}
                      data-testid={`availability-rule-weekday-${index}-${weekday.value}`}
                    />
                    {weekday.label}
                  </label>
                ))}
              </div>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <Label htmlFor={`av-start-${index}`}>Start</Label>
                  <Input id={`av-start-${index}`} type="time" value={rule.localStart} onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateRule(index, { localStart: e.target.value })} data-testid={`availability-rule-start-${index}`} />
                </div>
                <div>
                  <Label htmlFor={`av-end-${index}`}>End</Label>
                  <Input id={`av-end-${index}`} type="time" value={rule.localEnd} onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateRule(index, { localEnd: e.target.value })} data-testid={`availability-rule-end-${index}`} />
                </div>
                <div>
                  <Label htmlFor={`av-slot-${index}`}>Slot (min)</Label>
                  <Input id={`av-slot-${index}`} type="number" min={1} value={rule.slotMinutes} onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateRule(index, { slotMinutes: Number(e.target.value) })} data-testid={`availability-rule-slot-${index}`} />
                </div>
                <div>
                  <Label htmlFor={`av-notice-${index}`}>Min notice (min)</Label>
                  <Input id={`av-notice-${index}`} type="number" min={0} value={rule.minNoticeMinutes} onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateRule(index, { minNoticeMinutes: Number(e.target.value) })} data-testid={`availability-rule-notice-${index}`} />
                </div>
                <div>
                  <Label htmlFor={`av-buffer-before-${index}`}>Buffer before (min)</Label>
                  <Input id={`av-buffer-before-${index}`} type="number" min={0} value={rule.bufferBeforeMinutes} onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateRule(index, { bufferBeforeMinutes: Number(e.target.value) })} data-testid={`availability-rule-buffer-before-${index}`} />
                </div>
                <div>
                  <Label htmlFor={`av-buffer-after-${index}`}>Buffer after (min)</Label>
                  <Input id={`av-buffer-after-${index}`} type="number" min={0} value={rule.bufferAfterMinutes} onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateRule(index, { bufferAfterMinutes: Number(e.target.value) })} data-testid={`availability-rule-buffer-after-${index}`} />
                </div>
                <div>
                  <Label htmlFor={`av-horizon-${index}`}>Booking horizon (days)</Label>
                  <Input id={`av-horizon-${index}`} type="number" min={1} value={rule.horizonDays} onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateRule(index, { horizonDays: Number(e.target.value) })} data-testid={`availability-rule-horizon-${index}`} />
                </div>
                <div className="flex items-end justify-between gap-2">
                  <label className="flex items-center gap-1 text-sm">
                    <input type="checkbox" checked={rule.enabled} onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateRule(index, { enabled: e.target.checked })} data-testid={`availability-rule-enabled-${index}`} />
                    Enabled
                  </label>
                  <button type="button" aria-label="Remove window" onClick={() => setRules((current) => current.filter((_, i) => i !== index))} data-testid={`availability-rule-remove-${index}`}>
                    <Trash2 className="size-4 text-bh-text-muted" aria-hidden />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="mb-5">
        <h3 className="mb-2 text-sm font-medium text-bh-text">Default reminders</h3>
        <div className="mb-2 flex flex-wrap gap-3">
          {REMINDER_CHANNELS.map((channel) => (
            <label key={channel} className="flex items-center gap-1 text-sm">
              <input type="checkbox" checked={reminderChannels.includes(channel)} onChange={() => toggleChannel(channel)} data-testid={`availability-reminder-channel-${channel}`} />
              {channelLabel(channel)}
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {REMINDER_OFFSET_MINUTES.map((minutes) => (
            <label key={minutes} className="flex items-center gap-1 rounded-md border border-bh-border px-2 py-1 text-xs">
              <input type="checkbox" checked={reminderOffsets.includes(minutes)} onChange={() => toggleOffset(minutes)} data-testid={`availability-reminder-offset-${minutes}`} />
              {offsetLabel(minutes)}
            </label>
          ))}
        </div>
      </section>

      <section className="mb-5">
        <h3 className="mb-2 text-sm font-medium text-bh-text">Date overrides</h3>

        {overrides.length === 0 && (
          <p className="mb-2 text-sm text-bh-text-muted" data-testid="availability-overrides-empty">No date overrides. Add one to block a day or set custom hours.</p>
        )}

        <ul className="mb-3 space-y-1">
          {overrides.map((override, index) => (
            <li key={override.localDate} className="flex items-center justify-between rounded-md border border-bh-border px-3 py-1.5 text-sm" data-testid={`availability-override-${index}`}>
              <span>
                {override.localDate} — {override.kind === 'blocked' ? 'Blocked' : `${override.localStart}–${override.localEnd}`}
              </span>
              <button type="button" aria-label={`Remove override for ${override.localDate}`} disabled={busy} onClick={() => handleRemoveOverride(override.localDate)} data-testid={`availability-override-remove-${index}`}>
                <Trash2 className="size-4 text-bh-text-muted" aria-hidden />
              </button>
            </li>
          ))}
        </ul>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <Label htmlFor="av-ov-date">Date</Label>
            <Input id="av-ov-date" type="date" value={overrideDate} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setOverrideDate(e.target.value)} data-testid="availability-override-date" />
          </div>
          <div>
            <Label htmlFor="av-ov-kind">Kind</Label>
            <select id="av-ov-kind" className={SELECT_CLASS} value={overrideKind} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setOverrideKind(e.target.value as OverrideKind)} data-testid="availability-override-kind">
              {AVAILABILITY_OVERRIDE_KINDS.map((kind) => (
                <option key={kind} value={kind}>{OVERRIDE_KIND_LABELS[kind]}</option>
              ))}
            </select>
          </div>
          {overrideKind === 'available' && (
            <>
              <div>
                <Label htmlFor="av-ov-start">Start</Label>
                <Input id="av-ov-start" type="time" value={overrideStart} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setOverrideStart(e.target.value)} data-testid="availability-override-start" />
              </div>
              <div>
                <Label htmlFor="av-ov-end">End</Label>
                <Input id="av-ov-end" type="time" value={overrideEnd} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setOverrideEnd(e.target.value)} data-testid="availability-override-end" />
              </div>
            </>
          )}
          <div className="flex items-end">
            <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={handleAddOverride} data-testid="availability-override-add">Add override</Button>
          </div>
        </div>
      </section>

      {error && <p className="mb-3 text-sm text-bh-danger" data-testid="availability-error">{error}</p>}
      {savedAt !== null && !error && <p className="mb-3 text-sm text-bh-success" data-testid="availability-saved">Availability saved.</p>}

      <div className="flex gap-2">
        <Button type="submit" disabled={saving} data-testid="availability-save">
          {saving && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />}
          Save availability
        </Button>
      </div>
    </form>
  )
}
