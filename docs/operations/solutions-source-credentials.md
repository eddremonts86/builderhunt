# Credentials to create, so the seven job sources can be tested

Four sign-ups. Three of the seven sources need nothing at all — they are listed at the bottom so nobody goes
looking for a key that does not exist.

Every URL below was checked on 2026-08-02 and resolves. USAJOBS blocks a plain `curl` User-Agent and answers a
normal browser, so open it in one.

---

## 1. Adzuna — 10 minutes, instant key

**Sign up:** https://developer.adzuna.com/signup
**Docs:** https://developer.adzuna.com/docs/search

Give the form an app name and a URL; the `app_id` and `app_key` appear on the dashboard straight away. Free
tier, no approval step.

```bash
ADZUNA_APP_ID=...
ADZUNA_APP_KEY=...
ADZUNA_COUNTRY=gb        # gb, us, de, fr, es, … — see the docs. Wrong country = wrong market, silently.
```

Ask them for whichever country matters most; the adapter reads one at a time. `gb` is the default only because
something had to be.

---

## 2. USAJOBS — same day, e-mail confirmation

**Request a key:** https://developer.usajobs.gov/apirequest/ *(open in a browser — a bare `curl` gets a 403)*
**Docs:** https://developer.usajobs.gov/api-reference/get-api-search

They e-mail the key. The e-mail address you register **is** the User-Agent value they expect on every request —
their terms require a contact address in that header and refuse requests without one.

```bash
USAJOBS_API_KEY=...
USAJOBS_USER_AGENT=you@yourdomain.com    # the address you registered with, not a browser string
```

---

## 3. France Travail — approval needed, and one piece of work left

**Register:** https://francetravail.io/inscription
**Then:** create an application and subscribe it to **“Offres d'emploi v2”**.

You get a `client_id` and a `client_secret`, not a token. Their auth is OAuth2 client-credentials, so a
short-lived bearer has to be minted per run.

> **This one cannot be tested the moment you have the credentials.** The adapter reads
> `FRANCE_TRAVAIL_ACCESS_TOKEN` as a ready-made bearer, and the token exchange is **not implemented** — I left
> it out rather than shipping a stub that would be the least-tested code in the file. Getting the credentials
> is still worth doing now, because the exchange is a small piece of work and it cannot be written blind.

```bash
FRANCE_TRAVAIL_CLIENT_ID=...       # not read by the adapter yet
FRANCE_TRAVAIL_CLIENT_SECRET=...   # not read by the adapter yet
FRANCE_TRAVAIL_ACCESS_TOKEN=...    # what the adapter reads today; something must mint it
```

A manually minted token is enough to prove the parser against a real payload once, which is the main thing
missing.

---

## 4. InfoJobs — approval needed, can take days

**Developer portal:** https://developer.infojobs.net/

Register an application; they issue a `client_id` and a `client_secret` used as HTTP Basic. Their approval is
manual and historically the slowest of the four, so start this one first even though it is last here.

```bash
INFOJOBS_CLIENT_ID=...
INFOJOBS_CLIENT_SECRET=...
```

---

## Need nothing — already testable today

| Source | Why | Optional variable |
| --- | --- | --- |
| **JobTech Dev** (Sweden) | Fully open. Probed live on 2026-08-02 with no key. | `JOBTECH_DEV_API_KEY` raises rate limits only |
| **The Muse** | Page 1 answers unauthenticated. Key at https://www.themuse.com/developers/api/v2 | `MUSE_API_KEY` raises rate limits only |
| **Arbeitsagentur** (Germany) | Uses `X-API-Key: jobboerse-jobsuche`, the public client key their own web app sends. Hard-coded. | `ARBEITSAGENTUR_API_KEY` if they ever issue partner keys |

These three can be enabled and run **right now**, and doing that is the cheapest way to find out whether the
whole ingestion path works before any credential arrives.

---

## How to test one, once you have its key

```bash
# 1. Put the variables in .env
# 2. Enable the source (platform admin)
curl -X POST http://localhost:3010/api/admin/solutions/sources \
  -H 'content-type: application/json' \
  -d '{"action":"enable","key":"adzuna_jobs"}'
# 3. Run the ingestion and read what landed
pnpm solutions:project
```

**Watch for `unexpected_response_shape`.** Four of the seven parse a shape taken from published documentation
rather than a response anyone has seen — Adzuna, USAJOBS, France Travail and InfoJobs — so the first real run
is their first test. That failure is deliberate and loud: it means the served payload differs from the docs,
and the fix is a parser change, not a retry. `src/lib/solutions/sources/credentialed-job-feeds.ts` has the
evidence table at the top.

Also worth a look on the first run: `emptyAfterFieldFilter` in the run summary. Anything above zero means the
adapter emitted metadata keys the register does not allow, and those fields were dropped silently — the check
that catches it is `metadataKeys` versus `allowed_fields`, and it has caught exactly this before.

---

## Two things I would do in this order

1. **Enable the three that need nothing, today.** They prove the ingestion path end to end, and if something is
   broken it is broken for all seven.
2. **Start the InfoJobs application first**, because its approval is manual and the other three are same-day or
   instant.
