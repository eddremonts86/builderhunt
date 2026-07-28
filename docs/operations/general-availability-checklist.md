# General-availability checklist

Things that must be true before BuilderHunt opens to the general public, and that are deliberately
**not** development, MVP or pilot blockers.

This file exists because the distinction kept getting lost. Requirements that gate a public launch
were written into task `Verify:` lines, where they stalled work they had no bearing on — a legal
countersignature was, for a while, a precondition for writing a storage adapter against a container
running on a developer's own laptop. Moving them here is not a way of forgetting them; it is a way
of stating plainly *when* they apply.

**The rule:** nothing in `plans/phase-1/*` may name an item on this list as a dependency. If a task
cannot be finished without one, either the item belongs in a different section of
`docs/operations/interview-provider-register.md` (which splits gates by what they actually block),
or the task is scoped wrong.

**What makes this safe rather than a shortcut:** every item below is a *countersignature or review
of a decision already made and already implemented conservatively*. Retention windows, consent
capture, fail-closed defaults and data-residency validation are enforced in code today and covered
by tests. What is deferred is human approval of those choices, not the choices themselves. If a
review later demands a change, the change is a code change — which is exactly the position you want
to be in, rather than holding the code hostage to the review.

---

## Deferred by product-owner decision, 2026-07-28

| Item | Who | Why it is not a development blocker |
| --- | --- | --- |
| **Security/privacy reviewer sign-off** on `interview-provider-register.md` | A named human | `spec.md` asks a reviewer to sign the register once accounts exist. The signature records agreement with provider choices; it does not alter them. Neither obtainable soon nor load-bearing for building. |
| **Legal review of consent basis and retention** | Legal advisor | Covers the consent wording and the 90-day transcript / 180-day document / 24-month consent retention windows. All three are implemented and enforced; the copy describing them is written from what the system does. A review has something concrete to react to precisely because the work did not wait for it. |

## Still gates production use with real people's data

Listed here so the split is visible in one place. These are **not** deferred — see the register for
the authoritative version.

| Item | Gates |
| --- | --- |
| **DPIA** | Production voice capture. Narrower than first scoped: storage and virus scanning are first-party, so only Deepgram and Mistral are third-country transfers. |
| **Deepgram no-training/no-retention written statement** | `INTERVIEW_TRANSCRIPTION_ENABLED` in production. The claim currently made to candidates has no vendor statement behind it. |
| **Mistral Zero Data Retention** | `SENSITIVE_AI_ENABLED` in production. A support request, not a self-serve toggle. |
| ~~Off-box backup replication~~ | ✅ Already done since 2026-07-26 — `builderhunt-backup-sync.sh` rsyncs the MinIO volume to a Hetzner Storage Box nightly, which snapshots it at 05:00. Listed here in error; verified 2026-07-28. |

## Before flipping any of the interview flags

Mechanical, and none of it needs a third party:

- [ ] MinIO and ClamAV deployed, with the deployment target and image digests recorded in the register.
- [ ] A MinIO service account scoped to the one bucket — never the root credentials.
- [x] Off-box document backup — already running (`builderhunt-backup-sync.sh`, 03:30 UTC).
- [ ] One restore of the document volume actually rehearsed. The database restore has been; this one
      has not. A backup nobody has restored from is a hypothesis.
- [ ] `INTERVIEW_CLAMAV_HOST` reachable and `clamd` answering, verified with the EICAR string rather
      than a port check — a scanner that starts but never detects returns a clean verdict, which is
      worse than no scanner.
