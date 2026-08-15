import * as React from 'react'
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { ArrowRight, Check, Loader2, Rss, X } from 'lucide-react'
import { getAppAuthSession } from '~/shared/lib/auth/auth-session'
import { Button, Input, LinkButton } from '~/components/ui'
import {
  INVESTING_THESIS_THEMES,
  composeThesisQuery,
  thesisKeywords,
} from '~/shared/lib/onboarding-shared'
import { saveAndArmThesis, type ArmOutcome } from '~/shared/lib/onboarding-investing'
import { consumePostOnboardingNext } from '~/shared/lib/post-onboarding-next'

/**
 * The investing thesis step (plan: phase-2/03-onboarding-segmentado).
 *
 * ## What this step actually does
 *
 * It collects a light thesis — themes, or anything typed — and turns it into a saved search that is
 * *armed*: an alert on the paid path, a private feed link on the free one. That is the spec's
 * activation for this route ("the first saved search with an alert/radar"), and it is the reason the
 * step exists rather than being the general search step with a different heading.
 *
 * The saving happens here rather than after the results screen for one practical reason: the results
 * screen depends on live external providers, so a route whose only activation lived behind it could
 * not be tested without a test that fails for reasons unrelated to this product. Discovery is still
 * where the person goes next — they land on `onboarding/search` with the thesis prefilled, and can
 * edit the saved search from the dashboard if it turns out to be too narrow.
 *
 * ## What it must not say
 *
 * Not "deal flow", and nothing about rounds, cap tables or companies. The product models people and
 * what they ship; it does not model investment. The limitation is stated on the screen rather than
 * left for somebody to discover, and an e2e asserts both halves — that the honest sentence is there
 * and that the dishonest one is not.
 */
export const Route = createFileRoute('/onboarding/investing')({
  beforeLoad: async () => {
    const user = await getAppAuthSession()
    if (!user.userId) {
      throw redirect({ to: '/auth/sign-in', search: { redirect: '/onboarding/investing' } })
    }
    return { user }
  },
  component: InvestingThesisStep,
})

/** What the product does and does not model, said once and plainly. */
const SCOPE_NOTICE =
  'BuilderHunt tracks people and what they ship. It does not model companies, funding rounds or cap tables.'

function InvestingThesisStep() {
  const navigate = useNavigate()
  const [selected, setSelected] = React.useState<readonly string[]>([])
  const [freeText, setFreeText] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [outcome, setOutcome] = React.useState<ArmOutcome | null>(null)

  const query = composeThesisQuery(selected, freeText)
  const keywords = thesisKeywords(selected, freeText)

  const toggle = (id: string) => {
    setSelected((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    )
  }

  const skip = async () => {
    setSaving(true)
    try {
      await fetch('/api/onboarding/skip', { method: 'POST', credentials: 'include' })
    } catch {
      // Best-effort: the person leaves onboarding either way.
    }
    const next = consumePostOnboardingNext()
    if (next) navigate({ href: next })
    else navigate({ to: '/dashboard' })
  }

  const saveThesis = async () => {
    if (keywords.length === 0) return
    setSaving(true)
    setError(null)

    const result = await saveAndArmThesis({ name: query, keywords })
    if (!result.queryId) {
      setError(result.error ?? 'We could not save that search.')
      setSaving(false)
      return
    }

    /**
     * Ask the server whether this amounts to activation — a request, not an assertion.
     *
     * `saved_search_alert` names the kind being claimed; the server re-counts the rows before
     * recording anything, so a client that lied about arming a search would change nothing.
     */
    await fetch('/api/onboarding/v2', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'activate', activationType: 'saved_search_alert', refId: result.queryId }),
    }).catch(() => {})

    setOutcome(result.outcome)
    setSaving(false)
  }

  if (outcome) {
    return (
      <div className="min-h-[calc(100vh-4rem)] flex items-center justify-center p-6">
        <div className="max-w-2xl w-full text-center" data-testid="investing-armed">
          <div className="w-12 h-12 rounded-full bg-bh-accent-soft flex items-center justify-center mx-auto mb-4">
            <Check className="w-6 h-6 text-bh-accent" aria-hidden="true" />
          </div>
          <h1 className="text-3xl font-bold tracking-tight mb-2">Your thesis is saved</h1>

          {/*
            Three genuinely different sentences, because three genuinely different things happened.
            A single "all set" would claim an alert exists for somebody on the free plan whose search
            is delivered by a feed, and would claim delivery for somebody whose arming failed.
          */}
          {outcome.armed === 'alert' && (
            <p className="text-bh-text-muted mb-6" data-testid="investing-armed-alert">
              We will email you a daily digest when it finds something new.
            </p>
          )}
          {outcome.armed === 'feed' && (
            <div className="mb-6">
              <p className="text-bh-text-muted mb-3" data-testid="investing-armed-feed">
                Email alerts are a Pro feature. Your search runs anyway — this private feed link
                carries its results.
              </p>
              <code className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-bh-surface border border-bh-border text-xs break-all">
                <Rss className="w-3.5 h-3.5 text-bh-accent shrink-0" aria-hidden="true" />
                {outcome.feedUrl}
              </code>
            </div>
          )}
          {outcome.armed === 'none' && (
            <p className="text-bh-text-muted mb-6" data-testid="investing-armed-none">
              The search is saved, but we could not set up delivery: {outcome.reason} You can turn it
              on from Alerts whenever you like.
            </p>
          )}

          <div className="flex items-center justify-center gap-3">
            <Button onClick={() => navigate({ to: '/onboarding/search', search: { q: query } })} data-testid="investing-to-discovery">
              See what it finds
              <ArrowRight className="w-4 h-4" aria-hidden="true" />
            </Button>
            <LinkButton to="/dashboard" variant="ghost" size="sm">
              Go to the dashboard
            </LinkButton>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-[calc(100vh-4rem)] flex items-center justify-center p-6">
      <div className="max-w-2xl w-full">
        <div className="text-center mb-6">
          <p className="text-xs font-semibold uppercase tracking-widest text-bh-text-dim mb-2">
            Your thesis
          </p>
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight mb-2">What are you tracking?</h1>
          <p className="text-bh-text-muted">
            Pick the themes you watch. We will save it as a search and keep it running.
          </p>
        </div>

        <fieldset className="border-0 p-0 m-0 mb-6">
          <legend className="text-xs uppercase tracking-wider text-bh-text-dim mb-2">Themes</legend>
          <div className="flex flex-wrap gap-2" data-testid="investing-themes">
            {INVESTING_THESIS_THEMES.map((theme) => {
              const isOn = selected.includes(theme.id)
              return (
                <button
                  key={theme.id}
                  type="button"
                  aria-pressed={isOn}
                  onClick={() => toggle(theme.id)}
                  data-testid="investing-theme"
                  data-theme-id={theme.id}
                  className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-full border text-sm transition-colors ${
                    isOn
                      ? 'bg-bh-accent-soft border-bh-accent text-bh-accent'
                      : 'bg-bh-surface border-bh-border text-bh-text hover:border-bh-accent'
                  }`}
                >
                  {isOn && <Check className="w-3 h-3" aria-hidden="true" />}
                  {theme.label}
                </button>
              )
            })}
          </div>
        </fieldset>

        <div className="card p-4 mb-4">
          <label htmlFor="investing-free-text" className="text-xs uppercase tracking-wider text-bh-text-dim block mb-2">
            Anything more specific
          </label>
          <Input
            id="investing-free-text"
            type="search"
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            placeholder="e.g. rust database internals, solo founders in Berlin"
            data-testid="investing-free-text"
          />
          {query && (
            <p className="text-xs text-bh-text-dim mt-2" data-testid="investing-preview">
              We will save: <span className="text-bh-text-muted">{query}</span>
            </p>
          )}
        </div>

        <p className="text-sm text-bh-text-muted mb-6" data-testid="investing-scope-notice">
          {SCOPE_NOTICE}
        </p>

        {error && (
          <p role="alert" className="mb-4 text-sm text-bh-danger">
            {error}
          </p>
        )}

        <div className="flex items-center justify-between">
          <LinkButton to="/onboarding/goal" variant="ghost" size="sm">
            ← Back
          </LinkButton>
          <div className="flex items-center gap-3">
            <Button
              onClick={() => void saveThesis()}
              disabled={keywords.length === 0 || saving}
              data-testid="investing-save"
            >
              {saving ? (
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
              ) : (
                <ArrowRight className="w-4 h-4" aria-hidden="true" />
              )}
              Save and start tracking
            </Button>
            <Button onClick={() => void skip()} disabled={saving} variant="ghost" size="sm" data-testid="investing-skip">
              <X className="w-3.5 h-3.5" aria-hidden="true" />
              Skip
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
