# Tasks — self-managed profiles

> **Status**: `pending`
> **Depends on**: [`02-segmentacion-usuarios`](../../implemented/phase-2/02-segmentacion-usuarios/spec.md),
> [`03-onboarding-segmentado`](../../implemented/phase-2/03-onboarding-segmentado/spec.md),
> [`04-dashboard-personalizado`](../04-dashboard-personalizado/spec.md),
> [`06-landing-segmentada`](../06-landing-segmentada/spec.md),
> [`phase-1/36-claimable-profiles`](../../implemented/phase-1/36-claimable-profiles/spec.md),
> [`phase-1/37-portfolio-builder`](../../implemented/phase-1/37-portfolio-builder/spec.md), and
> [`phase-1/38-work-sample`](../../implemented/phase-1/38-work-sample/spec.md)
> **Blocks**: nothing
> **Reality check**: The original 83-item checklist predated the current schema tip (`0154`), the
> production document pipeline in `src/lib/storage/`, the account data-export API, and the removal
> of two network sources. The tasks below are the executable contract. Reuse the document pipeline;
> do not create a second storage, MIME-validation, ClamAV, or signed-download implementation.

Execute top to bottom. Each task ends in a reviewable, independently testable deliverable.

## Phase 0 — canonical model and ownership

- [x] **Add the account-subject profile and attachment schema**
  - Files: `src/shared/lib/db/schema.ts`, `drizzle/*.sql` (new migration allocated by
    `pnpm db:generate`), `drizzle/migration-hashes.json`,
    `docs/architecture/data-classification.md`
  - Do: add `self_managed_profiles`, `self_managed_attachments`, and
    `self_managed_handle_reservations` with the complete columns and constraints from `spec.md`.
    Profiles are account-subject data keyed by `owner_user_id`; public reads expose only the public
    projection. Add forced RLS, app/worker grants, ownership policies using server-set user context,
    unique active handle/owner constraints, organization-independent deletion semantics, and a safe
    forward-only migration. Let `pnpm db:generate` allocate the migration number.
  - Verify: `pnpm test:migrations:local`, `pnpm test:migration-integrity`, and a negative DB test
    proving user A cannot select or mutate user B's draft/unlisted profile or attachments.
  - Result: `drizzle/0175_self_managed_profiles.sql` — three tables, applied, `migration-integrity`
    green at 176.
  - **The RLS shape deliberately departs from its own precedent.** `0171_user_preferences` is the
    account-subject template and its policies are owner-only, keyed on `app.user_id`. Copying that
    here would be wrong in a way that looks right: these profiles are read by strangers at
    `/u/<handle>`, so owner-only makes every public profile invisible and the failure reads as "no
    profiles exist" rather than as a policy. Each table therefore pairs an owner policy with a
    public-read policy scoped to `visibility in ('public','unlisted') and deleted_at is null`.
  - `unlisted` **is** publicly readable at the row level, on purpose: it means reachable by anyone
    holding the link. Keeping it out of *search* is the route's job, because a policy cannot tell a
    direct visit from a listing.
  - An attachment's exposure is a subquery against its profile rather than a denormalised column, so a
    profile returning to `draft` hides its attachments in the same statement. Two columns to keep in
    step is how an attachment outlives the decision to hide it.
  - The handle and owner unique indexes are **partial on live rows**. A plain `unique` would let a
    soft-deleted profile hold its handle forever and stop anybody from making a second profile after
    deleting their first — and the error would read "handle taken" for a handle nobody holds.
  - Negative test run against the real database as `builderhunt_app` with `app.user_id` set: B cannot
    select A's draft (0 rows), cannot update it (0 rows), A can read their own (1), B can read it once
    published (1), and B loses it the moment it is soft-deleted (0). Five for five.

- [x] **Implement schemas, service taxonomy, and repositories**
  - Files: `src/shared/lib/self-managed/contracts.ts`,
    `src/shared/lib/self-managed/service-taxonomy.ts`,
    `src/shared/lib/repositories/self-managed-profiles.ts`,
    `src/shared/lib/repositories/self-managed-attachments.ts`,
    `tests/unit/shared/lib/repositories/self-managed-profiles.test.ts`,
    `tests/unit/shared/lib/repositories/self-managed-attachments.test.ts`
  - Do: define strict Zod request/public DTO schemas and the versioned service taxonomy. Implement
    owner-resolved CRUD, visibility transitions, handle reservation expiry, attachment lifecycle,
    and bounded retention batches. Repository writes take the authenticated user from server context;
    no public method accepts an authority-bearing `ownerUserId` from a request DTO.
  - Verify: `pnpm test tests/unit/shared/lib/repositories/self-managed-profiles.test.ts
    tests/unit/shared/lib/repositories/self-managed-attachments.test.ts`; include create/update/delete,
    expired reservation, duplicate owner/handle, invalid transition, and cross-user negative cases.
  - Result: two repositories and 39 tests, all green. `contracts.ts` and `service-taxonomy.ts` were
    already written alongside the schema in task 1; what this task added is the data access over them.
  - **A handle's availability is three questions, not one.** A live profile may hold it, a profile
    soft-deleted inside the last thirty days may hold it, or somebody else's unexpired reservation
    may. Answering only the first is the version that looks right and hands out a handle that comes
    back a month later attached to a resurrected profile — with every inbound link, bookmark and
    search result the previous owner built, which to a reader is indistinguishable from impersonation.
  - The uniqueness checks before each write are advisory. `self_managed_profiles_owner_live_unique`
    and `..._handle_live_unique` are what hold under two concurrent requests; checking first exists so
    the common case gets a message naming the problem, and 23505 is translated back into
    `handle-taken` or `already-exists` so a lost race is not a 500.
  - **No function takes a `profileId`.** Attachments resolve the profile from `ownerUserId`, because
    "add an attachment to profile X" is exactly the shape that lets one person publish a document on
    another person's page. Every attachment query is scoped to the caller's own profile as well as the
    id, and a stranger's attachment id reads as `not-found` rather than as an edit.
  - `updateAttachment` cannot touch `storageKey`, `mimeType`, `sizeBytes` or `checksumSha256`: those
    describe the object the scanner saw. Replacing a file is a delete and a new upload, which is the
    same work and cannot lie.
  - Deleting is two steps and the repository is only the first. The row is marked, the bytes go in the
    sweep — `listPurgeableAttachments` hands out keys and `purgeDeletedAttachments` takes back the ids
    whose objects are actually gone. Re-running the predicate instead of passing ids would delete rows
    that became eligible between the two statements, leaving their bytes in the bucket forever.
  - **The Date-binding trap bit again.** `createDisposableTestDatabase` runs `migrate()` on the client
    it hands back, and after that every `sql\`col > ${date}\`` throws `ERR_INVALID_ARG_TYPE` — 22 of 23
    tests failed at once on it. Typed operators (`gt`, `lt`, `ne`, `isNotNull`, `inArray`) go through
    the column mapper and are unaffected, and are better drizzle regardless. The helper is still the
    underlying defect and every disposable-DB test shares it.
  - These tests connect as a superuser and prove nothing about RLS. The policy evidence is task 1's
    five-case negative test against the real `builderhunt_app` role. What they do prove is the layer
    RLS cannot: the two spec limits and the repository's own `WHERE` clauses.

## Phase 1 — uploads on the existing document pipeline

- [x] **Extend the existing quarantine and scanning pipeline for profile attachments**
  - Files: `src/lib/storage/document-validation.ts`, `src/lib/storage/object-keys.ts`,
    `src/lib/storage/provider.ts`, `src/lib/storage/clamav.ts`,
    `src/lib/scheduling/document-worker.ts`,
    `tests/unit/lib/storage/document-validation.test.ts`,
    `tests/unit/lib/scheduling/document-worker.test.ts`
  - Do: add the self-managed attachment policy (allowed MIME types, 25 MB cap, 12 active files,
    one active CV) as a caller-specific policy over the existing validators and provider. Use the
    existing `quarantine/` → `clean/` promotion and fail-closed scanner behavior. Generalize the
    worker only where needed; do not fork ClamAV, S3 signing, magic-byte validation, or object-key
    safety into a second storage tree.
  - Verify: unit tests reject MIME/magic-byte mismatch and EICAR, keep failed scans quarantined,
    promote a clean object, enforce both quotas, and prove object keys never contain user filenames.
  - Done in two halves: the validation contract and the key space first (24 tests), then the scan
    pipeline once `drizzle/0176_self_managed_scan_state.sql` gave the table a scan state —
    `runSelfManagedAttachmentScanWorker` in `document-worker.ts`, the lease/mark/reclaim functions in
    the attachment repository, and 16 new cases across the two suites (the attachment repository's
    25 and the worker's 23 are all green, as is the full unit run: 7,351).
  - **Done: a policy, not a second validator.** `UploadPolicy` names the only two things the
    candidate path and this one actually differ on — the accepted formats and the byte cap — and
    `validateDocument` takes one, defaulting to the candidate contract so every existing caller is
    untouched (its 28 tests still pass unchanged). Everything expensive to get right stays shared:
    magic bytes against the declaration, hash against the bytes, the zip walk, the PDF checks.
  - Every `sniffedAs` entry was **measured against `file-type`**, not assumed, and two of the seven
    would have been wrong if guessed: a PNG is not recognised until its IHDR length is well formed,
    and an MP3 behind an ID3v2 tag needs the tag's synchsafe size to be right. Both are true of every
    real file and false of the obvious hand-made fixture — a fixture the sniffer rejects would make
    these tests pass for the wrong reason, as a mismatch rather than an acceptance.
  - `text/plain` is deliberately **not** in the profile policy. Text is the one format with no magic
    bytes, so its whole structural check is "decodes as UTF-8, holds no NUL" — worth it for a CV a
    recruiter asked for, not worth it on a public page where it buys nothing a PDF does not.
  - **Done: `self-managed/` is a separate key space**, not a shared one. A candidate key is
    `quarantine/<org>/<submission>/<document>` and a profile key would otherwise be
    `quarantine/<owner>/<profile>/<attachment>` — same prefix, same arity, nothing saying which is
    which. The two are authorized completely differently, so a route checking the wrong one would
    still find an object. The infix makes that impossible in the key rather than in every caller.
  - **Unblocked by `0176`, written as its own deliberate migration** (the spec contradiction stands
    recorded below for the next reader). It mirrors `candidate_documents` exactly: the six-state
    machine (`awaiting_upload → pending → scanning → clean | infected | failed`), persisted
    `scan_attempts`, `rejection_code` as an **iff** with the two rejection states, and a nullable
    window for `size_bytes`/`checksum_sha256` that is exactly one state wide — two presence CHECKs
    close it the moment a row leaves `awaiting_upload`. Pre-`0176` rows are backfilled to `pending`,
    not `clean`: their old contract *claimed* "already scanned", but nothing ever scanned them, and
    the worker earning the verdict is cheaper than trusting a claim no scanner made.
  - **The public-read policy now requires `scan_status = 'clean'`**, and so does
    `listPublicAttachments`. Before `0176`, "pending attachments are not served" rested entirely on
    queries remembering a filter that did not exist yet; now the row policy says it too.
  - **`0175`'s worker grants were unreachable, and `0176` closes that for all three tables.** The
    `0175` comment claimed the worker "bypasses RLS through its own role" — but `builderhunt_worker`
    is `NOBYPASSRLS` (`scripts/db/roles.sql`) and the tables are FORCE RLS, so a role with grants and
    no policy gets empty results, not errors: the exact failure mode `0085` warns about. `0176` adds
    the per-operation `USING (true)` worker policies `candidate_documents` got in `0085`, to
    attachments, profiles and handle reservations alike — without them the scan lease, the retention
    sweep and the reservation sweep would all have silently swept nothing. Verified through the real
    role identity, not just the superuser suites: on a freshly migrated scratch database,
    `SET ROLE builderhunt_worker` sees a seeded pending attachment and the lease UPDATE claims it
    (`pending → scanning`, `UPDATE 1`).
  - **The scan worker is a second worker, not a fourth phase of `runDocumentWorker`.** That worker's
    loop, kill switch and job history are per-organization; a self-managed profile is account-subject
    and has no tenant to iterate. `runSelfManagedAttachmentScanWorker` runs under its own
    `self-managed.attachment-scan` job key with the same three-step contract (reclaim + lease
    committed first, network I/O outside any transaction, one short transaction per outcome), and one
    broken attachment fails alone rather than stalling the batch. What is shared is the part that
    must never fork: `scanStoredObject` — extracted from the candidate `scanOne`, byte-for-byte the
    same verdict handling — plus provider, ClamAV, key derivation and the move-before-mark ordering.
  - One deliberate improvement over the precedent, in the shared core: a leased key already under
    `clean/` (a previous pass moved the object and died before the mark landed) re-earns its verdict
    but skips the move, instead of failing forever on a source the move already emptied. For
    candidate rows this state is unreachable today, so their behavior is unchanged.
  - Deliberately left for task 4: the routes that *feed* this pipeline (intent → `awaiting_upload`,
    completion → `pending`) and the admin run-worker route that triggers it. `addAttachment` writes
    `pending` in the meantime, which is what its fixtures now mean: stored, verified, awaiting the
    scanner's word.

- [x] **Expose upload intent, completion, download, and deletion routes**
  - Files: `src/routes/api/self-managed/attachments/index.ts`,
    `src/routes/api/self-managed/attachments/$attachmentId/complete.ts`,
    `src/routes/api/self-managed/attachments/$attachmentId/download.ts`,
    `src/routes/api/self-managed/attachments/$attachmentId/index.ts`,
    `tests/e2e/self-managed-profile.spec.ts`
  - Do: follow the proven scheduling-document flow: authenticated intent creates an
    `awaiting_upload` row and presigned PUT; completion verifies real length/hash/magic bytes and
    moves to `pending`; the worker scans; download issues a five-minute signed URL only for `clean/`
    objects owned by the caller. Public profile DTOs expose attachment metadata but never object
    keys, hashes, rejection details, or signed URLs.
  - Verify: the e2e spec runs against real Postgres, MinIO, and ClamAV and covers clean download,
    infected refusal, expired/foreign capability refusal, cross-user 404, quota, and soft delete.
  - Result: the four routes plus two the flow could not ship without — a `GET` list on the
    collection (the owner has to be able to *see* `pending`/`failed`/`rejectionCode`, and nothing
    else serves that until the editor task) and `api/admin/self-managed/run-worker`, the cron/admin
    trigger without which nothing in production ever scans. The later reconciliation task extends
    that route's job; it does not add a second one. E2E: 10 specs, all green against real Postgres,
    MinIO and ClamAV — 10.9 s. "Expired/foreign capability refusal" from the Verify line translates
    to this flow's authority model as: unauthenticated 401 on every handler, and a foreign *user*
    reading another owner's attachment id as 404 in completion, download and delete alike.
  - **Session + `withAccountSubjectContext`, not a tenant principal.** A profile belongs to a
    person; requiring an active organization would refuse a signed-in builder without one. The
    context sets `app.user_id` and nothing else, which is exactly the identity `0175`'s owner
    policies key on — and `auth.api.getSession` is both the guard the coverage gate recognises and
    the first await in every handler, which is what `check-authenticate-before-validate` pins.
  - **Completion is one role, unlike the candidate flow, and that is not a shortcut.** Candidates
    need a worker-role UPDATE because the capability role deliberately holds none; here the caller
    is the authenticated owner, `builderhunt_app` holds UPDATE, and the owner policy scopes it. The
    single-use property is the same: `awaiting_upload` is re-checked inside the UPDATE, so a
    replayed completion cannot rewrite a judged row's hash.
  - **The validator sees a synthesized filename.** This model stores no client filename by design —
    the spec forbids names in keys, and a name nobody renders is PII retained for nothing — but the
    shared validator checks extension-vs-type. The name it gets is built from the declared type's
    own extension; the magic bytes still decide.
  - **Quota is a reservation, and a rejection releases it.** The intent row holds one of the twelve
    slots (and the CV slot) from the moment it is issued; `infected`/`failed` rows stop counting, so
    a profile cannot be locked shut by its own refused uploads. `addAttachment`'s counts moved onto
    the same rule, the abandoned-intent sweep joined the scan worker (an hour-old `awaiting_upload`
    is deleted and its partial object removed), and the owner list's bound grew from twelve to
    forty-eight because rejected rows stay visible — the *why* is the one thing the owner can act on.
  - The e2e's scanner-leg test promotes an EICAR object to `pending` by SQL, deliberately: the
    policy has no magic-byte-less format, so no EICAR body can pass completion honestly (that
    refusal is its own test), and the worker's fail-closed verdict has to hold even if validation
    is somehow sidestepped. Defence in depth, tested as depth.
  - A zero-byte PUT completes as `upload_missing` rather than entering the reject path — the
    rejection path records the measured size, and the schema rightly refuses a size of zero.

## Phase 2 — profile API and public/editor UI

- [x] **Expose strict owner and public profile APIs**
  - Files: `src/routes/api/self-managed/profile/index.ts`,
    `src/routes/api/self-managed/profile/$profileId.ts`,
    `src/routes/api/self-managed/handle/$handle/reserve.ts`,
    `src/routes/api/self-managed/visibility.ts`,
    `tests/unit/routes/api/self-managed-profile.test.ts`
  - Do: implement authenticated create/update/delete/visibility and a public handle lookup. Resolve
    identity on the server, use strict schemas, rate-limit creation/reservation/public lookup, return
    the same 404 for absent and unauthorized resources, and audit material visibility changes without
    logging profile content.
  - Verify: route tests cover 200/400/401/404/409/429, unknown fields, handle expiry, idempotent
    retries, draft/unlisted/public visibility, and cross-user enumeration resistance.
  - Result: the four listed routes plus `handle/$handle/index.ts` — the "public handle lookup" as an
    *authenticated*, per-user rate-limited availability oracle, because an anonymous one is an
    enumeration API by construction and nothing before the public page task needs it signed out.
    32 handler tests cover the Verify matrix (mocked guard/context/repositories, real error
    classes), and the e2e spec grew to 13 specs by making the API its own seed: profile creation,
    rename by id, visibility round-trip, reservation against a rival, and deletion taking the
    attachments with it all run against the real stack. Rate limits: create 10/day, reserve 5/day
    (spec), lookup 30/min. Deletion and visibility changes are audited with the transition and
    never the content.
  - **The e2e found three RLS defects the superuser suites could not, and `0177` closes them** —
    exactly the failure class task 2's notes predicted. (1) `reserveHandle`'s
    `INSERT ... ON CONFLICT DO UPDATE` needs UPDATE privilege even when no conflict occurs, and
    `0175` granted the app role none: every reservation was a 500. (2) The owner-only policy made
    rival reservations invisible to `isHandleAvailable`, so a held handle read as free and a profile
    could be created over somebody's hold. (3) No policy exposed soft-deleted rows, so the
    thirty-day handle hold — the anti-impersonation property — did not exist for the role that
    serves requests. `0177` adds the UPDATE grant, an existence-read policy on reservations, a
    lapsed-takeover policy whose WITH CHECK forces the caller's own name, and a deleted-rows read
    policy on profiles; the e2e now asserts the hold through the real role (a freed handle reads
    taken, and creating over it is a 409).
  - The razor race the availability read cannot close — two callers reserving in the same instant —
    surfaces as the row policy refusing the DO UPDATE (42501) under RLS, or the unique key (23505)
    without it; `reserveHandle` translates both to `handle-taken`, so losing the race is a 409 and
    never a 500.
  - `PATCH`/`DELETE` verify the path id against the caller's own profile and answer one 404 for
    absent, deleted and foreign — asserted byte-for-byte identical in the handler tests, with the
    write never called.

- [x] **Build the editor and public profile with explicit provenance**
  - Files: `src/routes/_dashboard/me/profile.tsx`, `src/routes/u/$handle.tsx`,
    `src/modules/builder-profile/components/SelfManagedProfile.tsx`,
    `src/modules/builder-profile/components/AttachmentUploader.tsx`,
    `tests/e2e/self-managed-profile.spec.ts`
  - Do: build an accessible owner editor and SSR public page. Render a distinct neutral
    `Self-managed` chip on every self-declared block and never the verified badge. Only clean
    attachments appear publicly; unlisted resolves by direct URL with `noindex`; draft/deleted is
    404. Reuse builder-profile primitives where their semantics match.
  - Verify: Playwright creates, edits, uploads, publishes, refreshes, and visits the profile as an
    anonymous browser; axe is clean; draft is 404; unlisted is `noindex`; the verified visual token
    never appears until an actual verified claim is linked.
  - Result: `/me/profile` (editor), `/u/$handle` (public SSR), `SelfManagedProfile.tsx` with an
    exported `SelfManagedChip`, and `AttachmentUploader.tsx` driving the three-call upload from the
    browser. The e2e grew to 17 specs: the editor journey runs in a real browser (create, publish,
    upload a PNG, run the worker, see it turn `Published`), a stranger reads the served HTML, and
    axe finds no critical or serious violation on either surface.
  - **The chip marks every self-declared block, not just the header.** A reader who lands mid-page
    on a list of work samples is the one most likely to mistake declared for verified, so About,
    Services, Languages/topics and Work samples each carry it. The caveat sentence is rendered at
    reading size directly under the name — a disclaimer somebody has to go looking for only protects
    the people who wrote it.
  - **Neutral by construction, and asserted as such.** `BuilderProfilePage` renders "Verified" as
    `bh-success` green with a `BadgeCheck`; the chip is `bh-surface-2` / `bh-border-strong` /
    `bh-text` — a label, not an award, which is the honest shape for a claim nobody checked. Full
    `bh-text` rather than the muted token puts it at ~16:1 in light and ~15:1 in dark, well past the
    spec's 4.5:1. The e2e asserts `>Verified<` never appears in the served HTML.
  - **Three visibility states, three HTTP answers, proved against the served bytes.** `public` is
    200 and indexable, `unlisted` is 200 with `noindex` on both `robots` and `googlebot` (the root
    sets its own `googlebot`, and Google honours the named tag), `draft` and soft-deleted are 404 —
    byte-identical to a handle nobody ever took. Asserted with a request context rather than a
    hydrated page: a crawler is the reader whose mistake would cost most, and hydration would paper
    over a page that rendered nothing server-side.
  - The public read runs with **no `app.user_id` set at all**, so only the `0175` public-read
    policies can answer. That makes the anonymous page a test of those policies rather than of a
    `WHERE` clause — a draft would have to escape both to leak. Only `clean` attachments reach it,
    and the DTO names its fields: no key, no checksum, no scan status, no rejection code.
  - **Not shipped, deliberately: a public download route.** The page lists each work sample with its
    kind, size and description, but a stranger cannot fetch the bytes — an anonymous signed-download
    endpoint is a bandwidth and hotlinking surface that needs its own rate-limit design, and it is
    not among this task's Files. The owner-scoped download from task 4 is unchanged. Worth its own
    task before the rollout claims a portfolio is browsable.
  - The spec reuses one browser account across the UI tests and hard-deletes its profile between
    them. Better Auth rate-limits sign-up per IP and every fixture here comes from one host, so a
    fixture per test is a budget the file cannot afford — it failed on the tenth with a 429 that
    reads exactly like a product bug.

## Phase 3 — unified discovery without duplicated source logic

- [x] **Add self-managed as a typed internal search origin**
  - Files: `src/lib/sources/types.ts`, `src/lib/sources/self-managed.ts`,
    `src/lib/search.ts`, `src/lib/dedup.ts`, `src/shared/lib/profile-suppression.ts`,
    `tests/unit/lib/search/self-managed.test.ts`
  - Do: add the `self-managed` origin exhaustively to every `SourceName`-keyed registry or introduce
    a separate typed internal-origin union if that avoids pretending it is a network connector.
    Query only public, non-deleted profiles. Preserve source health semantics, use stable
    `(source, sourceId)` identity, never merge by display name/handle, and apply suppression before
    ranking. The registry currently has 15 historical source identifiers but only 13 active network
    connectors; tests must not call the internal origin over HTTP.
  - Verify: `pnpm type-check` catches every exhaustive registry; unit tests prove inclusion,
    exclusion, dedup, suppression, timeout/error reporting, and unchanged relative order for
    pre-existing results.
  - Result: the separate typed union, which is the branch the task offers second and the honest one.
    `INTERNAL_ORIGIN_NAMES` / `BuilderOrigin` in `sources/types.ts`, `sources/self-managed.ts` as
    the origin, a bounded `searchPublicProfiles` in the profile repository, and the fan-out split in
    `resolveContactableSources`. 21 new tests across two files, the full unit suite at 7,403, and
    `search.spec.ts` green — the ranking fixture did not move.
  - **Why not `SourceName`.** Every registry keyed on that union describes a *network connector*:
    the operator register decides whether a host may be contacted, `CREDENTIAL_ENV_VARS` says which
    token it needs, the discovery matrix schedules crawls, and the acquisition policy records what
    its terms permit. A self-managed profile is a row this product owns — no host, no token, no
    terms — and its honest answers to those questions ("always enabled", "no credential", "never
    crawled") are **indistinguishable from a connector somebody forgot to configure**. Adding it
    there would have bought a `disabled` status for a missing register row and an `unconfigured` for
    an absent credential, both of which read as operator decisions nobody made. Asserted directly:
    the origin is absent from `SOURCE_NAMES`, from `CREDENTIAL_ENV_VARS`, and never reaches
    `partitionRequestedSources` — which is called with the network sources alone.
  - Widening `RawBuilder.source` to `BuilderOrigin` produced **zero type errors**, which is worth
    recording rather than celebrating: nothing indexes a `Record<SourceName, …>` by a builder's own
    source today, so the compiler had nothing to catch. The guard that does hold is the split in
    `resolveContactableSources` plus its test.
  - **`dedup.ts` and `profile-suppression.ts` needed no change, and that is the finding.** Dedup has
    keyed on `(source, sourceId)` since plan 43 — never the username — so a self-managed profile and
    a GitHub account sharing a handle are already two identities; the test pins it so a future
    "merge by display name" cannot quietly absorb one person's page into another's. Suppression is
    generic over `{source, sourceId}` strings, so `self-managed:<id>` works the day somebody files
    one, and it already runs before `scoreBuilders` on both the live and the cached path.
  - **`unlisted` is not searchable, and the predicate is where that lives.** The row policy permits
    reading an unlisted profile because a policy cannot tell a direct visit from a listing; the
    query filters `visibility = 'public'`. Soft-deleted rows are gone from search immediately rather
    than at purge time.
  - **Nothing invents a signal.** `followersCount` is left undefined rather than zeroed, and
    `lastSeen` is deliberately unset: deriving it from `updatedAt` would let editing a bio outrank a
    builder who shipped this morning, which is the dilution the plan's risk table names. The scoring
    branch adds only a small capped services term, and a test asserts the existing builders' scores
    are byte-identical with a self-managed row in the list.
  - **Deliberately not default-on.** `DEFAULT_SEARCH_SOURCES` is unchanged and a test pins that,
    because the shared inclusion policy and its opt-out are the next task's — turning the origin on
    for every search before a user can say no is the anti-pattern the spec's own coverage section
    forbids in the other direction. The origin is available the moment it is requested.

- [x] **Index public self-managed profiles for semantic search**
  - Files: `src/lib/semantic/index-writer.ts`,
    `src/shared/lib/repositories/public-builder-embeddings.ts`,
    `src/shared/lib/operational-schedules.ts`,
    `src/routes/api/admin/self-managed/run-worker.ts`,
    `tests/unit/shared/lib/repositories/public-builder-embeddings.test.ts`
  - Do: write a distinct entity kind for self-managed people using bio/headline/topics/services and
    clean attachment descriptions only. Enqueue refresh on material publish/update/clean-scan events
    and register a bounded reconciliation worker with a unique `jobKey` and `withJobRun`. Deletion or
    restriction removes the semantic row immediately.
  - Verify: repository tests prove entity-kind filtering and deletion; worker test proves bounded,
    idempotent reconciliation; semantic API e2e returns a public fixture and excludes draft/deleted.
  - Result: `self_managed_person` as its own entity kind (`0178`), `semantic/entity-kinds.ts`,
    `semantic/self-managed-index.ts`, the reconciliation worker under
    `self-managed.semantic-index`, both self-managed jobs registered in `operational-schedules.ts`,
    and the admin run-worker route now running scan then index. 28 unit tests across two files, the
    e2e at 18 specs, unit suite 7,407, 180 migrations double-applied.
  - **A distinct kind, and not by widening `COMPONENT_KINDS`.** That list is also the CHECK on
    `solution_components.kind` and `solution_component_projections.kind`, so adding
    `self_managed_person` there would have made it a type-legal component kind that two tables
    refuse at the constraint — a type saying yes over a database saying no. `SEMANTIC_ENTITY_KINDS`
    is the catalog's list plus one, `0178` moves only the embeddings CHECK, and a test asserts both
    halves. Why a distinct kind at all: indexing these as `human_profile` would have added them to
    every semantic search already filtering for humans, on the day the indexer shipped, with no way
    for anyone to say no — the same opt-in reasoning as the search origin.
  - **The e2e found a real grant gap, and `0179` closes it.** `0025` gave the app role SELECT,
    INSERT and UPDATE on `builder_embeddings` and no DELETE, which was right while the only writer
    was a write-through indexer that never removed anything. Self-managed profiles break that in the
    urgent direction: hiding or deleting a profile has to take its row out *now*, on the request
    path, as the app role. Without the grant the index write succeeded, the delete failed `42501`,
    and the fire-and-forget contract swallowed it — the row stayed and only the nightly pass would
    ever have cleared it. Verified through the real role: `permission denied` before, `DELETE 0`
    after.
  - **Removal is awaited; indexing is not.** Create and update fire the sync off the response path,
    because a slow index must not make saving a profile slow. Visibility changes and deletes await
    it: somebody who just withdrew and still turns up in search has been told the change applied and
    shown that it did not. The e2e says the same thing by polling the first and not the second.
  - **The document is declared content only.** Headline, bio, topics, services and the titles and
    descriptions of `clean` attachments — never the filename, the object key or the checksum, and
    never an unscanned attachment: an embedding is a copy, so text that reaches it has left the row
    policy behind and cannot be un-indexed by tightening one later. The document states its own
    provenance in its first lines, so a raw retrieval hit carries "declared by its owner, not
    verified" without a join.
  - **The reverse pass is skipped when the forward pass was truncated.** `eligible` is a partial set
    at that point, and deleting against a partial set would remove live profiles the walk had simply
    not reached. The truncation is logged rather than swallowed — a cap that silently covers the
    first N profiles reads exactly like a pass that found nothing to do.
  - `upsertBuilderEmbeddingStub` gained an injectable `db`, matching the read functions beside it, so
    the disposable-database tests exercise the real `ON CONFLICT` and the real content-hash
    comparison instead of a mock that would assert them into existence.
  - Both jobs are in `OPERATIONAL_SCHEDULES` now — the scan every five minutes because its interval
    is a person watching an upload say "checking for viruses", the reconciliation nightly because
    write-through already handles the live path and a five-minute backstop would spend its life
    confirming it.

- [ ] **Apply the shared inclusion policy to every current matching surface**
  - Files: `src/shared/lib/self-managed/inclusion-policy.ts`,
    `src/routes/api/recommendations/index.ts`, `src/lib/sprints/results.ts`,
    `src/lib/alerts/worker.ts`, `src/lib/solutions/`,
    `tests/unit/shared/lib/self-managed/inclusion-policy.test.ts`,
    `tests/e2e/self-managed-profile.spec.ts`
  - Do: centralize eligibility (public, non-deleted, non-suppressed), provenance decoration and the
    explicit opt-out. Recommendations, sprint shortlists, alerts, and solution-person results call
    the policy rather than duplicating filters. Opt-out changes inclusion only, never permissions or
    the rank of non-self-managed rows. Do not invent a global preference JSON blob; use the typed
    `user_preferences` contract from plan 02 or a per-resource field when the choice belongs to a
    sprint.
  - Verify: unit matrix covers default-on, explicit-off, deleted, suppressed, draft, unlisted and
    rank preservation; e2e asserts the chip on search, recommendations and sprint results.

- [ ] **Guard future matching surfaces mechanically**
  - Files: `scripts/check-self-managed-coverage.mjs`, `package.json`,
    `plans/_meta/conventions.md`
  - Do: add a repo-shape gate whose allowlist enumerates every route/worker that emits people or
    candidate matches and records its inclusion-policy call or explicit non-person exemption. Wire
    the script into `pnpm ci:local`; a new matching surface without a declaration must fail.
  - Verify: the script passes, then fails when a scratch matching route is added without a
    declaration, and passes again after the scratch file is removed.

## Phase 4 — promotion, privacy, lifecycle, and rollout

- [ ] **Implement reversible promotion to a verified claim**
  - Files: `src/shared/lib/repositories/self-managed-profiles.ts`,
    `src/shared/lib/human-identity/link-policy.ts`,
    `src/routes/api/self-managed/profile/$profileId/promote.ts`,
    `tests/unit/security/self-managed-promotion.test.ts`
  - Do: require an already verified claim and explicit owner confirmation; link by immutable ids,
    preserve the self-managed narrative/attachments, make the verified claim authoritative for
    verified fields, and keep unlink/relink auditable. Similarity or matching handles never
    auto-promote.
  - Verify: tests cover verified/unverified claim, wrong owner, conflicting link, unlink/relink,
    retained attachments and no automatic link from a high similarity score.

- [ ] **Extend data export, erasure, suppression, and retention**
  - Files: `src/shared/lib/repositories/account-privacy.ts`,
    `src/shared/lib/repositories/profile-removal.ts`,
    `src/routes/api/me/data-export/index.ts`,
    `tests/unit/shared/lib/repositories/account-privacy.test.ts`,
    `tests/e2e/api/privacy-profile-removal.spec.ts`
  - Do: include profile/attachment metadata in the existing export without object keys or signed
    URLs; immediately tombstone public/search reads on erasure; purge blobs in bounded idempotent
    batches after 30 days; retain only the minimal audit record required by policy.
  - Verify: export fixture contains declared content and no storage secret; an erasure e2e removes
    profile/search visibility immediately and a retention test seeded beyond one batch deletes every
    eligible blob while preserving active ones.

- [ ] **Integrate onboarding, dashboard, landing, and truthful analytics**
  - Files: `src/routes/onboarding/building.tsx`,
    `src/modules/dashboard/lib/dashboard-presets.ts`,
    `src/modules/landing/content/segment-pages.ts`,
    `src/shared/lib/conversion-events.ts`,
    `tests/e2e/self-managed-profile.spec.ts`
  - Do: branch `building` between claim-existing and create-from-scratch, add real profile status to
    the building dashboard preset, and make `/for/builders` promise only shipped behavior. Events use
    allowlisted ids/statuses and never profile text, filenames, handles, or attachment metadata.
  - Verify: e2e covers landing → signup → building onboarding → editor → public profile and
    an existing-claim path; analytics assertions prove no PII enters event payloads.

- [ ] **Ship behind a fail-closed flag and record runtime evidence**
  - Files: `.env.example`, `docs/operations/self-managed-profiles-rollout.md`,
    `content/changelog/self-managed-profiles.md`
  - Do: add one server-owned feature flag that returns 404/disabled UI when off, document migration,
    worker, storage, rollback and observability checks, and prepare truthful changelog copy. Rollback
    disables create/update/indexing while preserving existing data and erasure access.
  - Verify: `pnpm ci:local` is green; the complete Playwright flow passes against real Postgres,
    MinIO and ClamAV with flag on; flag off hides entry points and blocks writes while data export and
    erasure remain available; runtime evidence is linked from the rollout document.
