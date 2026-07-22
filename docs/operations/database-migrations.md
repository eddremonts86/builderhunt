# Database Migration Operations

Migration files are immutable after any shared environment applies them. Use forward recovery; do
not edit history or run schema push in production. The rollout sequence is expand, resumable
backfill, dual write, shadow read, RLS rehearsal, canonical cutover, constraint validation, one full
compatibility release, then contract.

Use `DATABASE_MIGRATION_URL` only in the migration job. A backfill refuses production unless
`--confirm-production` is present; that flag records operator intent but does not replace change
approval. Always begin with `--dry-run`, a fresh encrypted backup, a successful restore rehearsal,
row counts, batch/lock/statement budgets, and a conflict policy.

Local verification uses a disposable database named `builderhunt_security_test_*`:

```sh
TEST_MIGRATION_URL=... pnpm test:migrations:local
RLS_TEST_APP_URL=... RLS_TEST_AUTH_URL=... pnpm test:rls:local
```

Both scripts refuse any other database name. **Caution**: `prepare-rls-fixture.mjs`
runs `alter role ... password ...` against `builderhunt_app`/`builderhunt_auth`/`builderhunt_worker`/
`builderhunt_platform` to set the known test passwords `RLS_TEST_*_URL` expects — but Postgres roles
are cluster-wide, not per-database, so running this against a disposable database on the same
Postgres cluster as your persistent dev database (e.g. local Docker Postgres) overwrites those roles'
real passwords too, breaking the dev app until you `alter role ... password '<original>'` back to the
values in `.env`. CI is unaffected (its Postgres service container is provisioned fresh per run). Backfills use stable cursors, small transactions,
checkpoint counters, retryable forward execution, and non-sensitive conflict checksums. A rerun of a
completed backfill must write nothing.

## pgvector (semantic-search plan)

The `builder_embeddings` table requires the Postgres `vector` extension. Local dev's
`docker-compose.yml` already runs `pgvector/pgvector:pg16` (same Postgres 16 major as before —
the existing data volume is compatible, no export/import needed).

**Before applying this feature's migration in production**: the managed Postgres resource
(Coolify, on Hetzner) must also run a pgvector-enabled image or have the extension installed.
Steps:
1. Take a fresh encrypted backup and verify a restore rehearsal succeeds (standard gate above).
2. Switch the Coolify Postgres resource's image to `pgvector/pgvector:pg16`. The data volume
   persists across the image swap since the Postgres major version is unchanged.
3. Confirm `CREATE EXTENSION IF NOT EXISTS vector;` succeeds, then apply this plan's migration.

If the extension is missing, the app fails soft: `/api/search/semantic` returns
`503 { error: 'semantic_unavailable' }` and the UI falls back to keyword search — this is not an
outage, but semantic search stays disabled until the operator step above is done.

## Self-hosted embeddings (semantic-search plan)

Embeddings are a separate, swappable, OpenAI-compatible vector endpoint (`AI_EMBEDDING_URL`) —
never MiniMax (see `plans/_meta/ai-policy.md` §3: MiniMax M3 doesn't expose the vector contract
this app needs). Both local dev and production run the same self-hosted answer: **Ollama**,
serving `nomic-embed-text` (768-dim) via its built-in OpenAI-compatible `POST /v1/embeddings`
route — no app code depends on which provider is behind `AI_EMBEDDING_URL`.

**Local dev**: `docker-compose.yml`'s `embeddings` service (profile `standalone`). Start it with
the other standalone infra:

```sh
docker compose --profile standalone up -d embeddings
```

First boot downloads the model (~270 MB); the healthcheck has a 120s `start_period` to cover
that. `.env.example` already points `AI_EMBEDDING_URL` at `http://localhost:11434/v1/embeddings`.

**Production (Coolify)**: deploy the same `embeddings` service definition as its own Coolify
resource (a docker-compose resource, not the main app's Dockerfile build) on the same Hetzner
VPS/network as the app container, so the app can reach it at its internal service hostname.
Steps:
1. Create a new Coolify resource from `docker-compose.yml`'s `embeddings` service (or a copy of
   it) — same image (`ollama/ollama:latest`), same entrypoint (serve + pull `nomic-embed-text`),
   with a persistent volume so the model isn't re-downloaded on every redeploy.
2. Set the app's `AI_EMBEDDING_URL` to that resource's internal hostname, e.g.
   `http://embeddings:11434/v1/embeddings` (Coolify resources on the same network resolve by
   service name — confirm the actual hostname Coolify assigns before going live).
3. Leave `AI_EMBEDDING_API_KEY` empty (self-hosted, no auth) and `AI_EMBEDDING_DIM=768`,
   `AI_EMBEDDING_MODEL=nomic-embed-text` — these three must stay in lockstep with whatever the
   embeddings container actually serves, per the single-dimension-source rule above.
4. Same fail-soft guarantee as the missing-pgvector case: if the embeddings resource is down,
   `embedTexts()` throws `AIEmbeddingUnavailableError`, the write-through/worker paths log and
   skip, and `/api/search/semantic` degrades to `mode: 'keyword-fallback'` — never a dead end.



