import { useState } from 'react'
import { ExternalLink, FileText, Globe, Link2, X } from 'lucide-react'
import { Button } from '~/components/ui'

/**
 * The evidence behind a brief's citations (plan:
 * calendar-scheduling-interview-intelligence, Phase 8).
 *
 * ## A citation you cannot open is a citation you have to take on trust
 *
 * The whole reason the brief's schema forces every claim to cite a source id is so a reader can check it.
 * That only pays off if the ids are reachable, which is what this is for: click `[doc:…]` in a claim, land
 * on the text it came from.
 *
 * ## Extracted text, rendered as text
 *
 * Sources carry plain text — the extractors strip markup precisely so nothing here has to sanitize it —
 * and it is rendered inside `<pre>` with `whiteSpace: pre-wrap`. Never `dangerouslySetInnerHTML`, not
 * because the text is untrusted markup (it is not markup at all) but because a component that *can*
 * render candidate-supplied HTML will eventually be handed some.
 *
 * ## A restricted link shows why, not a broken preview
 *
 * `submitted_link` sources have no text by construction. Showing an empty panel would read as a loading
 * failure; the copy says the platform's terms are the reason and offers the link.
 */

export type EvidenceKind = 'document' | 'approved_web' | 'public_profile' | 'submitted_link'

export interface EvidenceSource {
  id: string
  kind: EvidenceKind
  label: string
  text?: string
  location?: { page?: number; section?: string; url?: string }
}

export interface EvidenceDrawerProps {
  sources: readonly EvidenceSource[]
  /** The id to open on mount, when a reader clicked a citation. */
  openSourceId?: string | null
  onClose?: () => void
}

const KIND_ICON: Record<EvidenceKind, typeof FileText> = {
  document: FileText,
  approved_web: Globe,
  public_profile: Globe,
  submitted_link: Link2,
}

const KIND_LABEL: Record<EvidenceKind, string> = {
  document: 'Uploaded document',
  approved_web: 'Imported website',
  public_profile: 'Public profile',
  submitted_link: 'Link only',
}

export function EvidenceDrawer({ sources, openSourceId = null, onClose }: EvidenceDrawerProps) {
  const [selectedId, setSelectedId] = useState<string | null>(openSourceId ?? sources[0]?.id ?? null)
  const selected = sources.find((source) => source.id === selectedId) ?? null

  if (sources.length === 0) {
    return (
      <aside aria-labelledby="evidence-heading" className="rounded-md border p-3 text-sm">
        <h3 id="evidence-heading" className="text-sm font-medium">Evidence</h3>
        <p className="text-muted-foreground mt-1 text-xs">No sources were supplied for this interview.</p>
      </aside>
    )
  }

  return (
    <aside aria-labelledby="evidence-heading" className="flex min-h-0 flex-col rounded-md border text-sm">
      <div className="flex items-center justify-between border-b p-3">
        <h3 id="evidence-heading" className="text-sm font-medium">Evidence</h3>
        {onClose && (
          <Button type="button" variant="ghost" size="sm" onClick={onClose} aria-label="Close evidence">
            <X aria-hidden className="size-4" />
          </Button>
        )}
      </div>

      <nav aria-label="Sources" className="border-b">
        <ul className="max-h-40 overflow-y-auto">
          {sources.map((source) => {
            const Icon = KIND_ICON[source.kind]
            const isSelected = source.id === selectedId
            return (
              <li key={source.id}>
                <button
                  type="button"
                  // `aria-current` rather than only a colour: which source is open must be conveyed to a
                  // screen reader too, and this list is the navigation for the panel below it.
                  aria-current={isSelected ? 'true' : undefined}
                  className={`flex w-full items-start gap-2 px-3 py-2 text-left text-xs ${isSelected ? 'bg-muted font-medium' : ''}`}
                  onClick={() => setSelectedId(source.id)}
                >
                  <Icon aria-hidden className="mt-0.5 size-3 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{source.label}</span>
                    <span className="text-muted-foreground block">{KIND_LABEL[source.kind]}</span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </nav>

      {selected && (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <p className="text-muted-foreground mb-2 text-xs">
            {KIND_LABEL[selected.kind]}
            {selected.location?.page !== undefined && ` · page ${selected.location.page}`}
            {selected.location?.section !== undefined && ` · ${selected.location.section}`}
          </p>

          {selected.kind === 'submitted_link' || !selected.text ? (
            <div className="space-y-2 text-xs">
              {/* Named as the platform's restriction. An empty panel would read as a loading failure. */}
              <p className="text-muted-foreground">
                This site’s own terms do not allow us to read it automatically, so there is no extracted
                text. Open it directly to review it.
              </p>
              <a
                href={selected.location?.url ?? selected.label}
                target="_blank"
                // The destination must learn nothing about the page it was opened from — a page that names
                // one candidate being interviewed at one company.
                rel="noopener noreferrer nofollow"
                className="inline-flex items-center gap-1 underline"
              >
                {selected.label}
                <ExternalLink aria-hidden className="size-3" />
              </a>
            </div>
          ) : (
            // Plain text in a <pre>: the extractors already stripped markup, and a component that can
            // render candidate-supplied HTML will eventually be handed some.
            <pre className="text-xs" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {selected.text}
            </pre>
          )}
        </div>
      )}
    </aside>
  )
}
