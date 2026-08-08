import { and, eq } from 'drizzle-orm'
import type { TenantTransaction } from '~/shared/lib/db/client'
import type { WorkerTransaction } from '~/shared/lib/db/worker-db'
import {
  candidateDocuments,
  candidateLinks,
  candidateWebImports,
  documentExtractions,
} from '~/shared/lib/db/schema'
import type { SourceManifestEntry } from '~/shared/lib/interviews'
import { ENTITY_DETAIL_LIMIT } from '~/shared/lib/db/read-bounds'

/**
 * Assembles the evidence manifest a brief may cite (plan:
 * calendar-scheduling-interview-intelligence, Phase 8).
 *
 * ## Only material we actually read becomes citable text
 *
 * Three kinds reach the manifest, and the difference between them is the whole point:
 *
 *   - `document` — a scanned-clean upload whose text a parser extracted. Citable.
 *   - `approved_web` — a page we were permitted to fetch and did. Citable.
 *   - `submitted_link` — a URL on a platform whose terms forbid us reading it. Present so the
 *     interviewer can open it, carrying **no text at all**, and refused as factual evidence by the
 *     brief task's own schema.
 *
 * A pending, rejected or infected document contributes nothing — not an empty entry, not a placeholder.
 * A manifest slot with no text is an invitation for the model to invent what it might have said, and a
 * citation to it would look identical to a citation of something real.
 *
 * ## Ids are stable across regenerations
 *
 * `doc:<uuid>` and `web:<uuid>`, derived from the row, never from an array index. A brief stores the ids
 * its claims cite; if regenerating renumbered them, every citation in every previous version would
 * silently point somewhere else.
 */

export type EvidenceTransaction = TenantTransaction | WorkerTransaction

export interface AssembledEvidence {
  manifest: SourceManifestEntry[]
  /** Counts for the caller's decision about whether generating is worthwhile yet. */
  summary: {
    citableSources: number
    pendingDocuments: number
    rejectedDocuments: number
    urlOnlyLinks: number
  }
}

/** Bounded so one candidate's uploads cannot make an unbounded prompt. Mirrors the task's own cap. */
const MAX_SOURCES = 40
/** Per-source text cap. A 200k-character portfolio page would otherwise crowd out the CV entirely. */
const MAX_SOURCE_CHARS = 40_000

export async function assembleBriefEvidence(
  transaction: EvidenceTransaction,
  params: { organizationId: string; submissionId: string },
): Promise<AssembledEvidence> {
  // Documents joined to their extraction: a clean document with no extracted text is not evidence yet,
  // and the join is what distinguishes "uploaded" from "readable".
  const documentRows = await transaction
    .select({
      documentId: candidateDocuments.id,
      originalName: candidateDocuments.originalName,
      scanStatus: candidateDocuments.scanStatus,
      extractionStatus: candidateDocuments.extractionStatus,
      plainText: documentExtractions.plainText,
    })
    .from(candidateDocuments)
    .leftJoin(
      documentExtractions,
      and(
        eq(documentExtractions.organizationId, candidateDocuments.organizationId),
        eq(documentExtractions.documentId, candidateDocuments.id),
        eq(documentExtractions.status, 'succeeded'),
      ),
    )
    .where(and(
      eq(candidateDocuments.organizationId, params.organizationId),
      eq(candidateDocuments.submissionId, params.submissionId),
    ))
    .orderBy(candidateDocuments.createdAt)
    // Documents and links attached to one submission — the brief is assembled from all of them, and a
    // submission with more than this is not an interview brief.
    .limit(ENTITY_DETAIL_LIMIT)

  const linkRows = await transaction
    .select({
      linkId: candidateLinks.id,
      url: candidateLinks.url,
      policyDecision: candidateLinks.policyDecision,
      importState: candidateLinks.importState,
      importId: candidateWebImports.id,
      extractedText: candidateWebImports.extractedText,
      finalUrl: candidateWebImports.finalUrl,
    })
    .from(candidateLinks)
    .leftJoin(
      candidateWebImports,
      and(
        eq(candidateWebImports.organizationId, candidateLinks.organizationId),
        eq(candidateWebImports.candidateLinkId, candidateLinks.id),
        eq(candidateWebImports.status, 'succeeded'),
      ),
    )
    .where(and(
      eq(candidateLinks.organizationId, params.organizationId),
      eq(candidateLinks.submissionId, params.submissionId),
    ))
    .orderBy(candidateLinks.createdAt)
    .limit(ENTITY_DETAIL_LIMIT)

  const manifest: SourceManifestEntry[] = []
  let pendingDocuments = 0
  let rejectedDocuments = 0
  let urlOnlyLinks = 0

  for (const row of documentRows) {
    if (row.scanStatus === 'infected' || row.scanStatus === 'failed') {
      rejectedDocuments += 1
      continue
    }
    if (row.scanStatus !== 'clean' || row.extractionStatus !== 'succeeded' || !row.plainText) {
      // Still moving through the pipeline. Counted so the caller can say "two documents are still
      // processing" rather than producing a brief that silently ignored them.
      pendingDocuments += 1
      continue
    }
    manifest.push({
      id: `doc:${row.documentId}`,
      kind: 'document',
      label: row.originalName,
      text: row.plainText.slice(0, MAX_SOURCE_CHARS),
    })
  }

  for (const row of linkRows) {
    const fetched = row.importId !== null && typeof row.extractedText === 'string' && row.extractedText.length > 0
    if (fetched) {
      manifest.push({
        id: `web:${row.importId}`,
        kind: 'approved_web',
        // The URL we actually ended up at, which after a redirect is not the one submitted.
        label: row.finalUrl ?? row.url,
        text: (row.extractedText ?? '').slice(0, MAX_SOURCE_CHARS),
      })
      continue
    }
    // Everything else is a link, not a source: a restricted platform, an import that has not run, or
    // one that failed. `sourceManifestEntrySchema` forbids `text` on this kind, so there is no way to
    // accidentally attach content to it later.
    urlOnlyLinks += 1
    manifest.push({ id: `link:${row.linkId}`, kind: 'submitted_link', label: row.url })
  }

  // Truncated at the same ceiling the task's input schema enforces, so a large submission produces a
  // shorter brief rather than a rejected one. Citable sources are kept in preference to url-only links:
  // dropping a link loses a pointer, dropping a document loses the evidence itself.
  const citable = manifest.filter((entry) => entry.kind !== 'submitted_link')
  const links = manifest.filter((entry) => entry.kind === 'submitted_link')
  const bounded = [...citable, ...links].slice(0, MAX_SOURCES)

  return {
    manifest: bounded,
    summary: {
      citableSources: bounded.filter((entry) => entry.kind !== 'submitted_link').length,
      pendingDocuments,
      rejectedDocuments,
      urlOnlyLinks: bounded.filter((entry) => entry.kind === 'submitted_link').length,
    },
  }
}
