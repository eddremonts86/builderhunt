# Interview Intelligence — Provider Account & Credential Register

> Companion to [`src/shared/lib/env.ts`](../../src/shared/lib/env.ts) (the compile-time
> enforcement point — production boot **fails closed** if a flag is on and its provider config is
> missing or non-EU) and
> [`plans/phase-1/calendar-scheduling-interview-intelligence/spec.md`](../../plans/phase-1/calendar-scheduling-interview-intelligence/spec.md).
>
> **Status: NOT PROVISIONED.** No account below exists yet. This document is the shopping list —
> work top to bottom, and fill in the "Recorded" fields as you go. Every provider can be enabled
> independently; nothing here blocks the calendar/scheduling work that is already shipping.
>
> **Never commit a secret value to this file or to git.** This register records account identity,
> region, DPA status, and owner — never keys. Secrets go into Coolify environment variables only.

---

## Why each of these is needed

The interview feature is four independent capabilities behind four independent kill switches. You
only need the credentials for the ones you actually want to turn on:

| Capability | Flag | Providers needed | Unblocks |
| --- | --- | --- | --- |
| Candidate uploads a CV | `CANDIDATE_UPLOADS_ENABLED` | Cloudflare R2 + ClamAV | Phase 6 (8 tasks) |
| AI-generated brief & report | `SENSITIVE_AI_ENABLED` | Azure OpenAI | Phases 8, 10 (10 tasks) |
| Live interview transcription | `INTERVIEW_TRANSCRIPTION_ENABLED` | Deepgram | Phase 9 (8 tasks) |
| Public-web candidate link import | `CANDIDATE_WEB_IMPORT_ENABLED` | *(none — reuses the existing enrichment fetch pipeline)* | part of Phase 6 |

Calendar, scheduling, invitations, and atomic booking need **none** of these.

---

## 1. Cloudflare R2 — candidate document storage

**Priority: highest.** Blocks the most tasks and is the cheapest/fastest to set up.

### What to create

1. A Cloudflare account (free tier is fine to start; R2 has a generous free allowance).
2. An R2 bucket with these exact properties:
   - **Jurisdiction: EU.** This is chosen at bucket-creation time and **cannot be changed
     afterwards** — a non-EU bucket means deleting and recreating it. In the Cloudflare dashboard
     this is the "Location" / "Jurisdiction" selector; pick **European Union**.
   - **Access: private.** No public bucket URL, no custom public domain, no `r2.dev` subdomain.
   - **Storage class: Standard.**
   - Suggested name: `builderhunt-interview-documents`
3. An R2 API token scoped to **that one bucket only**, with Object Read & Write. Not an
   account-wide token.

### Why the EU constraint is enforced in code

`env.ts` rejects any `INTERVIEW_R2_ENDPOINT` that does not resolve to
`*.eu.r2.cloudflarestorage.com` when `CANDIDATE_UPLOADS_ENABLED=true` in production. A
non-EU-jurisdiction bucket has a different endpoint host and will refuse to boot. This is
deliberate: candidate CVs are personal data and the whole privacy posture in `spec.md` assumes EU
residency.

### Environment variables to set

```
INTERVIEW_R2_ENDPOINT=https://<account-id>.eu.r2.cloudflarestorage.com
INTERVIEW_R2_ACCOUNT_ID=<account-id>
INTERVIEW_R2_BUCKET=builderhunt-interview-documents
INTERVIEW_R2_ACCESS_KEY_ID=<token access key id>
INTERVIEW_R2_SECRET_ACCESS_KEY=<token secret>
INTERVIEW_R2_JURISDICTION=eu
```

### Recorded

- **Account owner**: _(not yet provisioned)_
- **Account ID**: _(not yet provisioned)_
- **Bucket name / jurisdiction**: _(not yet provisioned)_
- **DPA**: Cloudflare's DPA is incorporated by reference in their standard Terms — record the
  version and acceptance date here once the account exists.
- **Sub-processor list URL**: https://www.cloudflare.com/cloudflare-customer-suppliers/
- **Deletion API**: yes (S3 `DeleteObject`) — the retention worker uses it.
- **Annual review date**: _(set to provisioning date + 1 year)_

---

## 2. ClamAV — virus scanning

**Priority: highest** (paired with R2 — uploads do not work without both).

Not a SaaS account: ClamAV is open-source and self-hosted. Given the existing "no paid services"
deployment posture, the intended shape is a container alongside the app in Coolify.

### What to create

Add a `clamav` service to the Coolify project using the official image
`clamav/clamav:stable`, exposing TCP port **3310** on the internal network only (never
public). Give it ~1.5 GB RAM — the signature database is large and it OOMs below that.

The first boot downloads signatures and takes several minutes; the app should not be pointed at it
until `clamdscan --ping` succeeds.

### Environment variables to set

```
INTERVIEW_CLAMAV_HOST=clamav          # the Coolify internal service hostname
INTERVIEW_CLAMAV_PORT=3310
```

### Recorded

- **Deployment target**: _(not yet provisioned)_
- **Image + tag**: `clamav/clamav:stable` (pin the digest once deployed)
- **Signature auto-update**: built into the image (freshclam runs in-container)
- **Annual review date**: n/a (self-hosted, no vendor) — but do track the image update cadence.

### Why this is non-negotiable

`spec.md` requires every uploaded object to be streamed through ClamAV **before** it moves from
the quarantine prefix to the clean prefix. There is no "scan later" path and no way to skip it —
the document state machine has no transition from `uploaded` to `ready` that bypasses `scanning`.

---

## 3. Deepgram — live transcription

**Priority: medium.** Only needed for the live-audio capability.

### What to create

1. A Deepgram account.
2. An API key.
3. **Confirm EU endpoint availability for your plan.** This is the risk item: the code hard-codes
   `wss://api.eu.deepgram.com` and `env.ts` refuses to boot with any other base URL when
   transcription is enabled. If the EU endpoint turns out to require an enterprise plan on your
   account, tell me — that is a real product decision (pay for it, pick a different provider, or
   ship manual-notes-only), not something I should quietly work around.
4. Confirm in writing (support ticket or contract) that audio is **not retained** and **not used
   for training**. `spec.md` states plainly to the candidate that no audio is stored; we need the
   provider's confirmation to stand behind that sentence.

### Environment variables to set

```
DEEPGRAM_API_KEY=<key>
DEEPGRAM_BASE_URL=https://api.eu.deepgram.com   # already the default; do not override
```

### Recorded

- **Account owner**: _(not yet provisioned)_
- **Plan / EU endpoint confirmed**: _(not yet provisioned)_ ⚠️ verify before committing to Phase 9
- **DPA signed**: _(not yet provisioned)_
- **No-training confirmation**: _(not yet provisioned)_ — attach the ticket/contract reference
- **Model**: `nova-3` (multichannel for remote calls, diarization for in-person)
- **Deletion API**: n/a — nothing is stored provider-side
- **Annual review date**: _(set to provisioning date + 1 year)_

---

## 4. Azure OpenAI — brief and report generation

**Priority: medium.** Only needed for the AI brief/report capability.

### What to create

1. An Azure subscription.
2. **Request Azure OpenAI access** — this is an application form with a review, not instant
   self-serve. Budget several business days. Start this one early even if you do the others later.
3. An Azure OpenAI resource in an **EU region**. `env.ts` accepts only these:
   `westeurope`, `northeurope`, `francecentral`, `germanywestcentral`, `swedencentral`,
   `switzerlandnorth`.
4. A model deployment inside that resource (GPT-4-class). Note the deployment *name* — that is
   what goes in the env var, not the model name.
5. Opt out of abuse-monitoring human review if you want the strongest no-human-sees-candidate-data
   position — this is a separate Azure form ("Modified Abuse Monitoring").

### Environment variables to set

```
AZURE_OPENAI_ENDPOINT=https://<resource>.<region>.api.cognitive.microsoft.com
AZURE_OPENAI_API_KEY=<key>
AZURE_OPENAI_DEPLOYMENT=<your deployment name>
AZURE_OPENAI_API_VERSION=2024-08-01-preview
```

### Recorded

- **Subscription / tenant**: _(not yet provisioned)_
- **Access application approved**: _(not yet provisioned)_
- **Region**: _(not yet provisioned — must be one of the six above)_
- **Deployment name + model**: _(not yet provisioned)_
- **DPA**: covered by the Microsoft Products and Services Data Protection Addendum (DPA) — record
  the version and date.
- **Sub-processor list URL**: https://servicetrust.microsoft.com/
- **No-training**: Azure OpenAI does not train on customer data by default — record the contract
  clause reference.
- **Abuse-monitoring opt-out**: _(not yet requested)_
- **Annual review date**: _(set to provisioning date + 1 year)_

### The one absolute rule

`spec.md`: *"Sensitive tasks do not fall through to MiniMax or browser AI."* If Azure is down or
unconfigured, the feature returns a deterministic editable template — it must **never** silently
route candidate data to the general-purpose MiniMax provider the rest of the app uses. The
`SensitiveAIProvider` interface already exists specifically to make that impossible to do by
accident.

---

## 5. Non-credential blockers

These are not accounts, but they gate production launch just as hard.

| Item | Who | Notes |
| --- | --- | --- |
| **DPIA** | You + whoever advises you on data protection | Required before production voice launch. Covers: candidate data categories, the four processing purposes, retention, EU transfers, and the legal basis. |
| **Security/privacy reviewer sign-off** | A named human | `spec.md` requires a reviewer to sign this register once the accounts exist. |
| **Legal review of consent basis + retention** | Legal advisor | The exact consent wording and the 90/180-day/24-month retention periods. I can draft; I cannot approve. |
| **Canonical tenant/RLS release gate** | You (in-flight) | The `security-and-multitenancy` cutover. Not blocking the build, but listed in the plan as a gate before candidate private data goes live. |

---

## Suggested order

If you want to unblock the most work for the least effort:

1. **Cloudflare R2 + ClamAV** — an afternoon, no approval queues, unblocks 8 tasks.
2. **Azure OpenAI access request** — submit early because of the review delay, then come back to it.
3. **Deepgram** — verify the EU endpoint question *before* investing in Phase 9.
4. **DPIA + legal review** — can run in parallel with all of the above.

Tell me when any one of these lands and I will build and verify that slice against the real
provider. Until then I will keep working through the 24 remaining tasks that need no external
accounts: calendar projections, invitations, atomic booking, and the billing integration.
