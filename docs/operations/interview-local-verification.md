# Verifying the interview features locally

This is the manual path for the parts of the interview feature that are already built — Phases 6 to 9,
which is candidate documents, briefs, and the live transcription session. It exists because the automated
gate proves the code and says nothing about whether the thing boots on your machine.

Everything below was run on 2026-07-28 and the results are recorded as they came out, including one
finding about the shared local database.

## Two levels, and they answer different questions

**The automated gate** answers "does the logic hold". Run it and it will tell you the truth:

```bash
pnpm ci:local
```

18 steps, `schema-audit` informational. Last run: 4008 unit tests, 94 migrations applying twice clean,
`rlsMissing: 0`. The interview-specific subset is 406 tests across 15 files:

```bash
pnpm vitest run tests/unit/lib/interviews tests/unit/modules/interviews tests/unit/routes/api/interviews
```

Those are not shallow. The route tests run against a real disposable Postgres with the real least-privilege
roles and real RLS policies; the outbox tests run against a real IndexedDB; the session-service tests run
the real billing platform including reservations and settlements. What is faked is the AI provider, the
transcription provider, and the browser's media devices.

**The manual path** answers "does it run". That is the rest of this document.

## The shared local database is behind, and `pnpm db:migrate` will not fix it

Checked on 2026-07-28 against the `builderhunt` database on `localhost:5432`:

- 88 rows in `drizzle.__drizzle_migrations`, against 94 migration files.
- **10** files whose hash is absent from that table, not 6 — `0084` through `0093`.
- **4** rows in the table whose hash matches no current file. Those are migrations that were applied and
  whose files were later edited: `0084` and `0092` were both hand-reordered for the drizzle-kit 42830
  problem, so their content changed after this database recorded them.
- None of `candidate_documents`, `interview_briefs`, `interview_sessions` or `transcript_segments` exists.

Drizzle applies by hash, so `pnpm db:migrate` would re-run `0084` — a `CREATE TABLE` whose table is absent
but whose neighbours are not — and stop somewhere in the middle. **Recreate the database instead.** It is a
development database; the cost is whatever local data is in it, and `db:seed:admin` puts the admin back.

```bash
dropdb builderhunt && createdb builderhunt && pnpm db:migrate && pnpm db:seed:admin
```

Verified on a fresh database on 2026-07-28: all 94 migrations applied, and all eight interview tables came
out with `rowsecurity = true` **and** `forcerowsecurity = true`, with 30 policies across the family.

### Or verify without touching your database

`scripts/dev/make-verify-env.mjs` derives a shell-sourceable env file pointing at a throwaway database:

```bash
createdb builderhunt_verify
node scripts/dev/make-verify-env.mjs --database builderhunt_verify --out .env.verify
echo ".env.verify" >> .git/info/exclude
set -a && . ./.env.verify && set +a || { echo "no .env.verify — refusing to start"; exit 1; }
pnpm exec drizzle-kit migrate && pnpm exec tsx --env-file=.env scripts/db/seed-admin.ts
pnpm exec vite dev --port 3011
```

> **The `||` matters.** The first version of this recipe was `set -a; . ./.env.verify; set +a; pnpm exec
> vite dev`, and semicolons do not stop on failure. When `.env.verify` was later deleted, the sourcing
> failed, the server started anyway, dotenv loaded `.env`, and a process labelled "verify" was quietly
> talking to the *real* development database with production defaults. Two servers whose names promised
> different environments were reading the same one — which is worse than a difference, because you would
> have no reason to check. Fail loudly instead.

The script exists because `pnpm dev` reads `.env` through dotenv and that is **not** the same as sourcing
it in a shell. Three differences, each of which produced a failure that looked like an application bug:

| Trap | What dotenv does | What a shell does | How it surfaced |
| --- | --- | --- | --- |
| `FLAG=false   # note` | value is `false` | value is `false   # note` | ZodError on boot about a flag nobody touched, whole app 500s |
| `GITHUB_TOKEN=` | treated as absent, schema default applies | exported as an empty string | enum/required field fails validation |
| Renaming the database by string replace | — | also renames the *user* in `postgresql://builderhunt_auth:…` | every role connection fails 28P01, every route returns 500 |

The third one cost the most time: a 500 from `/api/interviews/…/session` looks exactly like a bug in that
route. It was a broken connection string. The script rewrites `URL.pathname` only.

> The generated file holds the same secrets as `.env` in plaintext. Exclude it from git and delete it when
> you are done.

## What responds, and what it should say

Measured on 2026-07-28 against the fresh database, unauthenticated, from the browser console:

| Request | Flag off | Flag on |
| --- | --- | --- |
| `GET /api/interviews/:id/session` | 401 | 401 |
| `GET /api/interviews/:id/segments` | 401 | 401 |
| `POST /api/interviews/:id/session` | 503 `transcription_disabled` | 401 |
| `POST /api/interviews/:id/transcription-token` | 503 `transcription_disabled` | 401 |
| `POST /api/interviews/:id/segments` with `content-type: audio/webm` | 400 `bad_request` | 400 `bad_request` |
| `GET /interviews/:id/live` (page) | redirect to sign-in | redirect to sign-in |

Three things worth noting in that table.

**The feature flag is checked before authentication on the write paths.** So an undeployed feature answers
503 rather than leaking that a session exists behind an auth wall.

**Authentication is checked before the body is parsed.** Which is why the payload validations (a reordered
batch, an oversized batch, a smuggled `audio` field) all answer 401 unauthenticated — you should not tell an
anonymous caller that their payload was malformed. Those refusals are covered by
`tests/unit/routes/api/interviews/session-routes.test.ts`, where the caller has a principal.

**The audio content-type refusal is 400 in both columns**, before the flag and before auth. That is
`assertJsonRequest`, and it is the outermost guard on purpose.

## Clicking through it

Sign in as the seeded admin, then:

1. **`/interviews/<calendar-event-id>`** — the brief page (Phase 8). Needs a calendar event with a
   `scheduling_invitations` row pointing at it via `booked_event_id`, and a `candidate_submissions` row. With
   `SENSITIVE_AI_ENABLED=false` the brief still generates: you get the **deterministic fallback**, which
   says "built without AI" on its face. That sentence is the point — a fallback presented as model output
   would be the most misleading thing the page could do.
2. **`/interviews/<calendar-event-id>/live`** — the workspace (Phase 9). What you can check without a
   second person:
   - The preflight refuses to enable the checkbox when there is no `privacy_consents` row with purpose
     `live_audio_transcription`, and says so.
   - With a consent row, the receipt names the notice version and the decision date.
   - The verbal-reminder checkbox starts unticked and **Share tab and start** stays disabled until you tick
     it.
   - In a non-Chrome browser, or Chrome on Linux, the page says which and offers notes only. It never offers
     microphone-only transcription.
   - **Continue without transcription** works from every state and the transcript panel then says
     "Not transcribing this interview. Your notes are still saved."

What you cannot check alone is the part that needs two people and real audio. That is
[interview-runtime-verification.md](interview-runtime-verification.md), and it is not done.

## What is not verified anywhere yet

Honest list, so nothing here reads as more finished than it is.

- **No live Deepgram call has ever been made.** `createSessionToken` is tested against a mocked `fetch`
  including a provider that echoes the master key back. Whether the real `/v1/auth/grant` returns the shape
  this code expects is unmeasured.
- **No live Mistral brief has been generated.** `SENSITIVE_AI_ENABLED` has never been on in any environment.
  MiniMax, by contrast, has been called for real — four runs, and roughly one in four failed schema
  validation, which surfaces as a 502 `ai_parse_failed`. Expect the same class of problem from Mistral until
  measured.
- **Two cron entries do not exist yet:** `interviews.document-processing` and `interviews.web-import`. Until
  they are scheduled, an uploaded document stays `pending` and a submitted link is never imported, so a
  brief built from them reports no evidence rather than failing.
- **The browser capture matrix** has been exercised against mocked media only.
