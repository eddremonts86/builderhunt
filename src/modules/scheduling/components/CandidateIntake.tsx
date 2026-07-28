import { useCallback, useState } from 'react'
import { ExternalLink, Globe, Loader2, ShieldCheck } from 'lucide-react'
import { Button, Checkbox, Label } from '~/components/ui'
import { DocumentUploader, type CandidateDocumentView } from './DocumentUploader'

/**
 * The candidate's documents and links (plan: calendar-scheduling-interview-intelligence, Phase 6
 * "Add candidate links and intake UI").
 *
 * ## A blocked platform gets an explanation, not a disabled button
 *
 * LinkedIn, X, Facebook and Instagram stay URL-only, and the copy says why: their terms, not the
 * candidate's choice. A greyed-out "Import" with no reason reads as either a bug or a judgement about
 * them, and both make people try again. The link is still kept and still shown to the organizer — it
 * is evidence someone can open, just not something we fetch.
 *
 * ## The attestation is per host, unticked, and separate from consent
 *
 * `public_web_import` consent (collected with the other purposes) says imports are acceptable *in
 * principle*. This checkbox says *this specific site is mine to offer*. They are different claims and
 * neither substitutes for the other, which is why this is a second control rather than a reuse of the
 * first. It starts unticked and there is no bulk setter — spec.md requires "a separate, unticked,
 * versioned consent", and a "select all" would defeat exactly what that sentence protects.
 *
 * The version the candidate saw is sent with the request and rejected by the server if it is stale,
 * so an attestation is never recorded against text nobody displayed.
 */

export type LinkImportState = 'not_requested' | 'queued' | 'running' | 'succeeded' | 'failed' | 'not_importable'
export type LinkPolicyDecision = 'official_api' | 'authorized_crawl' | 'user_submitted' | 'not_importable'

export interface CandidateLinkView {
  id: string
  url: string
  policyDecision: LinkPolicyDecision
  importState: LinkImportState
  /** Set once the candidate has attested; used to keep the box ticked on a return visit. */
  attested: boolean
}

const IMPORT_STATE_COPY: Readonly<Record<LinkImportState, string>> = {
  not_requested: 'Not imported',
  queued: 'Queued for import',
  running: 'Importing now',
  succeeded: 'Imported',
  failed: 'Import failed — you can ask again',
  not_importable: 'Kept as a link only',
}

export interface CandidateIntakeProps {
  invitationId: string
  attestationVersion: string
  documents: readonly CandidateDocumentView[]
  links: readonly CandidateLinkView[]
  onChanged: () => void
  disabled?: boolean
}

/**
 * Whether we may fetch this host at all, from the server's own decision. Never inferred from the URL
 * here — the client re-deriving the policy would be a second, divergent implementation of the one
 * rule that must not have two implementations.
 */
function isFetchable(decision: LinkPolicyDecision): boolean {
  return decision === 'official_api' || decision === 'authorized_crawl'
}

export function CandidateIntake({
  invitationId,
  attestationVersion,
  documents,
  links,
  onChanged,
  disabled = false,
}: CandidateIntakeProps) {
  // One entry per link. No bulk setter anywhere in this file, deliberately.
  const [attested, setAttested] = useState<Record<string, boolean>>({})
  const [pendingLinkId, setPendingLinkId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const requestImport = useCallback(async (linkId: string) => {
    setError(null)
    setPendingLinkId(linkId)
    try {
      const response = await fetch(`/api/public/scheduling/${invitationId}/links/${linkId}/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ attestationVersion }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        setError(body?.reason === 'attestation_notice_outdated'
          // The page was open while the notice changed. Reloading is the honest fix: the candidate must
          // see the current text before attesting to it.
          ? 'This page is out of date. Please reload and confirm again.'
          : 'We could not request that import. Please try again.')
      }
      onChanged()
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setPendingLinkId(null)
    }
  }, [attestationVersion, invitationId, onChanged])

  return (
    <div className="space-y-6">
      <DocumentUploader
        invitationId={invitationId}
        documents={documents}
        onChanged={onChanged}
        disabled={disabled}
      />

      {links.length > 0 && (
        <section aria-labelledby="links-heading" className="space-y-3">
          <h3 id="links-heading" className="text-sm font-medium">Your links</h3>

          <ul className="space-y-3">
            {links.map((link) => {
              const fetchable = isFetchable(link.policyDecision)
              const alreadyRequested = link.importState !== 'not_requested' && link.importState !== 'failed'
              const isAttested = attested[link.id] ?? link.attested

              return (
                <li key={link.id} className="space-y-2 rounded-md border p-3 text-sm">
                  <div className="flex items-start gap-2">
                    <Globe aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <a
                        href={link.url}
                        // A candidate-supplied URL. `noopener`/`noreferrer` because the destination
                        // must learn nothing about the page it was opened from — that page names one
                        // person interviewing at one company.
                        target="_blank"
                        rel="noopener noreferrer nofollow"
                        className="inline-flex items-center gap-1 truncate underline"
                      >
                        <span className="truncate">{link.url}</span>
                        <ExternalLink aria-hidden className="size-3 shrink-0" />
                      </a>
                      <p role="status" className="text-muted-foreground text-xs">
                        {IMPORT_STATE_COPY[link.importState]}
                      </p>
                    </div>
                  </div>

                  {!fetchable && (
                    <p className="text-muted-foreground text-xs">
                      {/* Named as the platform's restriction, because it is. */}
                      This site’s own terms do not allow us to read it automatically, so we will keep it
                      as a link for the interviewer to open. Your permission cannot change that.
                    </p>
                  )}

                  {fetchable && !alreadyRequested && (
                    <div className="space-y-2">
                      <div className="flex items-start gap-2">
                        <Checkbox
                          id={`attest-${link.id}`}
                          checked={isAttested}
                          disabled={disabled || pendingLinkId === link.id}
                          onCheckedChange={(checked) =>
                            setAttested((previous) => ({ ...previous, [link.id]: checked === true }))}
                        />
                        <Label htmlFor={`attest-${link.id}`} className="text-xs leading-snug font-normal">
                          I own this website, or I am authorised to submit it, and I am asking
                          BuilderHunt to read its public pages for this interview.
                        </Label>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        disabled={disabled || !isAttested || pendingLinkId === link.id}
                        onClick={() => void requestImport(link.id)}
                      >
                        {pendingLinkId === link.id
                          ? <><Loader2 aria-hidden className="mr-2 size-3 animate-spin" />Requesting…</>
                          : <><ShieldCheck aria-hidden className="mr-2 size-3" />Import this site</>}
                      </Button>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>

          {error !== null && (
            <p role="alert" className="text-destructive text-xs">{error}</p>
          )}
        </section>
      )}
    </div>
  )
}
