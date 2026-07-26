# Interview Intelligence — Provider Register & Cost Decision

> Companion to [`src/shared/lib/env.ts`](../../src/shared/lib/env.ts) (the compile-time
> enforcement point — production boot **fails closed** if a flag is on and its provider config is
> missing or in the wrong region) and
> [`plans/phase-1/calendar-scheduling-interview-intelligence/spec.md`](../../plans/phase-1/calendar-scheduling-interview-intelligence/spec.md).
>
> **Never commit a secret value here.** This register records account identity, region, DPA status
> and owner — never keys. Secrets live in Coolify environment variables only.

---

## The decision (2026-07-26)

Storage and virus scanning are **self-hosted**; transcription and sensitive AI are **pay-as-you-go
SaaS**. The split is not ideological — it follows from what each workload costs to run.

| Capability | Choice | Why |
| --- | --- | --- |
| Candidate document storage | **MinIO, self-hosted** | S3-compatible, negligible CPU, fits free on the box we already pay for. Removes a paid vendor, a DPA, and a sub-processor entry. |
| Virus scanning | **ClamAV, self-hosted** | Not a SaaS product to begin with. |
| Live transcription | **Deepgram, pay-as-you-go** | Self-hosting Whisper needs a GPU we do not have. |
| Brief & report generation | **Azure OpenAI, pay-as-you-go** | Same — a GPU box for report-quality output. |

### The numbers behind it

Marginal cost per 60-minute interview:

| Component | Rate | Per interview |
| --- | --- | --- |
| Deepgram Nova-3 streaming, mono (in-person) | $0.0077/min | $0.46 |
| Deepgram Nova-3 streaming, 2-channel (remote) | ×2 channels | $0.92 |
| Azure GPT-4o — brief (~8k in / 2k out) | $2.50 / $10 per 1M | $0.04 |
| Azure GPT-4o — report (~15k in / 3k out) | " | $0.07 |
| Azure GPT-4o — contextual questions (~30 calls) | " | $0.24 |
| Document storage | MinIO on existing disk | $0.00 |

**Light interview** (in-person, no contextual questions): **~$0.57**
**Heavy interview** (remote 2-channel, with contextual questions): **~$1.27**

Note two things the naive estimate misses: `spec.md` mandates 2 separate channels for remote calls
and forbids down-mixing, so Deepgram bills **double** for those; and the contextual-questions
feature, which looks trivial, is the single largest AI line because it fires every 30 seconds.

Against a self-hosted GPU (Hetzner GEX44, RTX 4000 Ada, **€184/month fixed**):

| Interviews/month | SaaS (light) | SaaS (heavy) | Self-hosted GPU |
| ---: | ---: | ---: | ---: |
| 10 | €5 | €12 | €184 |
| 50 | €26 | €58 | €184 |
| 100 | €52 | €115 | €184 |
| **150** | €78 | **€173** | **€184** ← crossover (heavy) |
| 200 | €104 | €231 | €184 |
| **335** | **€184** | €386 | **€184** ← crossover (light) |

**Break-even sits between 150 and 335 interviews per month** — roughly 5–11 Team customers all
exhausting their credit allowance. Below that, SaaS is 10–30× cheaper. The GEX44 is also currently
out of stock, and the next tier up is €889/month.

### Margin check

| Plan | Price | Interviews included | Revenue/interview | Cost | Margin |
| --- | ---: | ---: | ---: | ---: | ---: |
| Pro | $19 | 2 | $9.50 | $0.57–1.27 | 87–94% |
| Pro Max | $79 | 10 | $7.90 | " | 84–93% |
| Team | $199 | 30 | $6.63 | " | 81–91% |

### Revisit this when

- Sustained volume passes ~150 interviews/month, **or**
- Third-country transfers become a real commercial blocker rather than paperwork.

Switching later is writing one adapter, not reworking the domain — `StorageProvider`,
`TranscriptionProvider` and `SensitiveAIProvider` are deliberately vendor-neutral interfaces.

---

## 1. MinIO — candidate document storage *(self-hosted, €0)*

### What to deploy

A `minio` service in the Coolify project:

- Image: `minio/minio:latest` (pin the digest once deployed), ARM64-compatible — conductor-01 is
  a CAX21 (4 shared ARM cores, 8 GB RAM, 80 GB disk).
- Command: `server /data --console-address ":9001"`
- Port **9000** on the internal network only. Never public — candidate CVs are personal data and
  there is no public-read path anywhere in the design.
- A persistent volume for `/data`.
- One bucket: `builderhunt-interview-documents`, private.
- A service account scoped to that one bucket (read/write), not the root credentials.

### Environment variables

```
INTERVIEW_R2_ENDPOINT=http://minio:9000        # internal Coolify hostname
INTERVIEW_R2_ACCOUNT_ID=minio
INTERVIEW_R2_BUCKET=builderhunt-interview-documents
INTERVIEW_R2_ACCESS_KEY_ID=<service account key>
INTERVIEW_R2_SECRET_ACCESS_KEY=<service account secret>
INTERVIEW_R2_JURISDICTION=eu
```

The variable names keep their `INTERVIEW_R2_*` prefix so switching to Cloudflare R2 later is an
env-var change with no code edit. `env.ts` accepts either a `*.eu.r2.cloudflarestorage.com`
endpoint **or** a self-hosted one — see the note in that file for exactly which forms pass.

### The one real trade-off

MinIO on a single box has **no redundancy**. If that disk fails, candidate documents are gone;
Cloudflare R2 offers eleven-nines durability. Two mitigations, in order of effort:

1. Point the existing backup routine at the MinIO volume.
2. A Hetzner Storage Box (1 TB, ~€4/month) as an off-box replication target.

Disk pressure is also real: 80 GB is shared with Postgres, Redis, Ollama and the app. At 25 MB per
invitation, 1,000 candidates is 25 GB. Monitor it.

### Recorded

- **Deployment target**: _(not yet deployed)_
- **Image + digest**: _(pin on deployment)_
- **Bucket**: `builderhunt-interview-documents`
- **Backup target**: _(not yet configured)_ ⚠️ do this before real candidate data lands
- **DPA / sub-processor**: **none — no third party involved.**
- **Deletion API**: yes (S3 `DeleteObject`) — the retention worker uses it.

---

## 2. ClamAV — virus scanning *(self-hosted, €0)*

### What to deploy

A `clamav` service using `clamav/clamav:stable`, TCP port **3310** internal only, ~1.5 GB RAM
(below that it OOMs while loading signature definitions). First boot downloads the database and
takes several minutes — do not point the app at it until `clamdscan --ping` succeeds.

```
INTERVIEW_CLAMAV_HOST=clamav
INTERVIEW_CLAMAV_PORT=3310
```

### Why it cannot be skipped

`spec.md` requires every uploaded object to stream through ClamAV **before** it moves from the
quarantine prefix to the clean prefix. The document state machine has no transition from
`uploaded` to `ready` that bypasses `scanning` — this is enforced in
[`src/shared/lib/interviews.ts`](../../src/shared/lib/interviews.ts), not just in prose.

### Recorded

- **Deployment target**: _(not yet deployed)_
- **Image + digest**: `clamav/clamav:stable` — _(pin on deployment)_
- **Signature updates**: freshclam runs in-container
- **DPA / sub-processor**: **none.**

---

## 3. Deepgram — live transcription *(pay-as-you-go SaaS)*

### What to create

1. A Deepgram account. Pay-As-You-Go: **no monthly fee, no minimum** — €0 in a month with no
   usage. Typically ships with ~$200 free credit.
2. An API key.
3. **Verify the EU endpoint is available on your plan before Phase 9 work starts.** The code
   hard-codes `wss://api.eu.deepgram.com` and `env.ts` refuses to boot with any other base URL
   when transcription is on. There is deliberately no fallback to the global endpoint. If the EU
   endpoint turns out to be plan-gated, that is a product decision — pay for it, change provider,
   or ship manual-notes-only — not something to quietly work around.
4. Get written confirmation (support ticket or contract) that audio is **not retained** and **not
   used for training**. We tell the candidate exactly that; we need the provider standing behind it.

```
DEEPGRAM_API_KEY=<key>
DEEPGRAM_BASE_URL=https://api.eu.deepgram.com   # already the default; do not override
```

### Recorded

- **Account owner**: _(not yet provisioned)_
- **Plan / EU endpoint confirmed**: _(not yet provisioned)_ ⚠️ verify before Phase 9
- **DPA signed**: _(not yet provisioned)_
- **No-training / no-retention confirmation**: _(not yet provisioned)_ — attach the reference
- **Model**: `nova-3` (multichannel for remote, streaming diarization for in-person)
- **Billing**: pay-as-you-go, in arrears. Spend is capped in practice by our own credit
  reservations, which hard-stop at zero balance.
- **Annual review date**: _(provisioning date + 1 year)_

---

## 4. Azure OpenAI — brief and report generation *(pay-as-you-go SaaS)*

### What to create

1. An Azure subscription.
2. **Request Azure OpenAI access — start this first.** It is an application with a review queue,
   not instant self-serve. Budget several business days.
3. An Azure OpenAI resource in an **EU region**. `env.ts` accepts only: `westeurope`,
   `northeurope`, `francecentral`, `germanywestcentral`, `swedencentral`, `switzerlandnorth`.
4. A GPT-4-class model deployment. Note the *deployment name* — that is the env var value, not the
   model name.
5. Optionally request **Modified Abuse Monitoring** (a separate Azure form) to opt out of human
   review of prompts — the strongest position for "no human sees candidate data".

```
AZURE_OPENAI_ENDPOINT=https://<resource>.<region>.api.cognitive.microsoft.com
AZURE_OPENAI_API_KEY=<key>
AZURE_OPENAI_DEPLOYMENT=<deployment name>
AZURE_OPENAI_API_VERSION=2024-08-01-preview
```

### Watch for

The resource costs nothing idle — you pay per token. But Azure can add material cost if you enable
Log Analytics, Private Link, a support plan, or Provisioned Throughput Units. None are needed for
this deployment; do not enable them without checking the price.

### The absolute rule

`spec.md`: *"Sensitive tasks do not fall through to MiniMax or browser AI."* If Azure is down or
unconfigured, the feature returns a deterministic editable template. It must **never** silently
route candidate data to the general-purpose MiniMax provider the rest of the app uses. The
`SensitiveAIProvider` interface exists specifically to make that impossible by accident.

### Recorded

- **Subscription / tenant**: _(not yet provisioned)_
- **Access application approved**: _(not yet provisioned)_ ⚠️ start early, review queue
- **Region**: _(must be one of the six above)_
- **Deployment name + model**: _(not yet provisioned)_
- **DPA**: Microsoft Products and Services DPA — record version and date
- **Sub-processor list**: https://servicetrust.microsoft.com/
- **No-training**: Azure OpenAI does not train on customer data by default — record the clause
- **Abuse-monitoring opt-out**: _(not yet requested)_
- **Annual review date**: _(provisioning date + 1 year)_

---

## 5. Non-credential blockers

| Item | Who | Notes |
| --- | --- | --- |
| **DPIA** | You + data-protection advisor | Required before production voice launch. Now narrower in scope: storage and scanning are first-party, so only Deepgram and Azure are third-country transfers. |
| **Security/privacy reviewer sign-off** | A named human | `spec.md` requires a reviewer to sign this register once accounts exist. |
| **Legal review of consent basis + retention** | Legal advisor | The consent wording and the 90-day / 180-day / 24-month retention periods. I can draft; I cannot approve. |
| **Canonical tenant/RLS release gate** | You (in-flight) | The `security-and-multitenancy` cutover. |

---

## What this unblocks right now

Because storage and scanning need no external account, **Phase 6 (candidate documents and intake,
8 tasks) is implementable and verifiable locally today** — MinIO and ClamAV both run in Docker on
a developer machine exactly as they will in Coolify.

Only Phases 8, 9 and 10 (18 tasks) still wait on Deepgram and Azure credentials.
