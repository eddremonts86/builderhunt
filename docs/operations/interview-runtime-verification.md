# Interview runtime verification

Live interview capture is the only feature in this product that depends on browser behaviour we cannot
test in CI: a real microphone, a real tab share, and two people talking. Everything the automated suite
covers is *our* code — the constraints we pass, the graph we build, the messages we parse. What it cannot
cover is whether Chrome on a particular machine actually delivers two channels of usable audio when
someone ticks "Also share tab audio".

This document is the procedure for finding that out, and the register of what was found.

> **Status: not yet executed.** The runbook below is complete; no session has been run. The results
> tables are empty on purpose — see [Recording results](#recording-results). Running this needs physical
> hardware and consenting human participants, so it cannot be automated or inferred.

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
