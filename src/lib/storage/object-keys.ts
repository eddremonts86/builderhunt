/**
 * Object keys for candidate documents (plan:
 * calendar-scheduling-interview-intelligence, Phase 6; spec.md "Upload directly
 * to generated quarantine keys").
 *
 * ## The key carries no candidate data
 *
 * Not the original filename, not an email, not a display name. `schema.ts` notes
 * that `object_key` is the only handle to the bytes and that there is no
 * public-URL column; the same reasoning applies to what goes *into* the key.
 * Keys end up in access logs, proxy logs, error traces and signed URLs — every
 * one a place a candidate's filename ("maria-gonzalez-cv-final.pdf") would leak
 * a name and a job search to anyone reading operational output. The original
 * name lives in `original_name` as display metadata and stays in the database,
 * behind RLS.
 *
 * ## Two prefixes, and the move between them is the promise
 *
 * `quarantine/` holds bytes nobody has vouched for. `clean/` holds bytes ClamAV
 * has passed. The prefix is therefore not a label but the state itself: an
 * object under `clean/` was scanned, because the only way to get there is
 * `moveObject` after a clean verdict. Nothing writes directly to `clean/`.
 *
 * That is why `cleanKeyFor` derives its key from the quarantine key rather than
 * rebuilding it from the document's fields: a rebuild that disagreed by one
 * character would move the object to a key the database does not record, and
 * the document would be intact, scanned, and permanently unreachable.
 */

export const QUARANTINE_PREFIX = 'quarantine/'
export const CLEAN_PREFIX = 'clean/'

export class ObjectKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ObjectKeyError'
  }
}

/**
 * Identifiers are UUIDs (`candidate_documents.id`, `submission_id`) or Better
 * Auth text ids (`organization_id`). This refuses anything that would change the
 * key's shape rather than trusting every caller to pass what it promised — a `/`
 * or `..` slipping through here would let one document's key address another
 * document's object.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/

function assertSegment(label: string, value: string): void {
  if (!SAFE_SEGMENT.test(value)) {
    throw new ObjectKeyError(`${label} is not usable in an object key`)
  }
}

/** Where an upload is written. Never `clean/` — only the scanner promotes an object. */
export function quarantineKeyFor(params: {
  organizationId: string
  submissionId: string
  documentId: string
}): string {
  assertSegment('organizationId', params.organizationId)
  assertSegment('submissionId', params.submissionId)
  assertSegment('documentId', params.documentId)
  return `${QUARANTINE_PREFIX}${params.organizationId}/${params.submissionId}/${params.documentId}`
}

/**
 * The clean-prefix counterpart of a quarantine key, by substitution rather than
 * reconstruction. Refuses a key that is not under `quarantine/`, because
 * "promote this to clean" is only meaningful for something currently quarantined
 * — being asked to promote an already-clean key means a caller has lost track of
 * state, and answering it would hide that.
 */
export function cleanKeyFor(quarantineKey: string): string {
  if (!quarantineKey.startsWith(QUARANTINE_PREFIX)) {
    throw new ObjectKeyError('only a quarantine key can be promoted to the clean prefix')
  }
  return `${CLEAN_PREFIX}${quarantineKey.slice(QUARANTINE_PREFIX.length)}`
}

export function isQuarantineKey(key: string): boolean {
  return key.startsWith(QUARANTINE_PREFIX)
}

export function isCleanKey(key: string): boolean {
  return key.startsWith(CLEAN_PREFIX)
}
