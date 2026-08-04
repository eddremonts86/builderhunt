# DPIA — interview transcription and AI report generation *(DRAFT)*

> **This is a draft for review, not a completed assessment, and it is not legal advice.** It was written by
> assembling verified facts from this repository and
> [`interview-provider-register.md`](./interview-provider-register.md) into the structure GDPR Article 35
> expects, so that the maintainer and a data-protection advisor have something concrete to argue with instead
> of a blank page. **Every risk rating below is a proposal.** The advisor's judgement replaces it.
>
> **Two facts recorded in the register make part of this assessment unsignable today**, and they are flagged in
> place rather than smoothed over:
>
> 1. **Deepgram has provided no written no-training/no-retention statement.** The register says the product
>    owner accepted it on 2026-07-26 *without one*: nothing was obtained from the vendor, their public
>    compliance page is silent on retention and training, and the console exposes no such setting. §6.2 below
>    depends on a control that does not exist in evidence.
> 2. **Mistral Zero Data Retention is pending** — not self-serve, a support request.
>
> Until both exist in writing, §6 describes intended controls, not verified ones. Article 35(7)(d) asks for
> "the measures envisaged"; measures that rest on an unevidenced vendor claim should be described as exactly
> that.
>
> **Scope of this document**: production **voice** processing — live transcription of interviews and AI
> generation of briefs and reports. Storage (MinIO) and virus scanning (ClamAV) are first-party and in scope
> only as sub-systems. The billing platform's Stripe processing has its own register and is out of scope.

---

## 1. Why a DPIA is required

Article 35(3) triggers, assessed against what this feature actually does:

| Trigger | Applies? | Why |
| --- | --- | --- |
| Systematic and extensive **automated evaluation** of personal aspects, including profiling | **Yes** | AI generates an interview *report* about a candidate. Even though a human reads and decides, the output is an automated evaluation of a person's suitability. |
| Processing on a **large scale** | **Not yet, and this matters** | Production holds 12 builder records and 6 accounts. This is pre-launch. A DPIA is still required by the first trigger, and doing it now — while the population is effectively zero — is the cheap moment. |
| **Special category** data (Art. 9) | **Not by design, unavoidably in practice** | An interview is unstructured speech. Nobody asks about health, religion, union membership or ethnicity, but candidates volunteer such things, and a verbatim transcript captures whatever was said. This is the sharpest risk in the document and §5.1 treats it as such. |
| Systematic monitoring of a publicly accessible area | No | Nothing here observes public space. |

**Conclusion**: a DPIA is required, driven by automated evaluation and by the practical certainty that
transcripts will contain special-category data nobody intended to collect.

---

## 2. The processing, described

### 2.1 Purposes

1. Transcribe a job interview so the interviewer can attend to the conversation rather than to note-taking.
2. Generate a structured *brief* before the interview from material the candidate supplied.
3. Generate a structured *report* after it, grounded in the transcript.

### 2.2 Data subjects

- **Candidates** — the primary subjects, and the ones with the least power in the relationship. Most will not
  have an account: the scheduling flow is deliberately accountless (`builderhunt_capability`, `drizzle/0078`).
- **Interviewers** — organization members. Their speech is in the same transcript.

### 2.3 Categories of personal data

Traced to real tables rather than described in the abstract:

| Category | Where | Notes |
| --- | --- | --- |
| Identity and contact details | `candidate_submissions` | Supplied by the candidate for the booking. |
| Documents (CV, portfolio, work samples) | `candidate_documents` (MinIO objects) | Uploaded by the candidate. Virus-scanned before storage. |
| Links the candidate declares | `candidate_links`, `candidate_web_imports` | Self-declared. |
| **Interview audio** | streamed to Deepgram; **not stored by us** | See §6.1 — non-storage is a design decision, and the strongest control in this document. |
| **Verbatim transcript** | `transcript_segments` | The special-category exposure. |
| AI-generated brief and report | `interview_briefs`, `interview_reports` | Automated evaluation output. |
| Consent records | `user_consents`, submission consent fields | Retained longer than the data they authorise, on purpose — see §4. |
| Session metadata | `interview_sessions`, `interview_suggestions` | Timing, participants, generated prompts. |

### 2.4 Recipients and international transfers

| Recipient | Role | Location | Basis |
| --- | --- | --- | --- |
| **Deepgram** | Processor — transcription | **EU endpoint verified against this account**: `api.eu.deepgram.com/v1/listen` returns 200 with `nova-3`, `diarize` and `multichannel` accepted | US-incorporated. DPA **not yet signed** (register §3). A third-country transfer, and one of only two. |
| **Mistral (La Plateforme)** | Processor — brief/report generation | EU by default; the US endpoint is an explicit opt-in nobody has taken | French entity, which is why it replaced Azure. |
| **MinIO** | First-party storage | The project's own VPS | Not a processor — same controller. |
| **ClamAV** | First-party scanning | Same VPS | Not a processor. |

**Two third-country transfers, both minimisable, neither eliminated.** The register records that choosing a
French provider for the AI half was partly *in order to* remove one from this list.

> **Azure OpenAI is retained as a documented fallback and must not be enabled without revisiting this
> document.** The register's finding is that `env.ts` validates an Azure *resource region* but cannot see the
> *deployment type*, so a Global Standard deployment passes validation while processing outside the EU. That is
> a residency hole the code structurally cannot close, and it would change §2.4 materially.

---

## 3. Lawful basis, and why consent is the wrong one to lean on

**Proposed basis: explicit consent (Art. 6(1)(a)), with Art. 9(2)(a) for whatever special-category data the
speech contains.**

The uncomfortable part, stated because a DPIA that flatters itself is useless: **a candidate's consent to being
recorded in a hiring conversation is not freely given in any strong sense.** They want the job. Refusing feels
costly even when it is not. Article 4(11) requires freely given consent, and Recital 43 warns about imbalance
of power.

Two things follow, and they are design requirements rather than wording changes:

1. **Refusing must be genuinely costless and visibly so.** The interview must proceed without transcription
   when consent is withheld, and the candidate must be told that in the same breath as the request — not in a
   policy they will not read.
2. **Withdrawal must work after the fact**, because consent given under mild pressure is exactly the consent
   most likely to be regretted. Deletion on withdrawal must be real, not a flag.

**For the advisor**: is consent even the right basis, or is legitimate interest (Art. 6(1)(f)) more honest for
the transcript, with consent reserved for the AI evaluation? I do not know, and the register already lists
"legal review of consent basis + retention" as an open item with a named owner.

---

## 4. Necessity, proportionality, and retention

Retention ceilings are enforced in code, not merely documented — `env.ts`, with `max()` bounds so a
misconfiguration cannot exceed them:

| Data | Default | Hard ceiling | Constant |
| --- | --- | --- | --- |
| Transcripts | 90 days | 90 days | `INTERVIEW_TRANSCRIPT_RETENTION_DAYS` |
| Candidate documents | 180 days | 180 days | `INTERVIEW_DOCUMENT_RETENTION_DAYS` |
| Consent records | 24 months | 24 months | `INTERVIEW_CONSENT_RETENTION_MONTHS` |

Organizations may choose *shorter* periods; these are the operator-wide ceiling a retention worker enforces.

**Consent records outlive the data they authorise, deliberately.** Keeping proof of consent for 24 months after
a 90-day transcript is gone looks contradictory but is the correct shape: the record exists to demonstrate
lawfulness under Art. 5(2), and destroying it with the data would destroy the evidence that processing was
lawful. Worth stating explicitly so a reviewer does not read it as an inconsistency.

**Proportionality argument**: the alternative to transcription is an interviewer's own notes — less accurate,
equally personal, unretained and unauditable. A transcript with a 90-day ceiling, a deletion path and no audio
retained is arguably *more* protective than the status quo it replaces. That is the case to make; the advisor
should test it.

---

## 5. Risks to data subjects

Rated as proposals. **Likelihood × Severity**, from the subject's perspective, not the operator's.

### 5.1 Special-category data captured incidentally — **HIGH**

A candidate mentions a disability, a pregnancy, a religious observance, a union role. Verbatim transcription
captures it, and it lands in a table alongside an AI-generated evaluation.

- **Likelihood: high.** Not an edge case. Over any real number of interviews it approaches certainty.
- **Severity: high.** It could inform a hiring decision unlawfully, and it persists for up to 90 days in a
  system the candidate cannot see.
- **Nothing in the current design detects or redacts this.** That is the honest position. Mitigations in §6.3
  are procedural, which is weaker than technical.

### 5.2 Automated evaluation influencing a decision about a person — **MEDIUM**

The report is generated, a human decides. But an AI-written summary anchors a reader, and "the report said
they were weak on system design" is hard to un-read.

- Art. 22 does not strictly bite while a human decides substantively, but the *appearance* of automation is
  itself a fairness problem, and the register's grounding requirement (reports cite the transcript) is the
  control that keeps it reviewable.

### 5.3 Third-country transfer without a signed DPA — **HIGH, and currently unmitigated**

Audio is streamed to Deepgram, a US company, with **no DPA signed** (register §3). This is not a residual
risk; it is a gap.

### 5.4 An unevidenced no-retention claim made to candidates — **HIGH**

If the consent text tells candidates their audio is not retained or used for training, and no vendor statement
supports that, the statement is unverified. The register says so plainly. Either obtain the statement or change
what is claimed.

### 5.5 Candidate cannot exercise rights easily — **MEDIUM**

Most candidates have no account by design. Access, rectification and erasure must work for someone holding
only a capability link. The accountless flow exists; whether the *rights* path does, at the same level of
polish, is worth verifying rather than assuming.

### 5.6 Interviewer speech processed without a comparable consent moment — **LOW–MEDIUM**

The transcript contains both voices. Interviewers are told; whether they consent as individuals or merely as
employees is a question the advisor should settle.

---

## 6. Measures — and which of them actually exist

### 6.1 Verified, in code

- **Audio is never stored by us.** It is streamed for transcription and discarded. The most valuable control
  here, and it is structural rather than procedural.
- **Retention ceilings enforced by `env.ts` bounds**, not by policy prose (§4).
- **Every provider can be disabled independently**, verified by reading the code: `CANDIDATE_UPLOADS_ENABLED`,
  `SENSITIVE_AI_ENABLED`, `INTERVIEW_TRANSCRIPTION_ENABLED`, `INTERVIEW_CONTEXTUAL_QUESTIONS_ENABLED`, and
  four routes answer `503` when their flag is off.
- **Row-level security with `FORCE`**, so one organization cannot read another's interview data even through a
  bug in the query layer — and a tenant A/B check as the real application role is part of the gate.
- **EU endpoints confirmed against the real accounts**, not vendor marketing (register §3, §4).
- **Documents virus-scanned before storage** (ClamAV), which the register argues cannot be skipped.
- **Voice is off in production today**: `INTERVIEW_TRANSCRIPTION_ENABLED=false`.

### 6.2 Intended, not yet evidenced

- Deepgram DPA — **not signed**.
- Deepgram no-training/no-retention statement — **does not exist**; currently an accepted assumption.
- Mistral Zero Data Retention — **pending a support request**.

**Nothing in §6.2 should be described to a candidate as a protection until it exists.**

### 6.3 Proposed, procedural, and weaker than I would like

For §5.1, the special-category problem, no technical control is in place. Options for the advisor to choose
between:

1. **Interviewer guidance** — cheap, unreliable.
2. **Shorten the transcript ceiling** for interviews flagged as sensitive — mechanical, and the ceiling
   already exists to lower.
3. **Redaction pass over transcripts** before the AI report is generated — technically real, and it would need
   building. Detecting special-category disclosure automatically is itself error-prone.
4. **Do not generate reports from raw transcripts at all** — generate from interviewer-selected excerpts. The
   most protective, and the biggest product change.

I have no basis for choosing. Option 4 is the one I would want defended against on product grounds.

---

## 7. Conclusion, and what it is contingent on

**Proposed conclusion: the processing can proceed with residual risk acceptable to the controller, once
§6.2 is closed and §6.3 has an owner and a decision.** Voice is disabled in production today, so nothing is
at risk while these are settled.

**It cannot be signed today.** Two vendor statements do not exist, one DPA is unsigned, and the highest-rated
risk has only procedural mitigations. Draft request texts for both vendors are in
[`interview-vendor-requests.md`](./interview-vendor-requests.md) so the two support tickets are a copy-paste
rather than a writing task.

---

## 8. Sign-off

| Role | Name | Date | Notes |
| --- | --- | --- | --- |
| Controller / product owner | _(Edd)_ | | |
| Data-protection advisor | _(pending — not engaged)_ | | Article 35(2) advice; this draft is the input, not the assessment |
| Reviewer of the provider register | _(pending)_ | | Register §"Gates general availability only" |

**Review cadence**: annually, and on any change to §2.4 — a new processor, a region change, or enabling the
Azure fallback, which the register shows `env.ts` cannot validate safely.

---

*Draft assembled 2026-08-04 from `interview-provider-register.md`, `env.ts` retention constants, the
`candidate_*` / `interview_*` / `transcript_segments` schema, and the provider flag/503 behaviour in
`src/routes/api/interviews/`. Not legal advice. Facts are cited so each can be checked; risk ratings are
opinions and should be overwritten.*
