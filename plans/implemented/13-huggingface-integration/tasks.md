# Tasks: Hugging Face Integration

> **Status**: `implemented` (only the explicitly-optional item remains)
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: Connector + wiring shipped. `.env.example` docs delivered 2026-07-25.
> Remaining: an optional author-profile enrichment ("build only on demonstrated need"-style
> nice-to-have, not required for the plan to be considered done).


## Status reconciliation (2026-08-11)

Moved to `plans/implemented/` on the strength of this, so the folder means one thing: **every task checked,
and `pnpm ci:local` green at 34/34 steps** (6,543 unit tests, 996 e2e) on commit `90527722e`.

Why the status changed: was `partially-implemented`. The only remaining item is an optional author-profile enrichment its own task text marks "build only on demonstrated need".

The eight status values previously in use across phase-1 — `complete`, `done`, `in_progress`, `retired`,
`closed — skipped`, `engineering-complete`, `code-complete-dark`, `pending — implementation-ready` — are
outside the five `scripts/check-phase-readiness.mjs` accepts, and that script only ran against phase-2 and
phase-3. A status no gate reads is a status that drifts, which is how four plans sat at 100% of their tasks
while still labelled `pending`.

## Delivered

- [x] **Create HF connector (models + aggregated authors)** — Done:
      `src/lib/sources/huggingface.ts` (`searchHuggingFace(keywords, {page, perPage})`;
      `/api/models?search=` + author aggregation; private models filtered; errors return `[]`).
- [x] **Register in federated search** — Done: `src/lib/search.ts`; `huggingface` in
      `SourceName` (`src/lib/sources/types.ts`).
- [x] **Add `HUGGINGFACE_TOKEN` env var** — Done: `src/shared/lib/env.ts` (optional bearer).
- [x] **UI source pill + metadata** — Done: `ALL_SOURCES` + `SOURCE_META.huggingface` in
      `SearchPage.tsx` (opt-in); `PersonResultCard.tsx`.
- [x] **Brand icon + badge** — Done: `HuggingFaceIcon` in `BrandIcons.tsx`;
      `.badge-huggingface` in `src/shared/styles/globals.css`.
- [x] **Scoring** — Done: `huggingface` branch in `src/lib/score.ts` (log total-downloads
      bonus; downloads/likes as popularity proxies).

## Remaining

- [x] **Document `HUGGINGFACE_TOKEN` in `.env.example`**
  - Files: `.env.example`
  - Do: add `HUGGINGFACE_TOKEN=` under "External Source API Tokens" (comment: optional,
    raises rate limits; from huggingface.co Settings > Access Tokens, read scope).
  - Verify: `grep HUGGINGFACE_TOKEN .env.example` prints the documented line.
  - **Done.**

- [x] **(Optional) Enrich top authors with avatar + real followers**
  - Files: `src/lib/sources/huggingface.ts`
  - Do: after author aggregation, for the top 5 authors by total downloads call
    `GET https://huggingface.co/api/users/{username}/overview` in parallel (try/catch per
    call); when it succeeds, set `avatarUrl` and replace the likes-proxy `followersCount`
    with the real `numFollowers`, keeping the aggregate values in `metadata`.
  - Verify: search "llama" with only the HF pill active; the top author cards show avatars;
    when the overview endpoint is blocked (e.g. offline), results equal today's output.

  **Done 2026-08-03, with one addition the task text could not have anticipated.**

  `HF_ENRICH_LIMIT = 5` authors by total downloads get a profile lookup, in one parallel burst, each call
  independently caught and bounded by a 4s timeout. `avatarUrl` and `numFollowers` replace the aggregate's
  likes-proxy `followersCount`; every aggregate figure stays in `metadata`, plus a `followersSource` marker so a
  reader can tell a real follower count from the proxy.

  ### The addition: most top authors are organizations, and they 404 on `/api/users`

  Checked live before writing anything, per this repo's standing discipline. `/api/users/{name}/overview` works
  unauthenticated and returns exactly the two fields this task wants — but the highest-download authors on
  Hugging Face are overwhelmingly *organizations*, and every one of them answers **404** there. Enriching only
  through the users endpoint would therefore have left precisely the authors this feature exists for with no
  avatar, which is the opposite of its intent.

  Organizations answer on `/api/organizations/{name}/overview` with an `avatarUrl` but **no follower count at
  all** — they report `numUsers`/`numModels` instead. So the connector tries users first (the only account kind
  that reports followers, which is what makes the real figure reachable) and falls back to organizations for the
  avatar alone. Calling `numUsers` a follower count would be inventing a metric, so an organization keeps the
  likes proxy and `followersSource` stays absent.

  ### Live evidence, `searchHuggingFace(['llama'])` on 2026-08-03

  ```
  meta-llama     avatar=YES  followers=25364  source=likes-proxy         (organization, 404 on /api/users)
  NousResearch   avatar=YES  followers=666    source=likes-proxy         (organization)
  dphn           avatar=YES  followers=308    source=likes-proxy         (organization)
  DavidAU        avatar=YES  followers=6390   source=huggingface_profile (user; likes proxy was 651)
  mlabonne       avatar=YES  followers=8190   source=huggingface_profile (user; likes proxy was 201)
  --- past the limit: pangram, nvidia, Moore2877 — no avatar, untouched
  ```

  Three of the top five are organizations, including the first. Under a users-only implementation those three
  would have had no avatar.

  ### Tests

  `tests/unit/lib/sources/huggingface.test.ts` — 5 passing, all against a stubbed `fetch` (pinning real
  usernames would fail the day someone gains a follower):

  - a user account's real follower count replaces the proxy, and `totalLikes` survives in `metadata`;
  - the organizations fallback supplies an avatar and never a follower count, and users are tried first;
  - **both endpoints failing produces output byte-identical to no enrichment** — the degradation contract, and
    the half that is invisible while the endpoint is up;
  - at most `HF_ENRICH_LIMIT` authors are enriched, asserted from the outside (the sixth author has no avatar
    even though the stub would have supplied one);
  - the positional zip never gives an author another author's avatar — a defect that would produce a perfectly
    plausible-looking page.
