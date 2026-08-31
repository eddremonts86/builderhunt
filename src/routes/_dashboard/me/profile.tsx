import * as React from 'react'
import { createFileRoute, notFound } from '@tanstack/react-router'
import { ExternalLink, Loader2, Save } from 'lucide-react'

import { getAppAuthSession } from '~/shared/lib/auth/auth-session'
import { getSelfManagedEnabled } from '~/shared/lib/self-managed/feature-flag'
import { Button } from '~/components/ui/button'
import { Input, Textarea } from '~/components/ui'
import { AttachmentUploader, type OwnerAttachment } from '~/modules/builder-profile/components/AttachmentUploader'
import { SelfManagedChip } from '~/modules/builder-profile/components/SelfManagedProfile'
import {
  SELF_MANAGED_VISIBILITIES,
  type SelfManagedVisibility,
} from '~/shared/lib/self-managed/contracts'
import { SERVICE_TAXONOMY } from '~/shared/lib/self-managed/service-taxonomy'

/**
 * The self-managed profile editor (plan: phase-2/07-perfiles-autogestionados).
 *
 * ## One form, and it sends everything
 *
 * `upsertSelfManagedProfileSchema` is a full replacement, so this form posts every field it renders.
 * A partial patch over a form that shows all of them makes an omitted key ambiguous between
 * "unchanged" and "cleared", and the two get confused exactly once — on the field somebody wanted
 * to clear.
 *
 * ## Visibility is its own control and its own request
 *
 * Publishing is a decision, not a side effect of saving a typo fix. It goes to
 * `PATCH /api/self-managed/visibility`, which is also what stops a stale form from silently
 * reverting a change made in another tab.
 */
interface OwnProfile {
  id: string
  handle: string
  displayName: string
  headline: string | null
  bio: string | null
  locationCity: string | null
  locationCountryCode: string | null
  languages: string[]
  services: string[]
  topics: string[]
  visibility: SelfManagedVisibility
}

export const Route = createFileRoute('/_dashboard/me/profile')({
  beforeLoad: async () => {
    const user = await getAppAuthSession()
    if (!user.userId) throw new Error('Unauthorized')
    // Resolved through the server function, not `env`: `beforeLoad` runs in the browser for a link
    // navigation, where `env.ts` hands back a stub — the editor would open on a click and 404 on a
    // refresh, from one deploy, with the flag on the whole time.
    if (!(await getSelfManagedEnabled())) throw notFound()
    return { user }
  },
  loader: async ({ context }) => context,
  component: SelfManagedProfileEditor,
})

const EMPTY = {
  handle: '',
  displayName: '',
  headline: '',
  bio: '',
  locationCity: '',
  locationCountryCode: '',
  languages: '',
  services: [] as string[],
  topics: '',
}

/** Comma-separated in the form, arrays on the wire — with the blanks dropped, not sent as "". */
function splitList(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean)
}

function SelfManagedProfileEditor() {
  const [profile, setProfile] = React.useState<OwnProfile | null>(null)
  const [attachments, setAttachments] = React.useState<OwnerAttachment[]>([])
  const [form, setForm] = React.useState(EMPTY)
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [message, setMessage] = React.useState<{ ok: boolean; text: string } | null>(null)

  const loadAttachments = React.useCallback(async () => {
    const response = await fetch('/api/self-managed/attachments', { credentials: 'include' })
    setAttachments(response.ok ? (await response.json()).attachments ?? [] : [])
  }, [])

  const load = React.useCallback(async () => {
    try {
      const response = await fetch('/api/self-managed/profile', { credentials: 'include' })
      if (response.status === 404) {
        setProfile(null)
        return
      }
      if (!response.ok) return
      const { profile: own } = await response.json() as { profile: OwnProfile }
      setProfile(own)
      setForm({
        handle: own.handle,
        displayName: own.displayName,
        headline: own.headline ?? '',
        bio: own.bio ?? '',
        locationCity: own.locationCity ?? '',
        locationCountryCode: own.locationCountryCode ?? '',
        languages: own.languages.join(', '),
        services: own.services,
        topics: own.topics.join(', '),
      })
      await loadAttachments()
    } finally {
      setLoading(false)
    }
  }, [loadAttachments])

  React.useEffect(() => { load() }, [load])

  const body = () => ({
    handle: form.handle.trim(),
    displayName: form.displayName.trim(),
    headline: form.headline.trim() || null,
    bio: form.bio.trim() || null,
    locationCity: form.locationCity.trim() || null,
    locationCountryCode: form.locationCountryCode.trim().toUpperCase() || null,
    languages: splitList(form.languages),
    services: form.services,
    topics: splitList(form.topics),
    visibility: profile?.visibility ?? 'draft',
  })

  const save = async () => {
    setSaving(true)
    setMessage(null)
    try {
      const response = profile
        ? await fetch(`/api/self-managed/profile/${profile.id}`, {
            method: 'PATCH',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body()),
          })
        : await fetch('/api/self-managed/profile', {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body()),
          })

      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        setMessage({ ok: false, text: refusalText(payload.error) })
        return
      }
      setProfile(payload.profile)
      setMessage({ ok: true, text: 'Saved.' })
      await loadAttachments()
    } catch {
      setMessage({ ok: false, text: 'Something went wrong. Try again.' })
    } finally {
      setSaving(false)
    }
  }

  const changeVisibility = async (visibility: SelfManagedVisibility) => {
    const response = await fetch('/api/self-managed/visibility', {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visibility }),
    })
    if (response.ok) setProfile((await response.json()).profile)
  }

  const toggleService = (id: string) => {
    setForm((current) => ({
      ...current,
      services: current.services.includes(id)
        ? current.services.filter((service) => service !== id)
        : [...current.services, id],
    }))
  }

  if (loading) {
    return (
      <div className="container py-10">
        <Loader2 className="h-5 w-5 animate-spin text-bh-text-muted" aria-hidden="true" />
        <span className="sr-only">Loading your profile</span>
      </div>
    )
  }

  return (
    <div className="container max-w-3xl py-10" data-testid="self-managed-editor">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold tracking-tight text-bh-text">Your profile</h1>
        <SelfManagedChip />
      </div>
      <p className="mt-2 text-sm text-bh-text-muted">
        A profile you write yourself — no GitHub account required. Everything on it is shown as
        declared by you, never as verified.
      </p>

      <section aria-labelledby="details-heading" className="mt-8 rounded-2xl border border-bh-border bg-bh-surface p-6">
        <h2 id="details-heading" className="text-lg font-semibold text-bh-text">Details</h2>

        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="profile-handle" className="block text-sm font-medium text-bh-text">Handle</label>
            <Input
              id="profile-handle"
              value={form.handle}
              onChange={(event) => setForm({ ...form, handle: event.target.value })}
              placeholder="ada-lovelace"
              className="mt-1"
            />
            <p className="mt-1 text-xs text-bh-text-muted">Your page lives at /u/{form.handle || 'your-handle'}</p>
          </div>
          <div>
            <label htmlFor="profile-name" className="block text-sm font-medium text-bh-text">Display name</label>
            <Input
              id="profile-name"
              value={form.displayName}
              onChange={(event) => setForm({ ...form, displayName: event.target.value })}
              className="mt-1"
            />
          </div>
        </div>

        <div className="mt-4">
          <label htmlFor="profile-headline" className="block text-sm font-medium text-bh-text">Headline</label>
          <Input
            id="profile-headline"
            value={form.headline}
            onChange={(event) => setForm({ ...form, headline: event.target.value })}
            placeholder="Technical translator, es↔en"
            className="mt-1"
          />
        </div>

        <div className="mt-4">
          <label htmlFor="profile-bio" className="block text-sm font-medium text-bh-text">Bio</label>
          <Textarea
            id="profile-bio"
            value={form.bio}
            onChange={(event) => setForm({ ...form, bio: event.target.value })}
            rows={5}
            className="mt-1"
          />
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="profile-city" className="block text-sm font-medium text-bh-text">City</label>
            <Input
              id="profile-city"
              value={form.locationCity}
              onChange={(event) => setForm({ ...form, locationCity: event.target.value })}
              className="mt-1"
            />
          </div>
          <div>
            <label htmlFor="profile-country" className="block text-sm font-medium text-bh-text">Country code</label>
            <Input
              id="profile-country"
              value={form.locationCountryCode}
              onChange={(event) => setForm({ ...form, locationCountryCode: event.target.value })}
              placeholder="ES"
              maxLength={2}
              className="mt-1"
            />
          </div>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="profile-languages" className="block text-sm font-medium text-bh-text">Languages</label>
            <Input
              id="profile-languages"
              value={form.languages}
              onChange={(event) => setForm({ ...form, languages: event.target.value })}
              placeholder="es, en, fr"
              className="mt-1"
            />
          </div>
          <div>
            <label htmlFor="profile-topics" className="block text-sm font-medium text-bh-text">Topics</label>
            <Input
              id="profile-topics"
              value={form.topics}
              onChange={(event) => setForm({ ...form, topics: event.target.value })}
              placeholder="localization, docs"
              className="mt-1"
            />
          </div>
        </div>

        <fieldset className="mt-5">
          <legend className="text-sm font-medium text-bh-text">Services</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {SERVICE_TAXONOMY.map((service) => {
              const selected = form.services.includes(service.id)
              return (
                <button
                  key={service.id}
                  type="button"
                  onClick={() => toggleService(service.id)}
                  aria-pressed={selected}
                  className={`rounded-full border px-3 py-1 text-sm ${
                    selected
                      ? 'border-bh-accent bg-bh-accent-soft text-bh-text'
                      : 'border-bh-border bg-bh-surface text-bh-text-muted'
                  }`}
                >
                  {service.label}
                </button>
              )
            })}
          </div>
        </fieldset>

        <Button type="button" onClick={save} disabled={saving} className="mt-6" data-testid="profile-save">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Save className="h-4 w-4" aria-hidden="true" />}
          {profile ? 'Save changes' : 'Create profile'}
        </Button>

        <p role="status" aria-live="polite" className="mt-2 text-sm text-bh-text-muted" data-testid="profile-message">
          {message?.text ?? ''}
        </p>
      </section>

      {profile && (
        <>
          <section aria-labelledby="visibility-heading" className="mt-6 rounded-2xl border border-bh-border bg-bh-surface p-6">
            <h2 id="visibility-heading" className="text-lg font-semibold text-bh-text">Who can see it</h2>
            <div className="mt-3 flex flex-wrap gap-2" role="group" aria-labelledby="visibility-heading">
              {SELF_MANAGED_VISIBILITIES.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => changeVisibility(option)}
                  aria-pressed={profile.visibility === option}
                  data-testid={`visibility-${option}`}
                  className={`rounded-full border px-3 py-1 text-sm ${
                    profile.visibility === option
                      ? 'border-bh-accent bg-bh-accent-soft text-bh-text'
                      : 'border-bh-border bg-bh-surface text-bh-text-muted'
                  }`}
                >
                  {option}
                </button>
              ))}
            </div>
            <p className="mt-3 text-sm text-bh-text-muted">
              {profile.visibility === 'public' && 'Listed in search and readable by anyone.'}
              {profile.visibility === 'unlisted' && 'Readable by anyone holding the link, and kept out of search.'}
              {profile.visibility === 'draft' && 'Only you can see it.'}
            </p>
            {profile.visibility !== 'draft' && (
              <a
                href={`/u/${profile.handle}`}
                className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-bh-accent"
                data-testid="view-public-profile"
              >
                View your public page
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
            )}
          </section>

          <div className="mt-6">
            <AttachmentUploader attachments={attachments} onChanged={loadAttachments} />
          </div>
        </>
      )}
    </div>
  )
}

/** The route refusals, as sentences somebody can act on. */
function refusalText(code: unknown): string {
  switch (code) {
    case 'handle-taken': return 'That handle is taken. Try another.'
    case 'already-exists': return 'You already have a profile.'
    case 'not-found': return 'That profile no longer exists.'
    case 'invalid-transition': return 'That visibility change is not allowed.'
    default: return typeof code === 'string' && code ? code : 'That change was refused.'
  }
}
