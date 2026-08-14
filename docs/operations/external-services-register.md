# External Services Register — everything that needs an account

> **Purpose**: one list of every third-party account, token, domain or subscription BuilderHunt
> needs, in the order it has to be created, so provisioning happens once instead of one vendor at a
> time as each plan unblocks.
>
> **Never commit a secret value here.** This register records account identity, plan, region, cost,
> DPA status and owner — never keys. Secrets live in `.env` (local) and Coolify environment
> variables (production) only.
>
> Companions:
> [`interview-provider-register.md`](interview-provider-register.md) (the DPA/privacy record for the
> four interview-intelligence providers),
> [`stripe-launch-register.md`](stripe-launch-register.md) (Stripe, already live),
> [`public-enrichment-source-register.md`](public-enrichment-source-register.md) (per-source
> scraping policy), [`deploy-runbook.md`](deploy-runbook.md) (where env vars are set),
> [`src/shared/lib/env.ts`](../../src/shared/lib/env.ts) (the compile-time enforcement point).

---

## Scoreboard (2026-07-26)

### Already live — nothing to do

| Service | What it does | Cost | Evidence |
| --- | --- | --- | --- |
| **Hetzner Cloud** | `conductor-01` VPS (CAX21, 4×ARM, 8 GB, 80 GB), `178.105.106.79` | existing line item | prod app resolves to it |
| **Coolify** | self-hosted PaaS on that VPS — push-to-deploy, env vars, crons | €0 (self-hosted) | `deploy-runbook.md` |
| **GitHub** | repo + Actions → Coolify deploy webhook, plus a PAT for the GitHub source connector | €0 (free tier) | `.github/workflows`; `GITHUB_TOKEN` set in Coolify production |
| **MiniMax** | Tier-2 server AI, pay-as-you-go | usage only | `MINIMAX_API_KEY` set in Coolify production |
| **Resend** | transactional email, `builderhunt.dev` verified in `eu-west-1` | €0 (free tier) | §3 — delivery proven `delivered` |
| **`builderhunt.dev`** | domain + 6 forwarding mailboxes | $12.87/yr | §1–§2 |
| **Stripe** | billing, live mode, Denmark/individual KYC, DK tax registration | per-transaction fees | `stripe-launch-register.md` |
| **Ollama embeddings** | `nomic-embed-text` 768-dim, own Coolify resource | €0 (self-hosted) | `AI_EMBEDDING_URL` |
| **Redis** | cache + rate limiting, optional with in-memory fallback | €0 (self-hosted) | `src/shared/lib/redis.ts` |
| ~~**builderhunt.eduardoinerarte.dk**~~ | ~~interim production hostname~~ | — | **retired 2026-08-09** — dropped from the app's Coolify domains; every path now answers `503 no available server` from the proxy. See §1 "Cutover — what actually happened". |

### To contract now

| # | Service | Type | Recurring cost | Blocks |
| --- | --- | --- | --- | --- |
| # | Service | Type | Recurring cost | Status |
| --- | --- | --- | --- | --- |
| 1 | ~~**`builderhunt.dev` domain**~~ | registrar | $8.75 first yr, $12.87/yr | ✅ **done** — Porkbun, auto-renew on, WHOIS privacy verified via RDAP, HTTPS redirect live |
| 2 | ~~**Inbound mailbox**~~ | email forwarding | €0 | ✅ **done** — 6 addresses, MX verified through public resolvers |
| 3 | ~~**Resend**~~ | transactional email | €0 free tier | ✅ **done** — domain Verified in `eu-west-1`, real send `delivered`, key in production |
| 4 | ~~**MiniMax**~~ | AI, PAYG | usage only | ✅ **already contracted** — found set in Coolify during the audit; empty locally, so Tier-2 AI is off for dev only |
| 5 | ~~**Deepgram**~~ | transcription, PAYG | usage only; $200 credit **expires ~2027-07-26** | ✅ **done** — EU endpoint, `nova-3`, diarization and 2-channel all verified against this account; synced to Coolify |
| 6 | ~~**Azure OpenAI**~~ → **Mistral** | sensitive AI, PAYG | usage only | ✅ **done** — provider switched, see the interview register §4. Mistral key + pinned `mistral-medium-2604` live. Azure kept as fallback; quota case `2607260050000678` open |
| 7 | ~~**Hetzner Storage Box**~~ | off-box backup | **~€4/mo** | ✅ **done** — contracted 2026-07-26 and syncing nightly; this row read `⬜ outstanding` until 2026-08-04 while ten daily dumps were already on it. The gate was "a completed restore, not the order", and that restore now exists: pulled today's dump back **off the Storage Box** and restored it into a throwaway cluster — 95 tables, 227 policies, zero RLS-enabled tables without policies |
| 8 | **6 source API tokens** | free developer tokens | €0 | ⬜ **outstanding** — Product Hunt returns **zero results in production today**; GitLab degraded, Stack Overflow throttled. SourceHut is **retired** (2026-08-04, drizzle/0143) and no longer needs a token — sr.ht's robots.txt disallows feeding a machine learning model, so no token could have made it legitimate |
| 9 | **MinIO + ClamAV** | self-hosted containers | €0 | ⬜ **outstanding** — no account needed; Phase 6 (8 tasks) is implementable as soon as these run |

**Everything with a recurring cost is now contracted.** The Storage Box was already among them — this
paragraph and row 7 both said otherwise until 2026-08-04. The remaining items are free: eight free developer tokens and two self-hosted containers. One-time
later: $5 for the Chrome Web Store when Phase 2 starts.

**What is genuinely blocking, and it is not procurement:** the written no-retention/no-training
confirmations (Deepgram, Mistral), the DPAs, and the **privacy policy, which is public and does not
list Resend, Mistral or Deepgram as sub-processors while Resend is already processing live mail.**
See §11.

Audited against the live Coolify production environment on 2026-07-26 — 63 env entries, and the
`MINIMAX_API_KEY` / `GITHUB_TOKEN` findings above came from that audit rather than from the repo,
which is why they were previously listed as outstanding. Both are empty in local `.env`: dev has no
GitHub rate-limit headroom and no Tier-2 AI, which is a *local* gap, not a production one.

### Deferred by decision — do not buy

| Service | Decision |
| --- | --- |
| Sentry / PostHog / Datadog / PagerDuty | **No paid observability for v1.** Structured stdout logs + `/api/admin/metrics` + `/status` are the launch answer. `VITE_SENTRY_DSN` is a phantom var wired to nothing — delete it, don't fill it. (`02-production-infrastructure/spec.md`) |
| Cloudflare R2 | Replaced by self-hosted MinIO. Env vars keep the `INTERVIEW_R2_*` prefix so switching back is config-only. |
| Self-hosted GPU (Hetzner GEX44, €184/mo) | Break-even is 150–335 interviews/month. Revisit then. |
| Hashnode API key | **Source retired 2026-08-04** (`drizzle/0144`). Hashnode moved its public GraphQL API to a paid offering; re-verified live that day — `gql.hashnode.com` 301s to the announcement and `api.hashnode.com` now 404s. The connector is deleted, so there is nothing a key could enable. |
| LinkedIn (any form) | Hard-blocked in `src/lib/enrichment/policies.ts`. No account, no host permission, no exception. |
| Apple Developer Program ($99/yr) | Only needed for a Safari extension — Phase 6 of `browser-extension-overlay`, not now. |
| Google Calendar / Microsoft Graph sync | Explicit non-goal of the calendar program. No OAuth app needed. |
| ATS vendor credentials (Greenhouse / Ashby / Lever) | Phase 2, and customer-supplied by design. CI never needs live credentials — the plan mandates deterministic fakes. A partner/sandbox account is a research task at spec time, not a purchase now. |

---

## Contracting order

Do them in this order — later items need earlier ones.

```
Wave A (blocking):     1 domain → 2 mailbox → 3 Resend
Wave B (parallel):     4 MiniMax   8 source tokens   9 MinIO+ClamAV   7 Storage Box
Wave C (long lead):    6 Azure OpenAI  ← start the paperwork the same day as Wave A
Wave D (before Ph.9):  5 Deepgram
```

Azure is in its own wave because it is the only one with a possible review queue. Start it early
even though the code that uses it lands last.

---

## 1. `builderhunt.dev` — domain *(~$14/yr)* ⚠️ **not registered**

### Why this is first

`dig builderhunt.dev` returns **NXDOMAIN** — the domain is not delegated, so it is not registered.
Meanwhile the codebase already commits to it in 30 source files:

| Address | Used for |
| --- | --- |
| `noreply@builderhunt.dev` | every transactional email sender (18 references) |
| `privacy@builderhunt.dev` | GDPR/DSAR contact in the privacy policy (13 references) |
| `hello@builderhunt.dev` | **the support/refund contact confirmed to Stripe** in `billing_seller_profiles` v3 |
| `dmca@builderhunt.dev` | DMCA designated agent |
| `legal@builderhunt.dev` | legal notices |
| `support@builderhunt.dev` | footer "Get Support" |
| `alerts@builderhunt.dev` | operational alert emails |

Plus `https://builderhunt.dev/crawler` in `ENRICHMENT_USER_AGENT` (the URL a site owner visits to
find out who is crawling them) and the cron URLs in `runbook.md`.

A published privacy policy naming an address that bounces is a compliance defect, and Stripe's
seller profile points at one of them. This is not cosmetic.

**It was also breaking SEO.** `__root.tsx` emitted `<link rel="canonical" href="https://builderhunt.dev">`
and `sitemap.xml` declared every URL on that host, so a crawler was told the real version of every
page lives at a domain that returns NXDOMAIN. Nothing could be indexed.

### Already fixed (2026-07-26) — no longer waits on the domain

`SITE_URL` was copy-pasted as a hardcoded constant into eight route files plus ten email templates.
It is now derived from the environment in one place — [`src/shared/lib/site-url.ts`](../../src/shared/lib/site-url.ts):
`APP_URL` on the server, `VITE_APP_URL` in the browser, deliberately never
`window.location.origin` (an interim or preview host must not be able to rewrite a canonical URL).

Consequence: **the domain cutover is now three env vars and a redeploy, with zero source edits.**
Canonical tags, `og:url`, `og:image`, JSON-LD ids, `sitemap.xml`, `robots.txt`, `atom.xml` and every
transactional email link follow `APP_URL` automatically. Verified against a running server — with
`APP_URL=http://localhost:3010` served on a different port, all of them emitted `:3010`, and there
was no hydration mismatch.

The seven `@builderhunt.dev` mailbox addresses are deliberately *not* env-derived — they are
identity, not routing, and they are what makes step 2 below necessary.

### ~~Also missing: the `/crawler` page~~ — shipped 2026-07-26

`ENRICHMENT_USER_AGENT` promises `https://builderhunt.dev/crawler` to every site we crawl, and for
a while no such route existed. `src/routes/_landing/crawler.tsx` now serves it (verified `200` in
production 2026-08-13) — that URL is the only way a webmaster can identify the bot, and
`public-enrichment-source-register.md` leans on it.

One copy of that promise stayed broken until 2026-08-13: `src/lib/devpost/worker.ts` announced
`+https://builderhunt.eduardoinerarte.dk/about` — the retired host *and* a path that has never
existed on any host. Three call sites name this page (`env.ENRICHMENT_USER_AGENT`,
`ENRICHMENT_DEFAULT_USER_AGENT`, the Devpost worker) and nothing checks that they agree, which is
why only two of them were updated.

### What to do — ✅ all executed, steps 1–5 on 2026-07-26, step 6 only on 2026-08-13

Kept as the record of the decision, not as an open list. Step 6 is the one that was left hanging
for four days; "Cutover — what actually happened" below is where that is written up.

1. Register `builderhunt.dev` at any registrar with free WHOIS privacy. Porkbun, Cloudflare
   Registrar (at-cost, no markup) and Namecheap are all fine; `.dev` is ~$12–15/yr everywhere
   because Google Registry sets the wholesale price.
2. **Know before you buy**: the entire `.dev` TLD is on the HSTS preload list. HTTPS is mandatory —
   there is no http:// fallback, ever. Not a problem here (Coolify issues Let's Encrypt certs), but
   it means you cannot test with a plain-HTTP staging host on this domain.
3. Point DNS at the VPS: `A @ → 178.105.106.79` and `A www → 178.105.106.79`.
4. Add the domain in Coolify → the app resource → Domains, and let it issue the certificate.
5. Leave `APP_URL` on the `.eduardoinerarte.dk` hostname until the cert is live and the site
   answers on the new one; then switch `APP_URL` + `VITE_APP_URL` + `BETTER_AUTH_URL` together in
   one redeploy. `isTrustedMutationOrigin` hard-403s any unsafe request whose `Origin` ≠ `APP_URL`,
   so a half-switch logs everyone out of mutations. One change, one redeploy, verify a form submit.
6. Update the Stripe webhook endpoint URL and the crontab URLs after the switch.

### Recorded

- **Registrar**: Porkbun LLC, account `eddremonts` — order #11125793
- **Registration date / expiry**: 2026-07-26 → 2027-07-26. **Auto-renew ON** (verified), estimated
  renewal $12.87/yr at cost. Paid $8.75 first year.
- **Registrar lock**: `clientTransferProhibited` + `clientDeleteProhibited` (verified via RDAP)
- **WHOIS privacy**: ON, and **verified against public RDAP** rather than trusting the dashboard
  icon — all four contact roles publish `Whois Privacy / Private by Design, LLC`. The owner's home
  address, phone and personal email are not exposed.
- **DNS host**: Porkbun (`{curitiba,fortaleza,maceio,salvador}.ns.porkbun.com`), Cloudflare-backed
- **Current records** _(re-verified 2026-08-13)_: `A @ → 178.105.106.79` and
  `A www → 178.105.106.79` — the VPS. The Porkbun URL-forwarding A records
  (`207.207.210.50/.36`) are gone, replaced at cutover. Mail did **not** move: the two Porkbun
  forwarding MX (`fwd1`/`fwd2.porkbun.com`) and the SPF TXT (`v=spf1 include:_spf.porkbun.com ~all`)
  are untouched, so §2's mailboxes are unaffected by anything in this section.
- ~~**Interim redirect**~~: was `builderhunt.dev` → `https://builderhunt.eduardoinerarte.dk`,
  **temporary 302**, wildcard on, include-path off. Retired at cutover along with the forwarding
  records. It was a 302 and not a 301 **on purpose**, and the reasoning paid off: browsers cache
  301s hard, and at cutover the redirect had to run the other way (`.dk` → `.dev`). A cached
  permanent redirect pointing backwards would have fought the cutover in every browser that ever
  visited.
- **HTTPS**: ✅ Coolify issued a fresh `CN=builderhunt.dev` (Let's Encrypt, issuer `YR2`) valid
  **2026-08-09 15:39 UTC → 2026-11-07**, which is the hard timestamp for when the cutover
  happened. This replaced Porkbun's redirect-era cert; Coolify renews it now, not Porkbun.
  `.dev` is HSTS-preloaded, so there is no http:// fallback if a renewal ever fails — that is the
  one thing here worth an alert.
- **Cutover to `APP_URL`**: ✅ **done 2026-08-09** — see "Cutover — what actually happened" below.
- **2FA on the registrar account**: _(pending — owner's action)_ ⚠️ this account now holds the
  product's domain, its legal mailboxes, and the support contact Stripe has on file

### Cutover — what actually happened (2026-08-09)

The canonical URL is now `https://builderhunt.dev`. Steps 1–3 of the checklist below ran on
2026-08-09 and worked. **Steps 4 and 5 did not run**, and nothing noticed for four days.

| # | Step | Outcome |
| --- | --- | --- |
| 1 | Replace Porkbun's forwarding `A` records with `A @`/`A www → 178.105.106.79`, in one change | ✅ done |
| 2 | Add the domain in Coolify, let it issue the Let's Encrypt cert before the switch | ✅ done — cert issued 15:39 UTC |
| 3 | Change `APP_URL` + `VITE_APP_URL` + `BETTER_AUTH_URL` **together**, one redeploy | ✅ done — `isTrustedMutationOrigin` hard-403s any unsafe request whose `Origin` ≠ `APP_URL`, so a half-switch breaks every form |
| 4 | Update the Stripe webhook endpoint URL and the crontab URLs | ❌ **missed** — see below |
| 5 | 301 the old `.dk` hostname to the new one | ❌ **missed** — the retired host was dropped from the app's domains instead, so it answers `503 no available server`, not a redirect |

**What step 4 cost.** The old hostname stopped being served, but Stripe was still delivering to
`https://builderhunt.eduardoinerarte.dk/api/webhooks/stripe`. From 2026-08-10 08:27:13 UTC to
2026-08-13 it accumulated **7,870 failed deliveries — 6,950 of them HTTP 503** — and Stripe's
warning mail said it would disable the endpoint on 2026-08-19. Fixed 2026-08-13 by **editing the
existing endpoint in place** (`we_1Twgh6FbQx9fJlcGFSyEvX3l`) rather than creating a replacement:
editing preserves the endpoint's signing secret, so `STRIPE_WEBHOOK_SECRET` in Coolify needed no
change. Creating a new endpoint mints a fresh `whsec_` and turns a one-field edit into a redeploy.

Two things kept the blast radius small, and neither was a control we designed: the endpoint was
**test mode**, so no customer and no real money was involved; and the 503 is the proxy's, which
means the requests never reached the app and no partial state was written.

**Why no gate caught it.** `deploy.yml`'s verification step probes `builderhunt.dev` — correctly,
that is the host that must work. Nothing in this repo asserts anything about a *retired* host,
and nothing can see where a third party has aimed its webhooks. An integration pointed at a
hostname we stopped serving is invisible to every check we own; the only signal was Stripe's own
warning mail, four days in.

**Verified 2026-08-14, once a working Coolify token was available.** The production environment is
consistent with the cutover: `APP_URL` and `VITE_APP_URL` both read `https://builderhunt.dev` in
both rows, and `STRIPE_WEBHOOK_SECRET` is the secret belonging to the endpoint repointed above —
independent confirmation of the delivery test.

Two things that check turned up, neither of them about a hostname:

- **The scheduled tasks did not exist, and creating them was not enough.** `GET
  /applications/{uuid}/scheduled-tasks` returned `[]`, and
  `/api/status` reports `uptime30d: null`, which `src/routes/api/status/index.ts` documents as the
  "no history" case — no `status_checks` row has been written in 30 days. So the every-5-minute
  snapshot and the hourly Devpost worker in [`deploy-runbook.md`](./deploy-runbook.md) are
  documented, not configured. `CRON_SECRET` *is* set and `DEVPOST_ENABLED=true`, so nothing is
  missing except a scheduler. The public `/status` page therefore advertises an uptime figure that
  has never been measured. Same class of defect as the Stripe endpoint above — documented as
  configured, never configured — and again invisible to every gate.

  Two tasks were created on 2026-08-14 (`status-snapshot`, `*/5 * * * *`; `devpost-worker`,
  `0 * * * *`), both against the main container rather than a named one, both invoking `node -e` with
  `fetch` because `node:22-bookworm-slim` does not guarantee `curl`, both reading `CRON_SECRET` from
  the environment rather than carrying it in the command text, and both targeting `127.0.0.1:3000` —
  `isTrustedMutationOrigin` returns true when there is no cookie, so a cron is not refused for
  lacking an `Origin`.

  **They still do not run.** Forty minutes and eight five-minute windows later, `/api/status` still
  reports `uptime30d: null`. The routes are not the problem — both answer `401` to an unauthenticated
  POST, so they exist and their auth works. Whether Coolify never fires them or fires them into a
  failing command is undiagnosed, and needs the scheduled task's execution log in the Coolify UI or
  shell access to the host. Do not mark this fixed on the strength of the tasks existing: their
  existence is what was already assumed and was already false.
- **`BETTER_AUTH_URL` is not set in Coolify, and does not need to be.** `better-auth.ts` passes
  `baseURL: env.APP_URL`, and `env.ts` does not declare `BETTER_AUTH_URL` at all, so nothing reads
  it. The cutover checklist's "change all three together" is really "change the two that exist".
  `.env.production.example` still lists it; harmless, but it is not load-bearing.

---

## 2. Inbound mailbox — receiving on `builderhunt.dev` *(€0–€7/mo)*

Resend **sends only**. Six of the seven addresses above must be able to *receive*, and three of
them (`privacy@`, `dmca@`, `legal@`) are addresses a regulator, a rights-holder or a lawyer writes
to. They cannot be forwarding into nothing.

### What to do

Pick one, cheapest workable first:

| Option | Cost | Notes |
| --- | --- | --- |
| **Registrar email forwarding** → your existing inbox | usually €0 | Simplest. Good enough at launch: forwards `privacy@`, `dmca@`, `legal@`, `hello@`, `support@`, `alerts@` to one mailbox you already read. You cannot *reply as* the address, which looks unprofessional on a legal thread. |
| **Zoho Mail free** | €0 | 5 users, one domain, web/mobile only (no IMAP on free). Real send-as. |
| **Migadu Micro** | ~$19/yr | Unlimited addresses, IMAP/SMTP, no per-user pricing. Best value if you want real mailboxes. |
| **Fastmail / Google Workspace** | ~$5–7/user/mo | Only worth it if you want the rest of the suite. |

**Recommendation**: registrar forwarding on day one (5 minutes, unblocks compliance), Migadu when
you first need to reply *as* `legal@`. Do not spend €7/month on this at zero revenue.

### Watch for

Whatever you choose sets the domain's MX records — and Resend's domain verification also touches
DNS (SPF/DKIM/DMARC). Set MX first, then Resend, then verify both still pass. A DMARC policy of
`p=reject` with a missing SPF include is the classic way to silently kill your own transactional
email.

### Recorded

- **Provider**: Porkbun free email forwarding (included with the domain, €0; 20 forwards allowed,
  6 used). Catchall and wildcard forwards are **not** supported, so each address is explicit.
- **Addresses live**: all six — `hello@`, `support@`, `privacy@`, `legal@`, `dmca@`, `alerts@` →
  the owner's personal inbox (destination recorded in the Porkbun account, not in this repo).
  `noreply@` intentionally has no forward: it is send-only, and Resend owns it.
- **MX**: `10 fwd1.porkbun.com` / `20 fwd2.porkbun.com` — verified resolving through both
  `1.1.1.1` and `8.8.8.8`, not just in the dashboard.
- **SPF**: `v=spf1 include:_spf.porkbun.com ~all` (auto-published). Note for step 3: Resend's own
  verification adds its records on a `send.` subdomain, so it does not collide with this root SPF —
  but re-verify both after adding Resend rather than assuming.
- **DKIM / DMARC**: _(pending — comes with Resend in step 3)_
- **Delivery test**: _(pending)_ ⚠️ send a real message to `legal@` and confirm it lands. Forwarding
  that has never delivered a message is not a mailbox, same logic as the backup rule in §7.

### One trap to avoid on this page

Porkbun ships a **free-trial Email Hosting inbox** pending setup (10 GB, expires 2026-08-10) with a
prominent "Setup Now" banner. Its own fine print: untouched, it is removed at expiry and never
renews; **set it up and it auto-renews at the yearly email-hosting price** — the $36/yr we
deliberately declined at checkout. Free forwarding already covers the requirement. Leave it alone.

---

## 3. Resend — transactional email *(free tier)*

### What it sends

Organization invitations, claim verification links, calendar/interview confirmations and
reschedules with `.ics` attachments, reminder emails (`src/lib/calendar/reminder-worker.ts`), alert
digests. With `RESEND_API_KEY` unset the helpers log a dev link instead of sending — fine locally,
silently broken in production.

### What to do

1. Create an account at resend.com. Free tier: **3,000 emails/month, 100/day, one domain** —
   verify current limits at signup, they change. Pro is $20/month when you outgrow it.
2. Add `builderhunt.dev` as a sending domain and publish the SPF + DKIM records it gives you.
   **Requires step 1 done and step 2's MX in place.**
3. Add a DMARC record. Start at `p=none` with a `rua=` reporting address, watch for a week, then
   move to `p=quarantine`. Do not start at `p=reject`.
4. Create an API key scoped to **sending only** — not full access.
5. Set `RESEND_API_KEY` in Coolify. Do not put it in `.env.example`.
6. Verify by triggering one real send (an org invitation to yourself) and reading the Resend log,
   not just the app log.

```
RESEND_API_KEY=<sending-scoped key>
```

### Recorded

- **Account owner**: `eduardo.inerarte@gmail.com`
- **Sending domain**: `builderhunt.dev` (the **root**, not a subdomain — Resend recommends a
  subdomain for reputation isolation, but the code sends from `noreply@builderhunt.dev` in 18
  places and a subdomain would change the user-visible `From`. Revisit if deliverability suffers.)
- **Region**: **Ireland (eu-west-1)** — Resend's default, and the right one: it keeps email
  processing in the EU, consistent with the Azure EU regions, the Deepgram EU endpoint and the
  EU storage jurisdiction.
- **Verification**: ✅ **Verified** (2026-07-26, ~20 minutes after the records were published —
  well inside the "may take a few hours" warning, because the records were already resolving
  authoritatively before verification was triggered).
- **DNS records added** (all verified resolving, DKIM compared byte-for-byte against what Resend
  issued — one wrong character there fails verification silently):
  | Type | Host | Value | Prio |
  | --- | --- | --- | --- |
  | TXT | `resend._domainkey` | `p=MIGfMA0GCSqGSIb3…QIDAQAB` (218 chars) | — |
  | MX | `send` | `feedback-smtp.eu-west-1.amazonses.com` | 10 |
  | TXT | `send` | `v=spf1 include:amazonses.com ~all` | — |
  | TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:alerts@builderhunt.dev` | — |
- **Root records confirmed untouched**: `MX fwd1/fwd2.porkbun.com` (10/20) and
  `TXT v=spf1 include:_spf.porkbun.com ~all` still in place — the six forwarding mailboxes are
  unaffected. Resend's SPF lives on `send.`, exactly as predicted in §2.
- **DMARC**: started at `p=none` with a `rua=` to `alerts@builderhunt.dev` (a real, forwarded
  address on the same domain, so no external-reporting authorization record is needed). Watch the
  reports for a week, then move to `p=quarantine`. **Do not start at `p=reject`.**
- **API key**: set locally in `.env` and synced to Coolify production
  (env uuid `nrlpr71843jldbld8vtyxu39`, app `l12rscsq1js9t4xr4a9a5zr6`), verified by comparing
  SHA-256 of the stored value against the local one rather than reading either. Coolify mirrored it
  to a `is_preview: true` entry automatically despite `is_preview: false` being posted — that is
  where the duplicate-per-key pattern in this app's env list comes from.
- **Delivery test**: ✅ real send `41df3fb6-4476-402e-8d0d-1a4a936de850`, `last_event: delivered`,
  `message_id` on `eu-west-1.amazonses.com`, from `noreply@builderhunt.dev`. This is the proof that
  the key, domain verification, DKIM signing and SPF alignment all work together.
- **Plan**: free tier — review when monthly volume passes ~2,500
- **DPA**: _(pending)_ Resend offers one — record version and date. Recipients are candidates and
  customers, so this is a **new sub-processor entry in the privacy policy** (see §11).
- **Annual review date**: _(provisioning date + 1 year)_

### The trap on Resend's setup page

Resend also offers an **"Enable Receiving"** block: `MX @ → inbound-smtp.eu-west-1.amazonaws.com`,
**priority 9**. **Never add it here.** Priority 9 outranks Porkbun's forwarding MX at 10/20, so it
would take over inbound mail for the whole root domain and silently break `privacy@`, `legal@`,
`dmca@` and the rest. Resend is send-only for this deployment.

---

## 4. MiniMax — general-purpose server AI *(pay-as-you-go)*

`MINIMAX_API_KEY` is empty everywhere today, which means Tier-2 server AI is **off**: those tasks
return 503 and Chrome's on-device AI keeps working. That is a deliberate, safe default — but it
also means several shipped features are inert in production.

### What to do

1. Create a MiniMax platform account and top up the minimum balance. Pay-as-you-go per token.
2. Create an API key.
3. Set `MINIMAX_API_KEY` in Coolify. `MINIMAX_BASE_URL` and `MINIMAX_MODEL` already default
   correctly (`https://api.minimax.io`, `MiniMax-M3`).

### The absolute rule

`plans/_meta/ai-policy.md` §3: MiniMax is **never** the embeddings provider (that is the
self-hosted Ollama resource) and **never** handles sensitive candidate data (that is Azure OpenAI).
`SENSITIVE_AI_ENABLED` and the `SensitiveAIProvider` interface exist to make that impossible by
accident. Do not "temporarily" point a sensitive task here.

### Recorded

- **Account owner**: _(pending)_
- **Region / data residency**: _(pending)_ ⚠️ MiniMax is a third-country transfer — confirm what
  the privacy policy claims matches reality before enabling
- **No-training confirmation**: _(pending)_
- **Kill switch**: `AI_DISABLED=true` or `AI_DISABLED_TASKS=<ids>`
- **Annual review date**: _(pending)_

---

## 5. Deepgram — live transcription *(pay-as-you-go)*

Full detail in [`interview-provider-register.md` §3](interview-provider-register.md). Summary:
account + API key, **verify the EU endpoint (`wss://api.eu.deepgram.com`) is available on your
plan** — `env.ts` refuses to boot with any other base URL and there is deliberately no fallback —
and get written no-retention/no-training confirmation. ~$0.46–0.92 per 60-minute interview.
Typically ships with ~$200 free credit. Needed before Phase 9.

---

## 6. Azure OpenAI — brief and report generation *(pay-as-you-go)* ⏱ **start early**

Full detail in [`interview-provider-register.md` §4](interview-provider-register.md). Summary:
Azure subscription → an Azure OpenAI resource in one of six allowed EU regions (`westeurope`,
`northeurope`, `francecentral`, `germanywestcentral`, `swedencentral`, `switzerlandnorth`) → a
GPT-4-class deployment, and record the **deployment name** (not the model name) as
`AZURE_OPENAI_DEPLOYMENT`.

**Two things to check on the way in**, because the answer decides your timeline:

1. Whether your subscription can create an Azure OpenAI resource **self-serve**. Microsoft removed
   the general access-request gate for most models, but this varies by subscription type and
   region — try the portal first. If it *is* gated, that is a review queue measured in business
   days, which is why this wave starts on day one.
2. **Modified Abuse Monitoring** (opting out of human review of prompts) is a separate application
   form and, as far as our reading goes, still gated. This is the strongest version of "no human
   sees candidate data", which the DPIA will want. Submit it as soon as the resource exists.

Also: the resource is free idle, but Log Analytics, Private Link, a support plan, or Provisioned
Throughput Units will each add material fixed cost. None are needed. Do not enable them.

---

## 7. Hetzner Storage Box — off-box backup *(~€4/mo)* ✅ **done, and the restore is proven**

> **Status corrected 2026-08-04.** This section described the Storage Box as a future purchase and the
> two items below as having "no off-box copy". Both had been copied nightly since 2026-07-26. Verified
> over SSH: ten daily Postgres dumps (2026-07-26 → 2026-08-04) plus five days of roles captures on
> `u640315-sub1.your-storagebox.de`, and today's dump byte-identical to the VPS copy at 14,881,845
> bytes. The MinIO volume rsyncs in the same 03:30 job.
>
> **The gate this section sets — "a completed restore, not the order" — is now met.** Today's dump was
> pulled back *off the Storage Box* (rsync over port 23; port 22 there is SFTP-only, no shell),
> checksummed unchanged at every hop, and restored into a throwaway `pgvector/pgvector:pg16` cluster:
> 95 tables, 58 RLS-enabled, 227 policies, **zero RLS-enabled tables without a policy**, and real rows
> back (6 `auth_users`, 5 `organizations`, 12 `builders`). The local copies and the VPS scratch
> directory were removed afterwards.
>
> The text below is kept as the original justification for buying it, which still reads correctly — only
> the tense is wrong.

Two things had no off-box copy when this was written:

- **MinIO's volume** — candidate CVs on a single 80 GB disk with no redundancy. If the disk dies,
  those documents are gone. This is the one real trade-off accepted when choosing MinIO over R2.
- **Postgres dumps** — `scripts/db/backup.ts` writes to local disk only, and
  `02-production-infrastructure/spec.md` lists "no restore script, cron unverified" as open gaps. A
  backup on the same disk as the thing it backs up is not a backup.

### The prerequisite, found and fixed (2026-07-26)

Audited in Coolify: `builderhunt-db` → Backups read **"No scheduled backups configured."**
Production had **no database backup at all** — worse than the "unverified cron"
`02-production-infrastructure/spec.md` recorded, because nothing was scheduled in Coolify either.

**Fixed the same session:**

| | |
| --- | --- |
| Schedule | `0 3 * * *` (03:00 UTC — off-peak, clear of the 5-minute status snapshot and the hourly Devpost worker) |
| Database | `builderhunt` |
| Retention | 30 backups / 30 days / **10 GB cap** — was `0/0/0`, i.e. **unlimited**, which on an 80 GB disk shared with Postgres, Redis, Ollama and the app is a disk-exhaustion bug waiting to happen |
| Proven | **executed manually: `Success`, 2 seconds, 5.15 MB.** Not just configured |

**The DB is 5.15 MB**, so 30 dailies is ~155 MB and the 10 GB cap is enormously generous. Which
reframes this whole section: the Storage Box is **not** justified by the database. It is justified by
the MinIO volume — 25 MB per invitation, ~25 GB at a thousand candidates — and by getting *any* copy
off the single box.

Still outstanding, and it is the real gate: **a restore has never been performed.** The safe way is
to pull a dump and restore it into the local `docker-compose` Postgres, never into anything
production-adjacent.

### Storage Box vs Object Storage — pick deliberately

Coolify's native backup can push to an **S3** destination (its "S3 Storages" section). A **Storage
Box is not S3** — it speaks SFTP, SCP, rsync-over-SSH, BorgBackup, Restic, WebDAV and Samba. So:

| | Storage Box (BX11) | Hetzner Object Storage (S3) |
| --- | --- | --- |
| Price | **€3.20/mo** excl. VAT (~€4.00 with DK 25%), 1 TB, €0 setup | more per TB |
| Coolify native DB backup | ✗ needs a custom cron (rsync/Borg) | ✓ direct |
| Rsync/Borg a MinIO volume | ✓ native, this is what it is for | awkward |

Both are needed for different jobs, but the register's two requirements — pg dumps **and** the MinIO
volume — are both served by the Storage Box, so it stays the recommendation. The custom cron for the
DB leg is the price of the cheaper, more suitable target.

### What to do

1. Order a Hetzner Storage Box (**BX11, 1 TB, €3.20/mo excl. VAT, no setup fee, no minimum contract
   period, cancellable immediately**) from hetzner.com → Storage → Storage Box, or from Hetzner
   Console. Same vendor, same invoice as the VPS, **no new sub-processor entry**.
   - **Location: Germany**, matching the VPS (`HETZNER_LOCATION=fsn1`, Falkenstein). Finland is the
     other option; both are EU. Same-location keeps internal traffic cheap and latency low.
   - ⚠️ **The DPA is listed as "optional" on this product.** For candidate CVs it is not optional to
     us — request it explicitly, and record the version and date here.
2. Enable Sub-accounts and create one restricted to the backup directory. Enable snapshots.
3. Point the backup routine at it over SSH/rsync (`BorgBackup` or plain `rsync` over SSH; do not
   use the SMB/CIFS mount for this).
4. **Then actually restore from it once, into a scratch database, and write down that you did.**
   `02-production-infrastructure/spec.md` is explicit: a backup that has never been restored is a
   hope, not a backup.

### Recorded

- **Box ID / plan**: **`622496`**, name `builderhunt-backup`, **BX11 (1 TB)**, `status: active`,
  ordered 2026-07-26. **€4.00/month including Danish 25% VAT** (€3.20 ex-VAT), no setup fee, no
  minimum term, cancellable immediately.
- **Location `fsn1` (Falkenstein)** — deliberately the same as the VPS (`HETZNER_LOCATION=fsn1`).
- **Host / user**: `u640315.your-storagebox.de`, user `u640315`.
- **Where to order, because this moved**: Hetzner **Console** → project → Storage → Storage Boxes.
  **Not Robot** — Hetzner relocated Storage Boxes to Console on 2025-06-25 and retired the Robot Web
  Service API for them on 2025-07-29. Robot now shows only a redirect notice.
- **Access settings — all four off**, verified via API:
  `webdav_enabled: false, samba_enabled: false, ssh_enabled: false, reachable_externally: false`.
  - **`ssh_enabled: false` is correct, not an oversight.** Hetzner's docs: *"The option 'SSH Support'
    only enables port 23. SSH port 22 is always active."* So rsync, BorgBackup, restic, SFTP and SCP
    all work without it; enabling it would only add an interactive shell on port 23 — exposure for no
    benefit.
  - `reachable_externally: false` is the most restrictive default. **Untested from the VPS** — see the
    open question below.
- **Automated snapshots**: plan created via API — **daily 05:00 UTC, max 10**. Deliberately *after*
  the 03:00 DB backup so a snapshot captures the newest dump rather than yesterday's. Was initially
  set to 02:30 and corrected. This is the accidental-deletion and ransomware protection; a
  replication target without snapshots just mirrors a deletion.
- **DPA**: _(pending)_ ⚠️ the product page lists it as **"optional"** and it is not part of the
  creation form. Request it separately and record version and date. For candidate CVs it is not
  optional to us.
- **Sub-account**: id `278254`, user `u640315-sub1`, host `u640315-sub1.your-storagebox.de`, home
  **`builderhunt`** (scoped — never the root credentials), `samba/webdav/reachable_externally` all
  off, `ssh_enabled: true`. Auth is by **SSH key** (`/root/.ssh/storagebox_rsa` on the VPS); the
  creation password is only a break-glass fallback.
  - 🔧 **Correction to the note above about `ssh_enabled`.** Port 22 is SFTP-only (`mod_sftp`, no
    shell). **rsync and Borg need a shell, which is port 23, which is what the "SSH Support" toggle
    enables.** The earlier reading of Hetzner's "port 22 is always active" was wrong for rsync. Key
    auth on port 22 fails with `Permission denied (publickey,password)` no matter the key type; the
    same key works on port 23. The sub-account's own `ssh_enabled: true` is what opened 23 here,
    even with the box-level flag off.
  - Uploading `authorized_keys` by SFTP needs a **relative** path (`sftp://host/./.ssh/...`);
    the absolute form silently fails.
- **What is replicated**: Coolify's DB dumps — `/data/coolify/backups/` →
  `./coolify-db-backups/` via `/usr/local/bin/builderhunt-backup-sync.sh`, cron
  **`30 3 * * *`** (after the 03:00 backup, before the 05:00 snapshot). Log:
  `/var/log/builderhunt-backup-sync.log`. **No `--delete`** on purpose — local retention prunes at
  30 days, the off-site copy keeps history, because surviving a local deletion is the point.
  First run verified: 5,398,272 bytes shipped. **The MinIO volume is not included yet** (MinIO is not
  deployed).
- **First restore test: performed 2026-07-26 — and it found a real defect.** The dump was pulled
  *back down from the Storage Box* (not from local disk, so the off-site copy itself is proven
  readable) and restored into a throwaway `pgvector/pgvector:pg16` container with no exposed ports.

  | | |
  | --- | --- |
  | Restored | 76 public tables, `vector` extension present, data intact (`organizations` 1 row, `builder_identities` 1 row) |
  | Failed | **162 errors, all `role "builderhunt_app" does not exist`** while creating RLS policies and grants |

  🚨 **`pg_dump` of a single database does not include roles — they are cluster-level.** This app's
  entire multi-tenant security model is RLS bound to `builderhunt_app` / `_auth` / `_worker` /
  `_platform`, so every `CREATE POLICY ... TO builderhunt_app` in the dump fails on a fresh
  cluster, and it is invisible unless someone actually tries a restore — which is why this test
  exists.

- **Fixed and re-tested 2026-07-26.** Procedure written, tooling added, and the failure reproduced
  and then eliminated on a genuinely fresh cluster. Full detail:
  [`database-restore.md`](database-restore.md).

  🔧 **Correction to the diagnosis above.** The first write-up said a roles-less restore "returns
  the data without the tenant-isolation policies… a security gap." **Tested, and that overstates
  it in the direction that matters.** `ALTER TABLE … ENABLE ROW LEVEL SECURITY` **and**
  `FORCE ROW LEVEL SECURITY` both restore fine — only the `CREATE POLICY` statements fail. RLS
  forced with zero policies is Postgres's **default-deny** state: measured on the reproduction, a
  `builderhunt_app`-shaped role saw **0 of 198** `organizations` rows, and `FORCE` denies the table
  owner too. So the real consequence is **an unusable database and a longer outage, not exposed
  data.**

  The security gap is second-order but worth naming, because it is the likely human path: an
  operator sees empty pages everywhere and "fixes" it with `DISABLE ROW LEVEL SECURITY` or
  `ALTER ROLE builderhunt_app BYPASSRLS`. That is what turns a recoverable outage into a breach, so
  both the restore script and the runbook now say *don't* in as many words, and `restore.ts`
  hard-fails if any `builderhunt_*` role holds `SUPERUSER`/`BYPASSRLS`.

  | | |
  | --- | --- |
  | Reproduced | fresh `pgvector/pgvector:pg16` container, 0 `builderhunt_*` roles, restored a custom-format dump → **192 errors, 0 policies, RLS still enabled+forced on 54 tables**, row counts perfect (84/198/21/4). The local schema is larger than production's, hence 192 vs the 162 seen against the real dump |
  | Fixed | same dump, same fresh cluster, roles created first → **0 errors, 192/192 policies, 0 tables with RLS-but-no-policies** |
  | Also verified | gzipped custom format, gzipped plain SQL (`backup.ts`), and a captured `pg_dumpall --roles-only` file as the roles source — all four paths pass |

  **What shipped**

  | | |
  | --- | --- |
  | [`docs/operations/database-restore.md`](database-restore.md) | the procedure — the roles rule, full disaster recovery onto a new host, drills, and the "don't disable RLS" instruction |
  | `scripts/db/roles.sql` | idempotent, **password-free** recreation of the six cluster roles. Primary recovery path: in-repo, so it works with backups taken before any of this existed |
  | `tests/unit/security/restore-roles-bootstrap.test.ts` | fails the ordinary `pnpm test` run if `roles.sql` drifts from the role migrations, or if any role ever gains `SUPERUSER`/`BYPASSRLS` |
  | `scripts/db/restore.ts` (`pnpm db:restore`) | rewritten: auto-detects all three archive formats **including Coolify's custom format** (the old script only handled `backup.ts`'s gzipped plain SQL, so it could not have restored a production backup at all), creates roles first, and verifies |
  | `scripts/db/restore-drill.ts` (`pnpm db:restore-drill`) | throwaway-cluster drill, the repeatable form of this test. `--skip-roles` reproduces the defect on demand |
  | `scripts/ops/builderhunt-backup-sync.sh` | the VPS sync script, now version-controlled and with a nightly `pg_dumpall --roles-only --no-role-passwords` capture added |

  **Two things a human still has to do**, and neither blocks recovery:

  1. **Copy the sync script up to the VPS** (`scp` line in [`../runbook.md`](../runbook.md) §
     pending decisions). Until then tonight's off-site copy still has no roles dump — recovery is
     unaffected, because `scripts/db/roles.sql` is the primary path and needs nothing from the box.
  2. **Re-run the drill against a dump actually pulled back from the Storage Box.** The fix was
     proven against a locally generated dump in Coolify's exact format on a fresh cluster; the
     off-site copy's own readability was already proven in the first test. Doing both legs in one
     run needs VPS access.

  **`--no-role-passwords` is deliberate**: a backup target must never hold credential material.
  Role passwords come from the Coolify `DATABASE_*_URL` vars via `pnpm deploy:db` step 5, exactly
  as on a normal deploy.

  **Why the existing rehearsal never caught this**, which is the reusable lesson:
  `scripts/db/restore-test.ts` restores between two databases on **one** server —
  `assertRestoreTestTargets` requires the same host on purpose — and a same-cluster restore always
  finds the roles already there. It had been passing for months. **A restore rehearsal that reuses
  the cluster cannot prove a restore works.**

### Reachability: resolved by testing from the VPS (2026-07-26)

`reachable_externally: false` does **not** block the Hetzner Cloud VPS. Tested over SSH from
`conductor-01`:

```
DNS   u640315.your-storagebox.de → 2a01:4f8:bacc:2:200::1717   (IPv6 only)
TCP   port 22 OPEN
SSH   SSH-2.0-mod_sftp
```

So the most restrictive setting is also a working one — nothing needs opening. Two notes: the host
resolves **IPv6-only**, so anything on an IPv4-only path will fail; and on the VPS **`rsync` is
installed while `borg` and `restic` are not**, which makes rsync-over-SSH the zero-install choice.

Coolify's web terminal was not usable for this — the dashboard reports *"Cannot connect to real-time
service"*, so its websocket is down. The test was run over SSH using the key Coolify keeps for its
own host (`localhost's key`, retrievable from `GET /api/v1/security/keys`); it was written to a
0600 scratch file and deleted afterwards.

### 🚨 The real blocker for MinIO is disk, and it is not the data

Measured on `conductor-01`: **75 GB total, 16 GB free, 79% used.** At 25 MB per invitation, 1,000
candidates is ~25 GB — **that does not fit today**, which undercuts the "MinIO fits free on the box
we already pay for" premise in the decision at the top of `interview-provider-register.md`.

But the data is not what fills it. Docker is:

| | |
| --- | --- |
| Images | 35 (22 active), **53.32 GB**, of which **15.72 GB reclaimable** |
| Build cache | 83 entries, **11.79 GB, fully reclaimable** |
| Containers | 24.67 MB |
| Local volumes | 987.5 MB total — builderhunt's Postgres is **80 MB**, Ollama 262 MB, largest 377 MB |

**~27.5 GB is reclaimable**, which would take the box from 16 GB free to roughly 43 GB — and then
MinIO does fit. This is accumulated build artefacts from repeated deploys across twelve apps, not
growth in anything that matters.

**Pruned 2026-07-26, product-owner decision** ("we can always redeploy whatever fails"). Result:

| | Before | After |
| --- | --- | --- |
| Free | 16 GB (79% used) | **39 GB (47% used)** |
| Build cache | 11.79 GB | 0 |
| Images | 53.32 GB, 35 (22 active) | 29.28 GB, 21 — **all 21 active, 0 reclaimable** |
| Containers | 24 | **24, none unhealthy** |
| Volumes | 8 / 987.5 MB | **8 / 987.5 MB — untouched** |

`docker builder prune -af` + `docker image prune -af` + `docker network prune -f`.
**Never `--volumes`** — that would have destroyed the 80 MB production Postgres volume.

Verified after: 24 containers up, none unhealthy, `/api/health` 200, `/api/status` ok with db
healthy, `builderhunt.dev` 200, Coolify responding.

Useful surprise: `docker system df` claimed 15.72 GB of images were reclaimable but the prune
recovered only 2.8 GB, because Coolify keeps prior images *tagged* and therefore referenced. So the
"redeploy the previous successful image" rollback path in `deploy-runbook.md` largely survived the
prune — the caution was warranted but the cost was lower than the estimate suggested.

**MinIO now fits**: 39 GB free against ~25 GB for a thousand candidates. Still worth watching, and
the sizing premise should be re-checked before Phase 6 goes live rather than assumed from this
one-off cleanup — build cache will regrow with every deploy.

---

## 8. Source API tokens — 8 free developer accounts *(€0)*

All free. Two sources return **nothing at all** without a token, four are severely rate-limited
without one, and none of them cost money. Do these in one sitting — it is an hour of clicking that
measurably widens coverage.

| Source | Env var | Required? | Where | Effect |
| --- | --- | --- | --- | --- |
| ~~**SourceHut**~~ | ~~`SOURCEHUT_TOKEN`~~ | **retired** | — | **Retired 2026-08-04** (drizzle/0143). Do not create this token. sr.ht's robots.txt prose policy disallows "anything used to feed a machine learning model", which is what this product does, so the token would not have made the use permitted — and the API offered no user or repository search regardless. |
| **Product Hunt** | `PRODUCTHUNT_TOKEN` | **REQUIRED** | api.producthunt.com/v2/docs → Developer Token | v2 GraphQL mandates auth — nothing without it. |
| **GitHub** | `GITHUB_TOKEN` | strongly | Settings → Developer settings → PAT (fine-grained, **public read only, no scopes needed**) | 60 req/h → 5,000 req/h. GitHub is the primary source; unauthenticated is unusable at any real volume. |
| **GitLab** | `GITLAB_TOKEN` | strongly | gitlab.com → Settings → Access Tokens, `read_api` | 2,000/h → 6,000/h **and** unlocks real user/project search. Unauthenticated search is 401, so without it GitLab degrades to sampling the top 500 starred public projects. |
| **Stack Overflow** | `STACKOVERFLOW_API_KEY` | yes | stackapps.com/apps/register | 300/day/IP → 10,000/day. |
| **Reddit** | `REDDIT_CLIENT_ID` + `_SECRET` | yes | reddit.com/prefs/apps → create app, type **script** | The connector uses `client_credentials` app-only OAuth, which needs a confidential client. |
| **Hugging Face** | `HUGGINGFACE_TOKEN` | optional | Settings → Access Tokens, **read** scope | Raises rate limits. |
| **Codeberg** | `CODEBERG_TOKEN` | optional | Settings → Applications | Raises rate limits. `CODEBERG_API_URL` can also point at any Gitea/Forgejo instance. |

No token needed, working today: Bluesky (`public.api.bsky.app`), Hacker News (Algolia), dev.to,
npm registry, Lobsters. Skip: Hashnode — **source retired 2026-08-04**, connector deleted (`drizzle/0144`).

### Rules for all eight

- Create them under a **project-specific account or a dedicated bot identity** where the platform
  allows it, not your personal admin account — a leaked PAT should not compromise your own repos.
- Fine-grained / read-only scope everywhere. None of these connectors write.
- Record the expiry date. GitHub and GitLab fine-grained tokens expire and the failure mode is a
  source quietly returning fewer results.

### Recorded

| Token | Created | Scope | Expires | Set in Coolify |
| --- | --- | --- | --- | --- |
| ~~`SOURCEHUT_TOKEN`~~ | **not needed** | — | — | — (source retired 2026-08-04) |
| `PRODUCTHUNT_TOKEN` | _(pending)_ | | | |
| `GITHUB_TOKEN` | _(pending)_ | | | |
| `GITLAB_TOKEN` | _(pending)_ | | | |
| `STACKOVERFLOW_API_KEY` | _(pending)_ | | | |
| `REDDIT_CLIENT_ID` / `_SECRET` | _(pending)_ | | | |
| `HUGGINGFACE_TOKEN` | _(pending)_ | | | |
| `CODEBERG_TOKEN` | _(pending)_ | | | |

---

## 9. MinIO + ClamAV — self-hosted, no vendor *(€0)*

Not purchases — two containers in the Coolify project. Full deployment detail in
[`interview-provider-register.md` §1–§2](interview-provider-register.md): MinIO on internal port
9000 with one private bucket and a scoped service account (never root credentials), ClamAV on
internal 3310 with ≥1.5 GB RAM (below that it OOMs loading signatures).

Listed here so the register is complete: **Phase 6 needs no external account at all** and is
implementable today. Disk pressure is the thing to watch — 80 GB shared with Postgres, Redis,
Ollama and the app, at ~25 MB per invitation.

---

## 10. Phase 2 — not yet, but know the price

| Item | Cost | When |
| --- | --- | --- |
| **Chrome Web Store developer account** | **$5 one-time** | Before the first extension submission (`browser-extension-overlay` v1). Store upload stays manual in v1. |
| Mozilla AMO account | €0 | Phase 6 of the same plan. |
| Apple Developer Program | $99/yr | Safari extension only. Also needs Xcode. Defer until there is demand. |
| ATS partner/sandbox access (Greenhouse → Ashby → Lever) | unknown — research task | Credentials are customer-supplied by design; CI uses deterministic fakes and never needs live keys. Lever additionally needs an OAuth app (a second credential model), deliberately out of scope until the first two ship. |

---

## 11. Non-credential blockers

These gate the same launches and cannot be bought.

| Item | Who | Notes |
| --- | --- | --- |
| **DPIA** | You + data-protection advisor | Required before production voice launch. Narrower now: storage and scanning are first-party, so only Deepgram, Azure, MiniMax and Resend are third-party transfers. |
| **Security/privacy reviewer sign-off** | A named human | `calendar-…/spec.md` requires a reviewer to sign the interview register once accounts exist. |
| **Legal review of consent basis + retention** | Legal advisor | Consent wording and the 90-day / 180-day / 24-month retention ceilings. |
| **Sub-processor list in the privacy policy** | You | Every account created above that touches user data is a new entry: Resend, MiniMax, Deepgram, Azure, Hetzner. The policy currently claims fewer. |
| **Canonical tenant/RLS release gate** | You (in-flight) | The `security-and-multitenancy` cutover. |
| ~~**First successful backup restore**~~ | Done 2026-07-26 | Restore performed, found the missing-roles defect, fixed it, and re-tested on a fresh cluster: 0 errors, 192/192 policies. Procedure in [`database-restore.md`](database-restore.md). Two non-blocking follow-ups in §7: ship the updated sync script to the VPS, and re-run the drill against a dump pulled back from the Storage Box. |
| ~~**Delete `VITE_SENTRY_DSN`**~~ | Done 2026-07-26 | Removed from `.env.production.example` and the README env table. `02-production-infrastructure/tasks.md` claimed this was already "removed from both files" — it was not; it survived in the production example and the README, which is how a phantom var outlives its own deletion. Confirmed absent from the Coolify production env too. |
| **Coolify `COOLIFY_APP_UUID` is ambiguous** | Done — documented | One variable, twelve apps on the server; the stored value points at `edd-app-template`. Resolve by name from `GET /api/v1/applications` before writing env vars or deploying — Coolify returns 200 when you target the wrong app. Documented in `ai-os` (`env-config-and-secrets`, both Coolify skills, the dossier and its example). |
| **Coolify API is plain HTTP** | You | `COOLIFY_API_URL` is `http://178.105.106.79:8000` — the API token crosses the public internet in cleartext on every deploy, including from GitHub Actions. Put it behind TLS. |

---

## Change log

- **2026-07-26** — Register created. Swept the repo for every external dependency: `.env.example`,
  `.env.production.example`, `env.ts`, all 17 source connectors, phase-1 and phase-2 plans, and the
  four existing operations registers. Key finding: `builderhunt.dev` is **not registered**
  (NXDOMAIN) while 30 source files and the live Stripe seller profile already depend on it.
- **2026-07-26** — `SITE_URL` centralized into `src/shared/lib/site-url.ts` (was hardcoded in 8
  route files + 10 email templates). Domain cutover is now env-vars-only. Mailbox choice recorded:
  registrar forwarding first, Migadu when replying *as* `legal@` matters.
- **2026-07-26** — **Steps 1 and 2 complete.** `builderhunt.dev` registered at Porkbun (order
  #11125793), auto-renew on, registrar-locked, WHOIS privacy verified against public RDAP. Six
  forwarding addresses live with MX confirmed through public resolvers. DNS left on Porkbun parking
  by design; cutover checklist recorded in §1. Next: Resend (§3), then the Wave B tokens (§8).
- **2026-07-26** — Interim `302` URL forward `builderhunt.dev` → the `.dk` host. HTTP confirmed;
  HTTPS waiting on Porkbun's Let's Encrypt issuance (`_acme-challenge` records observed in the
  zone, so it is in progress). Resend account created, root domain added in `eu-west-1`, all four
  DNS records published and verified authoritatively, root MX/SPF confirmed intact. Remaining on
  Resend: sending-scoped API key into Coolify (owner's action) and the DPA reference.
- **2026-07-26** — Both waits resolved. Let's Encrypt issued the `builderhunt.dev` cert ~28 min
  after the forward was set, so `https://builderhunt.dev` now reaches the live site; Resend's
  domain went **Verified** ~20 min after the records landed. **Wave A is done.**
- **2026-07-26** — `RESEND_API_KEY` synced to Coolify production and the app redeployed
  (deployment `ahml68wpbuxfc98e6l8r0t47`, commit `140feb34`, `finished`; `/api/status` `ok` with
  db healthy and 85s uptime confirming the restart). Delivery proven end-to-end from local.
  Open owner actions: test message *to* `legal@`, 2FA on Porkbun, and deciding what to do with 25
  unpushed local commits.
- **2026-07-26** — **Restore gap closed.** The first restore test's 162 `role … does not exist`
  errors were reproduced on a fresh cluster (192 locally, larger schema), then eliminated: roles
  are now created before `pg_restore`. Shipped `docs/operations/database-restore.md`,
  `scripts/db/roles.sql` + a drift test, a rewritten `scripts/db/restore.ts` that also handles
  Coolify's custom format (the old one only read `backup.ts`'s gzipped plain SQL, so it could not
  have restored a production backup), `scripts/db/restore-drill.ts` for fresh-cluster drills, and a
  roles capture in the now-version-controlled `scripts/ops/builderhunt-backup-sync.sh`. Re-tested:
  **0 errors, 192/192 policies, 0 tables with RLS-but-no-policies.** Also corrected the original
  diagnosis — the failure is fail-closed (a tenant role saw 0 of 198 rows), so it is an unusable
  database rather than exposed data; the security risk is an operator "fixing" it by disabling RLS.
  The reusable lesson: `restore-test.ts` passed for months because it restores within one cluster,
  where the roles already exist. Outstanding: copy the sync script to the VPS, and re-run the drill
  against a dump pulled back from the Storage Box (both need host access).
- **2026-07-26 (correction)** — An earlier entry here claimed the deploy credentials had no local
  copy and called it a bus-factor gap. **That was wrong.** They live in
  `ai-os/dev-env/env-config/.env`, which `ai-os/CLAUDE.md` already designates as canonical; the
  search that "proved" their absence was truncated with `head -8` over a repo full of skill docs.
  Corrected, and the real gaps found while chasing it — inconsistent variable names across the
  `ai-os` skills, and an ambiguous `COOLIFY_APP_UUID` pointing at a different app — are fixed there.
  The plain-HTTP Coolify API in §11 stands and is unrelated.
