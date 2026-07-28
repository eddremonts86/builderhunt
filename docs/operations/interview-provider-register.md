# Interview Intelligence — Provider Register & Cost Decision

> **Scope**: the four providers this feature program needs, and the DPA/privacy record for each.
> For the full list of every third-party account BuilderHunt requires — domain, mailbox, Resend,
> MiniMax, backups, source tokens, extension stores — and the order to create them in, see
> [`external-services-register.md`](external-services-register.md).
>
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

### Reproducing this on a developer machine

`docker compose --profile interviews up -d storage`, plus a service account scoped to the bucket.
The local `.env` mirrors production's bucket name, `INTERVIEW_R2_ACCOUNT_ID` and jurisdiction
exactly; only the endpoint differs, because production resolves the container by its internal name
while a laptop reaches the same image on loopback.

The credentials are deliberately **not** production's. Copying a production storage credential onto
a laptop is a real regression, and it would not authenticate against a different MinIO anyway. What
is mirrored is the *shape* — a service account limited to the one bucket, never the root user —
because that is what makes a permissions bug reproduce here instead of in production.

Verified 2026-07-28 against the local instance: the scoped account can put, get and delete inside
the bucket, cannot create another one, and `ListBuckets` returns only the bucket it is scoped to
rather than every bucket on the instance.

### The one real trade-off

MinIO on a single box has **no redundancy**. If that disk fails, candidate documents are gone;
Cloudflare R2 offers eleven-nines durability. Two mitigations, in order of effort:

Both mitigations are **already in place**, and were before this section was last read:

1. ✅ The MinIO volume is rsynced nightly by `builderhunt-backup-sync.sh` — the same script that
   ships the database dumps and the cluster roles, deliberately in one place because the €4/month
   Storage Box was justified by this volume, not by the ~5 MB database.
2. ✅ The Hetzner Storage Box **is** the off-box target, with its own 05:00 snapshot so a deletion
   propagated by rsync is still recoverable.

One real defect found and fixed 2026-07-28: the installed crontab entry was missing the
`>> /var/log/builderhunt-backup-sync.log 2>&1` redirection its own header documents, so two nightly
runs left no trace and a failure would have been invisible. The runs were in fact succeeding —
confirmed by comparing the dumps on the Storage Box against the local ones — but a backup you cannot
observe is one you will discover the state of at the worst possible moment.

Disk pressure is also real: 80 GB is shared with Postgres, Redis, Ollama and the app. At 25 MB per
invitation, 1,000 candidates is 25 GB. Monitor it.

### Recorded

- **Deployment target**: Coolify, container `builderhunt-minio`, reached by the app at
  `http://builderhunt-minio:9000` on the internal network. Confirmed 2026-07-28 by reading the
  `builderhunt` application's environment from the Coolify API — the six `INTERVIEW_R2_*` variables
  are set there, with a 20/40-character service account rather than the root credentials.
- **Image + digest**: _(pin on deployment)_
- **Bucket**: `builderhunt-interview-documents`
- **Backup target**: ✅ **off-box, and it has been since 2026-07-26.**
  `/usr/local/bin/builderhunt-backup-sync.sh` rsyncs the `builderhunt-minio-data` volume to the
  Hetzner Storage Box sub-account nightly at 03:30 UTC, and the Storage Box takes its own snapshot
  at 05:00 (max 10) — a replication target without snapshots just mirrors a deletion. Wired up
  deliberately *before* any document existed, so the off-site copy was never retrofitted onto data
  that already mattered. Verified 2026-07-28: today's run completed and `./minio-data/` on the
  Storage Box is current.
- **DPA / sub-processor**: **none — no third party involved.**
- **Deletion API**: yes (S3 `DeleteObject`) — the retention worker uses it.

---

## 2. ClamAV — virus scanning *(self-hosted, €0)*

### What to deploy

> **Resolved 2026-07-28 — build from the Alpine package.** No official `clamav/clamav` tag publishes
> an arm64 manifest (`stable`, `stable_base`, `latest`, `1.4`, `1.4_base` are all amd64, and the
> image is absent from ghcr.io and quay.io), while conductor-01 is a CAX21 (ARM). Rather than emulate,
> trust a third-party rebuild of an antivirus, or move the service to its own amd64 host, the image
> is now built from Alpine's own `clamav` package — see `docker/clamav/Dockerfile`. Provenance stays
> with a distro that signs and rebuilds it, and the same Dockerfile serves an ARM server and an amd64
> laptop.
>
> Verified on arm64 (2026-07-28): builds, `clamd` healthy in 40 s on a warm signature volume,
> ClamAV 1.4.2 with the 2026-07-27 database, and **detects the EICAR test string over TCP 3310**.
> That last check is the one that matters — a scanner that starts but never detects is worse than
> none, because it produces a clean verdict.
>
> The image sets `StreamMaxLength`/`MaxFileSize` to 64 MB. That must stay above the largest upload
> the app accepts, or a big-but-legitimate CV comes back as a scan *failure* rather than a verdict.

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

- **Deployment target**: ⚠️ **NOT deployed.** Confirmed 2026-07-28 against the live Coolify
  environment: `INTERVIEW_CLAMAV_HOST` is absent from the `builderhunt` application, and `env.ts`
  refuses `CANDIDATE_UPLOADS_ENABLED=true` without it. MinIO is deployed and configured; this is the
  single remaining thing between candidate uploads and production.
- **Image + digest**: built from `docker/clamav/Dockerfile` (Alpine's clamav package — the upstream
  image has no arm64 build; see the note above) — _(pin the digest on deployment)_
- **Signature updates**: freshclam runs in-container
- **DPA / sub-processor**: **none.**

---

## 3. Deepgram — live transcription *(pay-as-you-go SaaS)*

### What to create

1. A Deepgram account. Pay-As-You-Go: **no monthly fee, no minimum** — €0 in a month with no
   usage. Typically ships with ~$200 free credit.
2. An API key.
3. ~~**Verify the EU endpoint is available on your plan.**~~ **Resolved 2026-07-26 — it is not
   plan-gated.** Deepgram's GA announcement states there is "no waitlist, no activation step, and
   no changes to billing or authentication" and "no additional pricing or activation requirements";
   existing API keys work against `api.eu.deepgram.com` unchanged. So the hard-coded EU base URL in
   `env.ts` (which refuses to boot with any other value when transcription is on, deliberately with
   no global-endpoint fallback) is satisfiable on plain pay-as-you-go. Source:
   <https://deepgram.com/learn/deepgram-eu-endpoint-now-generally-available>.
   Still worth re-checking at provisioning time — a vendor can change packaging.
4. Get written confirmation (support ticket or contract) that audio is **not retained** and **not
   used for training**. We tell the candidate exactly that; we need the provider standing behind it.
   ⚠️ **This one cannot be shortcut.** Checked 2026-07-26: Deepgram's public
   `trust-security/data-privacy-compliance` page covers certifications (SOC 2, GDPR, HIPAA, CCPA,
   PCI) and regional residency but says **nothing** about retention or training use, and nothing
   about pay-as-you-go versus enterprise differences. Do not infer a no-retention default from the
   compliance badges — ask support and keep the reply.

   Checked the console too (2026-07-26): **Deepgram exposes no retention or training setting at all**
   — no toggles on the project page, and `/project/<id>/settings` redirects to the project root.
   Unlike Mistral, where the opt-out is a real org-level switch, here there is nothing to configure.
   That means a UI check can neither confirm nor satisfy this requirement: it is contractual only,
   and the written reply from support is the sole artifact. Do not let a green-looking dashboard
   stand in for it.

```
DEEPGRAM_API_KEY=<key>
DEEPGRAM_BASE_URL=https://api.eu.deepgram.com   # already the default; do not override
```

### Recorded

- **Account owner**: `eduardo.inerarte@gmail.com's Project`, provisioned 2026-07-26. No card on file.
- **Plan / EU endpoint confirmed**: ✅ **verified against this account, not just the vendor blog.**
  - `POST https://api.eu.deepgram.com/v1/listen?model=nova-3` → **200**, so the EU endpoint serves
    inference on plain pay-as-you-go with the standard key. No plan gate.
  - `diarize=true` (the in-person path) → accepted.
  - `multichannel=true` on 2-channel audio → **returns 2 separate channels**, which is the spec's
    hard requirement for remote interviews (2 channels, down-mixing forbidden).
  - Gotcha worth remembering: `https://api.eu.deepgram.com/v1/projects` returns **404** while the
    global host returns 200. That is not a broken key or a broken region — the EU host serves the
    *inference* APIs only, not the management ones. Do not use a management endpoint to health-check
    EU access; use `/v1/listen`.
- **API key**: `builderhunt-transcription-prod`, role **Default** (`usage:write` only — the narrowest
  of the four; Member can already create and delete keys, Admin can read the balance, Owner can
  change billing). Expiry deliberately **Never**: an expired key would fail mid-interview, a
  user-visible break in a paid feature, and there is no rotation automation — the control is the
  annual review date below, not an unwatched expiry.
- **Synced to Coolify production** (app uuid resolved by name): `DEEPGRAM_API_KEY`,
  `DEEPGRAM_BASE_URL`, verified by SHA-256 comparison without reading either value. No redeploy —
  `INTERVIEW_TRANSCRIPTION_ENABLED` is still `false`.
- **DPA signed**: _(not yet provisioned)_
- **No-training / no-retention confirmation**: **accepted by the product owner 2026-07-26 without a
  written vendor statement.** Recorded as a decision, not as evidence: nothing was obtained from
  Deepgram, their public compliance page is silent on retention and training, and the console has no
  setting that could stand in for it. A reviewer signing this register should know the claim we make
  to candidates is currently unbacked. Reopen before production voice launch — `spec.md` lists
  "verified EU endpoints/no-training" as a launch gate, and this is the half that is still missing.
- **Model**: `nova-3` (multichannel for remote, streaming diarization for in-person)
- **Billing**: pay-as-you-go, in arrears. Spend is capped in practice by our own credit
  reservations, which hard-stop at zero balance.
- **Signup credit: $200, and it expires one year from signup — around 2027-07-26.** Credits
  *purchased* later never expire; this promotional one does. Worth planning around rather than
  treating as free money:
  | | |
  | --- | --- |
  | Covers | ~434 in-person (mono, $0.46) or ~217 remote (2-channel, $0.92) 60-minute interviews |
  | To consume it all before expiry | ~290 interviews, i.e. **~24/month** at a 50/50 mix |
  | At 10 interviews/month | ~$83 used, **~$117 expires unused** |

  The window shrinks with every month Phase 9 slips: start it 6 months from now and burning the
  credit would need ~48 interviews/month instead of 24. So the credit is a reason to sequence Phase 9
  earlier if transcription is wanted, not a subsidy that waits patiently. Source:
  <https://deepgram.com/pricing>.
- **Annual review date**: _(provisioning date + 1 year)_

---

## 4. Sensitive AI — brief and report generation

> **Provider decision revised 2026-07-26: Mistral (La Plateforme) becomes primary; the provisioned
> Azure resource stays as a fallback.** Product-owner decision after Azure provisioning hit a
> zero-quota wall and a residency regression. Rationale below; the Azure section that follows is
> retained in full because the resource exists and the quota request is still worth completing.

### Why the switch

Not cost. With Mistral Medium 3 the AI is **$0.058 of a $0.98 heavy interview** — Deepgram is 94% of
the bill. Switching saves ~$0.33 per heavy interview (25%), and margins were already 85–94% either
way. The real reasons:

1. **EU processing is Mistral's default, not a per-deployment choice that can be set wrong.** This
   directly closes the hole found while provisioning Azure: `env.ts` validates the resource region
   but **cannot** see the deployment type, so an Azure *Global Standard* deployment passes validation
   while processing candidate data outside the EU. With Mistral the US endpoint is an explicit
   opt-in, so the failure mode does not exist.
2. **A French entity removes a third-country transfer from the DPIA entirely** — only Deepgram would
   remain. §5 previously listed both.
3. **Self-serve.** No quota wall, no deprecated-model dead end.

Honest counterweights, recorded so this is revisitable: Azure has the **best-documented** residency
guarantee of the options reviewed ("the EU Data Zone confines processing to the EU Data Boundary"),
its DPA and sub-processor transparency are mature, and it is already 90% provisioned. And **Mistral's
output quality for structured candidate-evaluation reports is unverified** — that is the open risk,
and the reason the Azure fallback is being kept alive rather than deleted.

Retention parity: Mistral's Zero Data Retention is Scale-plan/request-gated (default is a 30-day
abuse-monitoring window); Azure's Modified Abuse Monitoring is also an application. Neither is free.

### ⚠️ The training opt-in is checked by default — verified in the UI, 2026-07-26

On `admin.mistral.ai`'s **Activar PAYG** page there is a checkbox:

> *"Permitir el uso de tus llamadas a la API para entrenar los modelos de IA de Mistral."*

It arrives **checked**, confirmed by reading the DOM (`checked: true`) rather than by eye. Unchecked
during setup. **Anyone who completes this flow without noticing has opted their candidate data into
model training** — the single highest-consequence default encountered in this whole provisioning
exercise, and it is two clicks from a compliance breach. Re-verify it after any billing or plan
change, because plan transitions are exactly where such a flag gets silently reset.

**And it did not persist.** Unchecking it in the PAYG signup flow was not enough: minutes later,
`admin.mistral.ai` → **API → Privacidad** showed the org-level toggle *"Permite el uso de tus
llamadas a la API para entrenar los modelos de IA de Mistral"* **switched on**. Turned off there and
re-verified after a full page reload, so the org-level setting is the authoritative one — the signup
checkbox is not. **Check API → Privacidad, not the signup form.**

**Second trap on the same page — "Activación de modelos de Labs".** Its own text: enabling it means
data may be used to train Mistral models *"independientemente de mi plan de suscripción o
configuraciones de exclusión"* — it **overrides the training opt-out**. Currently off. It must stay
off, and no one should enable a Labs model for this workload regardless of how good it looks.

### Account state (2026-07-26)

- **Pay-as-you-go: Active**, estimated cost €0. Note the confusing pair: *"Plan actual: Gratuito"*
  refers to **Le Chat**, the consumer assistant — not the API. The API billing is the PAYG line.
- Organization `Eduardo Inerarte`, org id `d895462e-bcd5-40de-b8a8-46e59197f65b`, 1 member.
- **Rate limits are granted out of the box** — the sharpest contrast with Azure, which gave zero
  quota in every region and needed support case `2607260050000678`. Mistral, immediately:
  `mistral-medium-2505` **600,000 TPM**, `mistral-large-2512` 400,000, `ministral-8b-2512` 1,000,000.
  That is 12× the 50,000 TPM being requested from Azure, available now, no ticket.
- **Model IDs are date-versioned**: the real ids are `mistral-medium-2505` / `mistral-large-2512`,
  not the "Medium 3"/"Large 3" marketing names the pricing research used. Confirm per-token price
  against the exact id before trusting the cost table above.
- **API key**: one exists (created 2026-07-26, type `Studio`, scope "shared only", **expiry:
  never**). Mistral reveals a key's value only at creation, so if it was not saved at that moment a
  replacement must be issued. A non-expiring production credential is a weaker posture than an
  expiring one with rotation — revisit.
- **Zero Data Retention**: _(pending)_ not self-serve in this panel; it is a support/sales request.

### Wired up (2026-07-26)

- **Model pinned: `mistral-medium-2604`** — the newest dated medium, verified live. Floating aliases
  (`mistral-medium-latest`, `mistral-medium-3.5`) exist and are **rejected by `env.ts`**: this model
  writes candidate-evaluation text, so an unannounced version change is a fairness and auditability
  problem. `SensitiveAICompletionResult.model` records what actually ran.
- **Verified end-to-end before writing any code**: key valid (61 models), and a real
  `response_format: {type:'json_schema', strict:true}` call against both `mistral-medium-2604` and
  `mistral-medium-2505` returned schema-valid JSON with `usage` token counts that map directly onto
  `SensitiveAICompletionUsage`. So `completeStructured` is satisfiable — not assumed, executed.
- **`env.ts` reworked**: new `SENSITIVE_AI_PROVIDER` (`mistral` | `azure`, default `mistral`).
  Mistral's residency guard is an **exact match** on `https://api.mistral.ai`, not a substring test,
  so a US endpoint, a proxy, or a lookalike host (`api.mistral.ai.evil.example`) all fail closed.
  This is the check the Azure branch structurally cannot express. `MISTRAL_API_KEY` added to the
  `VITE_`-leak guard. 12 new test cases; 83 tests green, typecheck clean.
- **Synced to Coolify production** with the app uuid resolved by *name* from the live API:
  `SENSITIVE_AI_PROVIDER`, `MISTRAL_API_KEY`, `MISTRAL_BASE_URL`, `MISTRAL_MODEL`, each verified by
  comparing SHA-256 against the local value rather than reading either. **No redeploy triggered** —
  `SENSITIVE_AI_ENABLED` is still `false` and nothing reads these yet, so they will be picked up by
  the next deploy. Do not flip that flag until the Phase 8/10 provider implementation exists.
- **One key was rotated** during this work: a `.env` file with no trailing newline caused an append
  to concatenate onto the `MISTRAL_API_KEY` line, and inspecting the damage printed the value into a
  session transcript. File repaired, trailing newline enforced, key rotated and the replacement
  re-verified. Lesson worth keeping: check for a trailing newline before appending to a secrets file.

### Cost per interview, recomputed

| Provider | AI total | Light | Heavy |
| --- | ---: | ---: | ---: |
| **Mistral Medium 3** ($0.40/$2.00) | $0.058 | $0.48 | **$0.98** |
| Mistral Large 3 ($2/$6) | $0.253 | $0.54 | $1.17 |
| Azure `gpt-5.6-luna` ($1/$6) | $0.155 | $0.51 | $1.08 |
| Azure `gpt-5.6-terra` ($2.50/$15) | $0.388 | $0.59 | $1.31 |
| *GPT-4o, the original assumption* | $0.340 | $0.57 | $1.26 |

Structured output is satisfied: Mistral supports `response_format: {type:'json_schema', strict:true}`,
the same constrained-decoding concept `completeStructured` needs. Drop-in reuse of the installed
`openai` SDK is **not** confirmed — verify at implementation time rather than assuming.

### The bigger cost lever, noted not acted on

Transcription is 94% of the per-interview cost. Azure's catalogue includes
`gpt-4o-transcribe-diarize`. Evaluating that against Deepgram is worth more money than this entire
provider decision — but `spec.md` fixes Deepgram and the EU base URL is hard-coded, so it is a
separate decision with its own register entry, not a side effect of this one.

---

## 4b. Azure OpenAI — retained as fallback *(pay-as-you-go SaaS)*

### What to create

1. An Azure subscription.
2. **Request Azure OpenAI access — start this first.** It is an application with a review queue,
   not instant self-serve. Budget several business days.
3. An Azure OpenAI resource in an **EU region**. `env.ts` accepts only: `westeurope`,
   `northeurope`, `francecentral`, `germanywestcentral`, `swedencentral`, `switzerlandnorth`.

   ⚠️ **Read the check before creating the resource.** `env.ts:440` does
   `EU_AZURE_REGIONS.some((region) => endpointHost.includes(region))` — a **substring match on the
   endpoint hostname**. Azure's default endpoint for a new resource is
   `https://<resource>.openai.azure.com`, which contains **no region** and therefore **fails**,
   even though the resource is legitimately in the EU. Two ways through: use a regional endpoint
   form that carries the region in the host, or **name the resource so it contains the region**
   (e.g. `builderhunt-swedencentral`). The naming route is the least fragile without a code change.

   Recommended region: **`swedencentral`**, `northeurope` second — better GPT-4o-class availability;
   `westeurope` is frequently capacity-constrained. Confirm the model is deployable in the region
   *before* creating the resource, or you will recreate it.

   Note for whoever revisits this: the check validates a *string*, not a region. It can be satisfied
   by naming alone and it rejects legitimate EU endpoints. Worth replacing with an explicit
   `AZURE_OPENAI_REGION` var validated against the allow-list, rather than inferring from the host.
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

- **Subscription / tenant**: `Azure subscription 1`, id `e6da3ee8-fcd1-4ecf-9d65-f88b60cc4e5f`,
  plan **"Plan de Azure"** (Microsoft Azure Plan — pay-as-you-go, **not** the free trial, so there
  is no 30-day credit cliff that would disable a live resource). Directory
  `eduardoinerartegmail.onmicrosoft.com` (`3a8fc5ca-6de7-4756-b74b-7c3acd21e1dc`). Owner role.
  Country **Denmark**, chosen as **personal use** to match the Stripe individual-seller KYC and the
  fact that no VAT registration exists. Country cannot be changed later.
  - Gotcha for next time: the portal opens in the consumer tenant `f8cdef31-…` where the
    subscription list is empty. It is not missing — switch directory first.
- **Access application approved**: **not needed.** Verified 2026-07-26: the *Crear Azure OpenAI*
  blade is fully self-serve on a new pay-as-you-go subscription. No waitlist, no review queue. The
  only prerequisite is registering the `Microsoft.CognitiveServices` provider, which the portal does
  automatically.
- **Region**: **`swedencentral`** — confirmed on the resource's Keys and Endpoint blade
  (`Ubicación o región: swedencentral`), which is independent of the resource name.
- **Resource**: `builderhunt-swedencentral`, resource group `builderhunt-ai`, tier Standard S0,
  tag `project=builderhunt` for cost attribution, network **all networks** (see hardening note).
- **Endpoint**: `https://builderhunt-swedencentral.openai.azure.com/` — **validated by running the
  actual `env.ts` predicate against it**, not by eye. It passes only because the resource name
  contains the region: `https://builderhunt.openai.azure.com/` and
  `https://builderhunt-ai.openai.azure.com/` both fail. Renaming the resource breaks production boot.
- **Deployment name + model**: ⛔ **BLOCKED ON QUOTA — 2026-07-26.** Two findings that change this
  plan:

  1. **`gpt-4.1` cannot be deployed at all.** Azure rejects it with
     `ServiceModelDeprecating: The model 'Format.OpenAI,Name.gpt-4.1,Version.2025-04-14' is in
     deprecating state and cannot be used for new deployments.` The whole GPT-4 chat family is out,
     so the "GPT-4-class model" wording above and the GPT-4o-based cost table are obsolete.
  2. **A new subscription has zero quota.** In the deploy dialog every location reads
     `(Sin cuota)` — East US, North Europe, **Sweden Central**, West Europe, UK South, all of them.
     The Quota blade confirms it: the categories (`Standard`, `DataZoneStandard`, `GlobalStandard`,
     …) exist but hold no allocation. Nothing is deployable until a quota increase is granted.

  **This is the review queue the register warned about** — it just shows up at the quota stage
  rather than as an access application. Starting Azure early was the right call for exactly this
  reason.

  **Quota request filed 2026-07-26**: Azure support case **`2607260050000678`**, status `OPEN`,
  severity C (minimal impact), contact by email. Asked for `gpt-5.6-terra`, **Data Zone Standard**,
  Sweden Central, **50,000 TPM** — the figure Azure itself offered by default for `gpt-4.1`, so it is
  a modest ask. Advanced diagnostic collection was declined: it grants Microsoft Support read access
  to subscription resources, a quota request does not need it, and this subscription is intended to
  process candidate data.

  **Model decision (made, pending quota): `gpt-5.6-terra`.** Current tiers are Sol $5/$30, Terra
  $2.50/$15, Luna $1/$6 per 1M tokens. Terra has the *same input price* as the GPT-4o figure the
  cost table assumed, so a heavy interview moves $1.27 → **$1.31 (+3%)** and the margin table holds.
  Sol would make it ~$1.70 (+34%) for agentic-reasoning strength this workload does not need; Luna
  would save ~$0.20 but this output is candidate evaluation material in a hiring decision — the
  wrong first place to economise.
  Deployment name chosen: **`sensitive-ai`** — mirrors `SensitiveAIProvider` and stays stable when
  the underlying model is upgraded, so `AZURE_OPENAI_DEPLOYMENT` never has to change.

- **⚠️ Data-residency regression, and a gap in our own validation.** `gpt-4.1` offered a **regional
  `Standard`** deployment ("Cumple las promesas de residencia de datos de Azure"), which would have
  kept processing inside Sweden. `gpt-5.6-terra` offers only **Global Standard**, **Data Zone
  Standard**, and the two provisioned (PTU) types. So:
  - **Global Standard is disqualified**: its own description says data "se pueden procesar
    globalmente, fuera de la geografía de Azure del recurso". That breaks the EU-processing promise
    we make to candidates.
  - The strongest achievable option is now **Data Zone Standard** — processing stays inside the EU
    data zone, but not necessarily inside Sweden. Still no third-country transfer, so GDPR-workable,
    but the DPIA wording must say "processed within the EU data zone", not "processed in Sweden".
  - **`env.ts` does not check any of this.** It validates the *resource* region substring only. A
    Global Standard deployment on an EU resource passes validation while violating the residency
    promise. The fail-closed guard is weaker than it looks — see the note on the region check above;
    both belong in the same fix.
- **Hardening before real candidate data**: switch the resource's network from "all networks" to
  selected networks limited to the VPS IP. Free, and meaningful for a resource that will process
  CVs and transcripts. Deliberately left open now because Phase 8/10 development needs to call it
  from laptops. Not Private Link — that has fixed cost.
- **DPA**: Microsoft Products and Services DPA — record version and date
- **Sub-processor list**: https://servicetrust.microsoft.com/
- **No-training**: Azure OpenAI does not train on customer data by default — record the clause
- **Abuse-monitoring opt-out**: _(not yet requested)_
- **Annual review date**: _(provisioning date + 1 year)_

---

## 5. Non-credential blockers

These are split by **what they actually gate**. Conflating the two stalled Phase 6 for no reason:
a legal sign-off cannot be a precondition for writing a storage adapter against a container running
on the developer's own machine.

### Gates development — must be resolved to build or run the feature

| Item | Who | Status |
| --- | --- | --- |
| **Canonical tenant/RLS release gate** | — | ✅ Closed 2026-07-27. `organization_id` is `NOT NULL` on all seven tenant-private tables (`drizzle/0081`), in production. |
| **MinIO + ClamAV deployed and env set** | You | The only remaining thing standing between Phase 6 and production. Both are first-party, so there is no account, DPA or vendor to wait for. |

### Gates turning a feature ON in production with real people's data

| Item | Who | Notes |
| --- | --- | --- |
| **DPIA** | You + data-protection advisor | Before production **voice**. Narrower than first written: storage and scanning are first-party, so only Deepgram and Mistral are third-country transfers. |
| **Deepgram no-training/no-retention statement** | Deepgram | Currently accepted without a written vendor statement — see §2. The claim made to candidates is unbacked until this exists. |
| **Mistral Zero Data Retention** | Mistral support | Not self-serve; a support request. |

### Gates general availability only — explicitly NOT development or MVP blockers

Tracked in `docs/operations/general-availability-checklist.md`.

Deferred by product-owner decision, 2026-07-28: neither is obtainable in the near term, and treating
them as preconditions would block work they have no bearing on. They move to the pre-launch
checklist, and nothing in `plans/phase-1/*` may list them as a dependency.

| Item | Who | Notes |
| --- | --- | --- |
| **Security/privacy reviewer sign-off** | A named human | `spec.md` asks a reviewer to sign this register. Required before opening the product to the general public, not before building or piloting it. |
| **Legal review of consent basis + retention** | Legal advisor | The consent wording and the 90/180-day and 24-month retention periods. Drafted and implemented as specified; approval is a launch step. |

The distinction that makes this safe rather than a shortcut: an unsigned register does not change
what the software does. Retention periods, consent capture and the fail-closed defaults are all
implemented and enforced in code today; what is deferred is a human countersignature on choices that
have already been made conservatively.

---

## What this unblocks right now

Because storage and scanning need no external account, **Phase 6 (candidate documents and intake,
8 tasks) is implementable and verifiable locally today** — MinIO and ClamAV both run in Docker on
a developer machine exactly as they will in Coolify.

Only Phases 8, 9 and 10 (18 tasks) still wait on Deepgram and Azure credentials.

## Consent versions, and the deploy-day consequence

Recorded 2026-07-28.

| Constant | Value | Where it is shown |
| --- | --- | --- |
| `CURRENT_CONSENT_VERSIONS.privacy` | `v2.0` | `/legal/privacy`, rendered from the constant |
| `CURRENT_CONSENT_VERSIONS.tos` | `v1.0` | `/legal/terms` |
| `CANDIDATE_NOTICE_VERSION` | `2026-07-28` | the candidate booking portal |

The privacy policy went to a **new major** because interview intelligence adds categories of personal data no
v1.x reader was shown: uploaded documents, imported public pages, transient live audio, stored transcripts,
and AI processing of all four. `isMaterialVersionChange` compares only the major part, so anything less would
have let every existing acceptance carry forward — holding people to text about their CV and their recorded
words they never saw.

> **On deploy, every existing customer hits a re-acceptance gate at checkout.**
> `requireCurrentCommercialConsent` uses the same rule, so an organization whose stored acceptance names a
> v1.x privacy version cannot buy credits or change a subscription until someone re-accepts. This is the
> correct behaviour for a material change and it will still surprise whoever is on support that day. Found by
> `tests/unit/shared/lib/billing/consent.test.ts` failing, not by tracing the callers.

Bumping `CANDIDATE_NOTICE_VERSION` likewise invalidates existing candidate consent by design — candidates are
re-prompted rather than held to an older notice. Nothing is deployed yet, so no live receipt is affected.
