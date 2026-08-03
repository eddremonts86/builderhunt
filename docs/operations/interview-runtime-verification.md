# Interview runtime verification

Live interview capture is the only feature in this product that depends on browser behaviour we cannot
test in CI: a real microphone, a real tab share, and two people talking. Everything the automated suite
covers is *our* code — the constraints we pass, the graph we build, the messages we parse. What it cannot
cover is whether Chrome on a particular machine actually delivers two channels of usable audio when
someone ticks "Also share tab audio".

This document is the procedure for finding that out, and the register of what was found.

> **Status: the live session has not been run.** The runbook below is complete; no session with human
> participants has taken place. The results tables are empty on purpose — see
> [Recording results](#recording-results). That part needs physical hardware and consenting people, so it
> cannot be automated or inferred.
>
> The parts that *can* be measured without people have been, on 2026-08-03 — see
> [Automated performance and concurrency results](#automated-performance-and-concurrency-results-2026-08-03)
> and [Adversarial and boundary suite](#adversarial-and-boundary-suite-2026-08-03) below.

## Automated performance and concurrency results (2026-08-03)

`pnpm bench:interviews`, on a local Postgres, against the spec's own targets. Each benchmark creates a
disposable database, applies the whole migration chain, seeds realistic volume, discards warm-up iterations
and reports query counts next to latencies so a change in *shape* shows up even when the wall clock does not.

| Benchmark | Metric | Target | Measured |
|---|---|---|---|
| `calendar-feed` | 31-day range read, p95 | < 500 ms | **2.7 ms** |
| `calendar-feed` | statements per read | flat, no N+1 | **4, flat** |
| `calendar-feed` | widest allowed span (400 days, 197 events) | no unbounded growth | **2.7 ms** |
| `scheduling-booking` | 14-day busy-range read, p95 | < 750 ms | **1.9 ms** |
| `scheduling-booking` | 8 concurrent bookers on one slot | zero double booking | **1 winner, 1 row** |
| `transcript-segments` | acknowledged segment persistence | ≥ 99.9% | **1800/1800 = 100%** |
| `transcript-segments` | replayed batches absorbed | no duplicates | **12 replays, 1800 rows** |
| `transcript-segments` | full 1800-segment transcript read | no unbounded growth | **2.6 ms** |

Latencies are three orders of magnitude inside their targets, which is worth reading correctly: it means
the targets are not currently the binding constraint, not that the queries are extraordinary. The numbers
that carry real information are the *shapes* — 4 statements per calendar read regardless of range, one
winner out of eight concurrent bookers, and 1800 persisted out of 1800 acknowledged with 12 redeliveries
absorbed.

Both benchmarks run as the migration role, so **RLS policy evaluation is not included in any number above**.
That is stated in each benchmark's own output too. It is a deliberate limitation: these measure query and
lock behaviour, and folding policy cost in would make a regression in either invisible.

### Four defects in the benchmarks themselves, found by running them

They had never executed. Written earlier against an assumed schema and never invoked, so each assumption
that was wrong stayed wrong:

1. **`pnpm bench:interviews` failed immediately** on a normal checkout — these are plain `node` scripts, so
   nothing loads `.env` for them the way dotenvx does for vite/vitest/playwright. The harness now falls back
   to reading `DATABASE_MIGRATION_URL` from `.env`, the same way `scripts/ci/local-quality.sh` does.
2. **Drizzle's migrator left the connection unable to serialize `Date`.** Running `migrate()` through the
   same postgres.js client made every later `${someDate}` arrive at `Buffer.byteLength` as a Date object and
   throw `ERR_INVALID_ARG_TYPE`. Reproduced in isolation — the identical insert succeeds on a fresh client
   and fails on a migrated one. The migrator now gets its own connection, which is the fix rather than
   stringifying 22 call sites and leaving the trap armed for the next benchmark.
3. **`availability_rules.time_zone` does not exist** — the column is `timezone`.
4. **`interview_sessions` was missing three NOT NULL columns** (`provider`, `consent_notice_version`,
   `capture_capability`), and `transcript_segments`' real unique index is on
   `(organization_id, session_id, provider_segment_id)`, not `(session_id, provider_segment_id)`, so the
   idempotent `ON CONFLICT` matched nothing.

## Adversarial and boundary suite (2026-08-03)

| Gate | Result |
|---|---|
| `pnpm security:boundaries` | **pass** — tenant boundary ratchet, 0 legacy imports tracked |
| `pnpm security:dependencies` | **pass** — `pnpm audit --prod --audit-level high` clean; 3 findings, all below the threshold (2 low, 1 moderate) |
| `pnpm test:rls:local` | see the completion-gate record below — runs inside `pnpm ci:local` against real per-role logins |
| Calendar / scheduling / documents / interview-live / interview-privacy / billing-credits e2e | **61 passing** |

Case coverage across the e2e suite, counted by grep so the number is checkable rather than asserted:
capability handling in 13 specs, replay in 14, tenant A/B in 5, CSRF in 2, and one each for EICAR, upload
polyglot and signed-URL leakage.

**Three of the listed cases have no spec under their own name**: prompt injection, SSRF, and stale
membership. They are named here rather than quietly counted as covered — the honest state is "not
demonstrably covered by a spec that says so", and a suite whose matrix is padded is worse than one with a
short list and an accurate one.

## Why this cannot be automated

- `getDisplayMedia` requires a human choosing a surface in a native picker. There is no headless path,
  and Chrome's `--auto-select-desktop-capture-source` flag bypasses the very dialog whose behaviour is
  under test.
- Diarization quality is a property of real overlapping speech. Synthetic audio separates cleanly and
  would certify a feature that fails on two people interrupting each other.
- Echo cancellation only matters when a speaker is playing the remote voice into the same room as the
  microphone. A loopback test has no room.
- The billing variance we care about is the difference between the provider's billed duration and the
  wall-clock length of a real conversation with pauses in it.

## Prerequisites

- `INTERVIEW_TRANSCRIPTION_ENABLED=true`, `DEEPGRAM_API_KEY` set, and `DEEPGRAM_BASE_URL` on the EU
  endpoint. The env schema refuses the combination if the base URL is not `api.eu.deepgram.com`.
- At least **180 credits** available on the test organization: a live session reserves the whole
  `interview_live_transcription` ceiling up front, and a short balance produces a 402 before capture
  starts rather than a partial session.
- A Pro or higher subscription. `checkEntitlement` refuses the feature below that tier, and the refusal
  is a 403, not a credit problem.
- Two participants who have **read and accepted the live-transcription notice**. Synthetic content is
  fine and preferred; the *consent* must be real, because a session runs against a real consent ledger
  row and there is no test bypass.

## Browser and platform matrix

Remote (two-channel) capture is gated in `src/modules/interviews/lib/audio-capture.ts`. The gate is
`detectCaptureSupport`, and these are the cells it produces. Verify each one shows the expected outcome
*before* any permission prompt appears — a prompt a user grants and then discovers was pointless is worse
than no prompt.

| Browser | Platform | Remote capture | In-person capture | What the organizer should see |
| --- | --- | --- | --- | --- |
| Chrome, current stable | macOS | Supported | Supported | Preflight with tab instructions |
| Chrome, previous stable | macOS | Supported | Supported | Preflight with tab instructions |
| Chrome, current stable | Windows | Supported | Supported | Preflight with tab instructions |
| Chrome, previous stable | Windows | Supported | Supported | Preflight with tab instructions |
| Chrome, older than `MINIMUM_SUPPORTED_CHROME_MAJOR` | macOS/Windows | Refused | Supported | "Use current or previous stable Chrome" |
| Chrome | Linux | Refused | Supported | "needs desktop Chrome on macOS or Windows" |
| Chrome | Android/iOS | Refused | Supported | "needs desktop Chrome on macOS or Windows" |
| Edge (current) | Windows | Refused | Supported | "Use current or previous stable Chrome" |
| Safari | macOS | Refused | Supported | "Use current or previous stable Chrome" |
| Firefox | any | Refused | Supported | "Use current or previous stable Chrome" |

Two things about this table are deliberate and should be confirmed rather than assumed:

**In-person is supported everywhere a microphone is.** Safari cannot share a tab's audio and records a
microphone in a room perfectly well. Refusing in-person there would remove a working feature.

**Edge is refused even though it is Chromium.** `identifyBrowser` matches the `"Google Chrome"` brand
specifically, not `"Chromium"`. Edge's display-capture picker and its `systemAudio` handling are not what
this feature verified, and admitting it on the grounds of shared engine would be certifying behaviour
nobody tested. Edge is a **beta candidate**: if it is to be supported, it needs its own row in the
results table below, not an assumption.

### `MINIMUM_SUPPORTED_CHROME_MAJOR` is a floor that must be raised

Code cannot know what today's current stable is. The constant lives in
`src/modules/interviews/lib/audio-capture.ts` and tracks *current minus one*. Raise it when Chrome
promotes a new stable, and re-run the matrix above for the two versions that then qualify. A floor left
alone drifts into admitting versions nobody verified; a floor raised without re-running the matrix
certifies nothing.

## Degradation for everything else

Every unsupported combination lands in **manual-only**: the interview runs, notes save, and nothing is
transcribed. What must *never* happen is microphone-only transcription of a remote call — a transcript
missing the candidate's half reads as complete and no reader can tell which half is absent.

| Situation | Behaviour | Where enforced |
| --- | --- | --- |
| Non-Chrome desktop browser | Manual-only, named in the preflight | `detectCaptureSupport` |
| Mobile browser | Manual-only | `detectCaptureSupport`, checked before the version |
| Tab shared without audio | Refused with the fix ("tick Also share tab audio") | `assertMeetingTab` |
| Window or screen shared | Refused, "pick the meeting tab" | `assertMeetingTab` |
| This tab shared | Refused | `assertMeetingTab` |
| Meeting stream loses its audio track | Manual-only, not one-channel | `createAudioMixer` |
| Credits exhausted mid-session | Transcription stops, interview continues, notes keep saving | `extendLiveReservation` returns a refusal rather than throwing |
| Provider unreachable after 5 retries | Manual-only, "Not transcribing" | `DeepgramLiveClient.onGaveUp` |
| Candidate withdraws consent | Capture stops; next grant refused | poll `stop_now`, then `assertTranscriptionAllowed` |

## Session procedure

Run **two** sessions of at least 30 minutes each, one per capture mode.

1. **Remote call.** Open a Meet, Zoom or Teams call in a separate tab with a second participant on
   another machine. Start the interview from the workspace, share the meeting tab *with audio*, and hold a
   conversation for 30 minutes including:
   - deliberate crosstalk (both speaking at once) at least three times,
   - a stretch of Spanish and a stretch of English,
   - background noise (typing, a fan, a street window),
   - one deliberate network interruption (disable Wi-Fi for ~20 seconds) to exercise reconnect,
   - one pause and resume,
   - a headphone/speaker swap and a microphone device change.
2. **In person.** One machine, one microphone, two people in a room. Same 30 minutes, same list, plus
   at least ten speaker corrections through the mapper.

Both sessions must **finish** through the workspace, not by closing the tab. A finish is what settles the
reservation, and an abandoned session is a different code path.

## Measurements to record

Record capability, never content. No transcript text, no candidate name, no audio — the point of this
exercise is whether the machinery works, and a verification artifact containing what someone said in a job
interview would be a worse privacy exposure than the feature it certifies.

- **Acknowledged final segments** as a percentage of finals the client produced. Target ≥ 99.9%. The
  outbox is what makes this achievable across the network interruption; a shortfall means segments were
  produced and never persisted.
- **Channel attribution correctness** for remote: the fraction of segments attributed to the right
  participant. This should be ~100% because it is deterministic from the channel, not a guess. Anything
  else means the mixer's channel assignment is wrong, which is a bug rather than a quality issue.
- **Diarization corrections** for in-person: how many segments needed relabelling.
- **Billing variance**: `provider_billed_seconds` against the wall-clock duration. A large positive
  variance means we are billing for silence; a negative one means the provider undercounted.
- **Withdrawal stop latency**: seconds from the candidate withdrawing to capture stopping. Must be
  ≤ 10 seconds. Measure it twice — once with a cooperating client, once with the poll blocked in devtools,
  which is the case the 30-second grant TTL bounds.
- **Cleanup**: after finishing, confirm no microphone or screen-share indicator remains in the tab, the
  `AudioContext` is closed, and no socket is open.
- **Reconnect count and gap**: how many reconnects occurred and how much audio was lost across each.

### Artifact inspection

After each session, with DevTools open:

- **Network**: no request carries an audio body. The only binary traffic is the WebSocket frames to
  `api.eu.deepgram.com`.
- **Application → IndexedDB**: `builderhunt-transcript-outbox` is **empty** after a successful finish. A
  non-empty store means segments were never acknowledged.
- **Memory heap snapshot**: no `Blob`, no `MediaRecorder`, no object URL. The unit suite asserts these are
  absent from the source; this confirms nothing at runtime created one.
- **`chrome://media-internals`**: no video frames delivered after capture started. The display video track
  is stopped before the socket opens.

## Recording results

Fill this in per execution. An empty row is more useful than a guessed one — the whole purpose of this
document is that these numbers came from a real machine.

### Session log

| Date | Mode | Browser / version | OS | Duration | Finals acknowledged | Attribution correct | Corrections | Billed vs wall-clock | Withdrawal latency | Reconnects | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| _pending_ | remote_call | | | | | | | | | | |
| _pending_ | in_person | | | | | | | | | | |

### Artifact inspection log

| Date | No audio in network | Outbox empty after finish | No Blob/MediaRecorder in heap | No video frames | Indicators cleared |
| --- | --- | --- | --- | --- | --- |
| _pending_ | | | | | |

### Failures found

| Date | Browser | What failed | Cause | Fix |
| --- | --- | --- | --- | --- |
| _pending_ | | | | |

## Sign-off criteria

The feature is verified for beta when **all** of these hold, from the tables above rather than from
inference:

- [ ] Both 30-minute sessions finished cleanly, including the reconnect and the pause/resume.
- [ ] ≥ 99.9% of final segments acknowledged in both sessions.
- [ ] Remote channel attribution correct for every segment.
- [ ] Billing variance understood and within one minute of wall-clock, minus pauses.
- [ ] Withdrawal stopped capture within ten seconds, including with the poll blocked.
- [ ] Artifact inspection clean on both sessions.
- [ ] Every refused row in the matrix showed the expected message *before* any permission prompt.
- [ ] `MINIMUM_SUPPORTED_CHROME_MAJOR` matches current stable minus one on the day of sign-off.

## Backup and restore posture

Recorded 2026-07-28, from a real rehearsal against two disposable databases.

`pnpm db:restore-test` now covers the fifteen interview tables in its RLS manifest, on top of the billing and
workspace tables it already checked. A restore that lost a policy would otherwise present a candidate's
transcript to anyone holding a connection — which is the failure a rehearsal exists to catch before an
incident does.

Two audio assertions were added, and they are honest about what they are:

- **No audio-shaped column** in any `interview*`, `candidate*` or `transcript*` table of the *restored*
  database. Asserted against the restore rather than the schema because `pg_restore` recreates whatever the
  dump held: a dump taken before an audio column was removed would bring it back, and the feature's central
  promise is not a promise if it is only true in the current migration. Proved by planting
  `transcript_segments.recording_object_key` into a source database and confirming the rehearsal fails.
- **No document row pointing at an audio object.** This one is a **backstop that cannot fire against a current
  schema** — `candidate_documents_no_audio_check` refuses an `audio/*` media type at insert time, so the seed
  for this test had to drop that constraint first. Kept because the case it covers is precisely a
  pre-constraint dump; recorded as a backstop rather than presented as a proven guard.

Measured result: `{"restored":true,"migrations":94,"rlsMissing":0,"audioColumns":0,"audioObjectKeys":0}`.

### R2 lifecycle and backup posture

Object storage is **not** covered by the database rehearsal and is not backed up as a snapshot. That is
deliberate rather than an omission:

- The only objects are candidate documents under `quarantine/` and `clean/`, and every one is deleted by the
  retention sweep at 180 days.
- A backup of that bucket would be a second copy of candidate CVs with its own retention, its own access list
  and its own deletion path — the thing the retention promise exists to prevent. Restoring it would resurrect
  documents a candidate was told were gone.
- The recovery position for a lost object is therefore: the document row is retained, every download 404s, and
  the candidate is asked to re-upload. That is a worse product day and a better privacy posture, and it is the
  same trade the `document-worker`'s move-before-mark ordering already makes.
- **No audio exists to back up.** There is no bucket, no key prefix and no code path that writes one.

## RESOLVED — the app role cannot reserve credits (found 2026-07-28, fixed by drizzle/0098; re-verified 2026-08-03)

**This is no longer open, and the section below is kept only for its reasoning.** The fix landed as
`drizzle/0098_credit_write_role_membership.sql` plus `src/shared/lib/billing/credit-write-role.ts`, and it is
verified as the real roles on every `pnpm ci:local` run.

### What shipped, and why it is better than what this section prescribed

The note below predicted "a change across `feature-authorization.ts`, `reservations.ts` and every caller of
`withInterviewCredits`", moving the ledger write into a separate worker-role transaction. That would have been
the wrong shape twice over, and the fix that landed avoids both problems:

**It does not move the transaction.** `withCreditWriteRole` issues `SET LOCAL ROLE builderhunt_worker` *inside
the caller's own transaction*, around the credit write and nothing else. So the property this codebase
documents in `src/modules/interviews/billing.ts` — "a route that lets the error escape its own transaction
rolls the reservation back wholesale" — is **preserved**, not traded away. A separate connection would have
left an orphaned reservation eating a customer's balance whenever the session transition that follows it
failed.

**It does not widen read scope, and that mattered more than it looked.** A blanket route-level swap would have
run the whole request as the worker role, and `interview_briefs_worker_all` (drizzle/0091) is
`USING (true) WITH CHECK (true)` — completely unscoped. The participant-scoped read
(`p.user_id = current_setting('app.user_id')`) would not have become organization-wide; it would have become
**cross-tenant**. Because the elevation supplies only the *verb*, `app.organization_id` and `app.user_id` stay
set throughout, 0028's worker policies on the credit tables still filter on the organization, and `reset role`
restores the app role for the rest of the transaction.

`drizzle/0098` grants **membership** (`GRANT builderhunt_worker TO builderhunt_app`), not table privileges.
Membership is inert until claimed, so the app role still cannot write by default and every claim is one
greppable call rather than an invisible privilege every future query inherits.

All five credit operations go through it: `reserveCredits`, `extendReservation`, `settleReservation`,
`releaseReservation` (`feature-authorization.ts:168, 237, 263, 285`).

### The evidence, as the real roles

Two independent sources, both inside `pnpm ci:local`:

**`scripts/db/verify-rls-local.mjs`** connects as an actual `builderhunt_app` login and asserts four things —
this is a permanent negative control, not a one-off check:

1. an **unelevated** insert into `billing_credit_reservations` is refused with **42501**, failing loudly with
   "0028's SELECT-only grant is gone" if it ever succeeds;
2. an **elevated** insert lands exactly one row;
3. after `reset role`, `has_table_privilege('billing_credit_reservations', 'INSERT')` is **false** — the
   elevation does not leak into the rest of the transaction;
4. an elevated insert naming **another organization** is still refused with 42501 — "elevating to the worker
   role let the app write another organization's credits".

**`tests/e2e/billing-credits.spec.ts`**, "going live reserves the ceiling, and finishing settles it back
down", drives the product path end to end against a worker database whose URL the harness `forceRole`s to
`builderhunt_app`: `action: 'live'` reserves the rate card's 180-unit ceiling, the reservation row is
observable as `reserved` with `maximum_units = 180`, the balance drops by 180, and `finish` with 12 billed
minutes settles to 12 and returns 168. A reservation that could not be written would fail at the first step.

**The link between the two, proven by negative control on 2026-08-03.** Those two checks are individually
insufficient in a way worth stating: `verify-rls-local.mjs` executes raw SQL, so it would stay green if someone
deleted `withCreditWriteRole` from `feature-authorization.ts` — it proves the *mechanism*, not that the product
uses it. So the elevation was removed from `reserveCredits` and the e2e re-run: `action: 'live'` answered
**500**, with `permission denied for table billing_credit_reservations`, code **42501**, in the server log.
Restored immediately; that file's diff is empty. The e2e test is therefore the assertion that keeps the product
path wired to the mechanism, and it is measuring the real defect rather than passing for an unrelated reason.

### What is still true from the note below

`SENSITIVE_AI_ENABLED` and `INTERVIEW_TRANSCRIPTION_ENABLED` remain `false` in production — but that is now
the **AI Act sign-off gate alone**, which is a product and legal decision, not this defect. The database side
is done.

*Original note, kept because the reasoning is what made the fix findable:*

`DATABASE_URL` in `.env.production.example` is `builderhunt_app`. That role holds **SELECT only** on
`billing_credit_reservations`, `billing_credit_grants` and `billing_credit_allocations` (drizzle/0028,
deliberately: the app reads balances, the worker settles). `reserveCredits` and `settleReservation` run
on the caller's *tenant* transaction — the app role — so on deploy every interview operation that
reserves credits fails with a `500`:

- `POST /api/interviews/:id/session` with `action: 'live'` (reserves 180 units for transcription),
- `POST /api/interviews/:id/brief` and `/report` once `SENSITIVE_AI_ENABLED=true`,
- every settlement on `finish`.

### Why nothing caught it

The local `DATABASE_URL` names the `postgres` superuser, which bypasses RLS *and* every grant. So the
authenticated half of the product has never run under the role it will run under in production —
neither in development, nor in the E2E suite, whose harness passed that URL through unchanged. The
harness now forces `builderhunt_app` (`tests/e2e/harness/database.ts`, `forceRole`), which is what
surfaced this; `tests/e2e/interview-live.spec.ts`, `billing-credits.spec.ts` and
`interview-privacy.spec.ts` fail on it today and are the reproduction.

> Those three specs all pass as of 2026-08-03 — 27 tests between them. Same reproduction, answering the other
> way now that the elevation is in place.

### The fix is not a grant

`GRANT INSERT, UPDATE ON billing_credit_reservations TO builderhunt_app` would make the tests pass and
would hand every request-scoped connection the ability to mint and settle credit — undoing the
separation 0028 chose on purpose, and the same mistake 0078 exists to prevent on the capability side
("Capability writes go through a narrowly privileged server command, never anonymous SQL grants").

The correct shape is the one the candidate-document path already uses: authorize on the app
transaction, then perform the ledger write through a worker-role transaction
(`withWorkerOrganization`). That is a change across `feature-authorization.ts`, `reservations.ts` and
every caller of `withInterviewCredits`, and it is not done.

**Until it is, no interview AI feature may be enabled in production.** `SENSITIVE_AI_ENABLED` and
`INTERVIEW_TRANSCRIPTION_ENABLED` must stay `false`, which is also where the AI Act sign-off gate
leaves them.

> **Superseded.** The paragraph above is the only part of this note that is now wrong in substance, and it is
> worth saying why rather than deleting it: it assumed the correct shape was a worker-role *transaction*, and
> concluded the change was large. `SET LOCAL ROLE` inside the caller's transaction is the smaller and safer
> answer — it borrows the verb without moving the boundary or widening the scope — so the change was five call
> sites and one new module rather than a rework of every `withInterviewCredits` caller. The flags stay `false`
> for the AI Act sign-off, which was always a separate gate.
