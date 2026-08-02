import { createHash } from 'node:crypto'

/**
 * The id of a builder identity, derived from its natural key.
 *
 * There used to be two schemes for the same row. `trackOrganizationBuilder` computed
 * `sha256(source\0sourceId)`; `recordIngestedSourceObservations` used `randomId()`. Both upsert on the
 * natural key `(source, source_id)`, so whichever ran first won the primary key — and then the other one
 * carried on using the id it had computed rather than the id the row actually has.
 *
 * That is not a cosmetic inconsistency. `track` upserts the identity, gets back the *existing* row (with
 * the random id), and then inserts into `organization_builders` referencing its own hashed id:
 *
 *     insert or update on table "organization_builders" violates foreign key constraint
 *     "organization_builders_builder_identity_id_builder_identities_id"
 *     Key is not present in table "builder_identities".
 *
 * A 500, and in the UI a Track button that flickers and silently returns to "Save". It reproduces
 * whenever discovery has already observed a builder before a user tracks them, which is the normal
 * order of events — the ingest pipeline runs continuously and users track what it surfaced. It was found
 * by `tests/e2e/onboarding.spec.ts`, where the search that fills the page records observations for the
 * very builders the next click tracks.
 *
 * One function, so a new row's id cannot depend on which code path created it. Existing rows keep
 * whatever id they already have — callers look the row up first and only fall back to this.
 */
export function builderIdentityIdFor(source: string, sourceId: string): string {
  return createHash('sha256').update(`${source}\0${sourceId}`).digest('hex')
}
