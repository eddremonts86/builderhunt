# Tareas — workspace interno de ofertas

> **Status**: `pending`
> **Depends on**: [`security-and-multitenancy`](../../phase-1/security-and-multitenancy/spec.md), [`ai-expansion`](../../phase-1/ai-expansion/spec.md)
> **Blocks**: [`ai-cv-generation-and-tailoring`](../ai-cv-generation-and-tailoring/spec.md), [`delegated-job-applications`](../delegated-job-applications/spec.md)
> **Reality check**: Todos los módulos de dominio, tablas y rutas siguientes son nuevos salvo el
> fetcher, IA, billing y tenancy que se reutilizan.

- [ ] **Aprobar ownership y políticas de fuente**
  - Files: `docs/architecture/job-workspace-ownership.md` (new), `docs/operations/job-source-register.md` (new), `docs/architecture/data-classification.md`, `docs/architecture/authorization-matrix.md`
  - Do: documentar privacidad individual dentro del tenant, fuentes/API/crawl permitidos,
    retención, sharing no-go y permisos.
  - Verify: security review aprueba que admins no ven datos de carrera de otros miembros.

- [ ] **Definir contratos puros**
  - Files: `src/shared/lib/jobs/contracts.ts` (new), `src/shared/lib/jobs/contracts.test.ts` (new)
  - Do: enums, DTOs, normalización, state machines, strict request schemas y límites.
  - Verify: `pnpm test -- src/shared/lib/jobs/contracts.test.ts`.

- [ ] **Crear schema y migración**
  - Files: `src/shared/lib/db/schema.ts`, `drizzle/` (new generated migration), `drizzle/meta/_journal.json`, `drizzle/migration-hashes.json`
  - Do: generar con `pnpm exec drizzle-kit generate --custom` usando el siguiente índice real;
    crear opportunities, versions, batches/items, composite FKs, checks, indexes, grants y RLS.
  - Verify: migration integrity, disposable DB, direct SQL RLS y tenant/user A/B.

- [ ] **Añadir autorización**
  - Files: `src/shared/lib/auth/career-principal.ts` (new), `src/shared/lib/auth/career-principal.test.ts` (new), `src/shared/lib/authorization/permissions.ts`, `src/shared/lib/authorization/permissions.test.ts`
  - Do: resolver siempre la organización personal del subject y añadir acciones job con ownership
    individual; rechazar organization IDs del cliente y no usar active company context.
  - Verify: tabla roles/owners, switch entre dos organizaciones, missing personal org repair y
    `pnpm security:boundaries`.

- [ ] **Implementar repositorio**
  - Files: `src/shared/lib/repositories/job-opportunities.ts` (new), `src/shared/lib/repositories/job-opportunities.test.ts` (new)
  - Do: CRUD, versions, list/filter, dedupe candidates y batches usando `TenantTransaction`.
  - Verify: tests de isolation, optimistic concurrency, pagination y deletion.

- [ ] **Implementar CRUD API**
  - Files: `src/routes/api/jobs/index.ts` (new), `src/routes/api/jobs/$jobId.ts` (new), `src/routes/api/jobs/$jobId/archive.ts` (new), `src/shared/lib/jobs/api.ts` (new)
  - Do: endpoints strictos, ETag/version, allowlisted DTOs y errores accionables.
  - Verify: HTTP 401/403/404/409/422/200 y no existence leak.

- [ ] **Crear workspace manual**
  - Files: `src/routes/_dashboard/jobs/index.tsx` (new), `src/routes/_dashboard/jobs/$jobId.tsx` (new), `src/modules/jobs/JobsPage.tsx` (new), `src/modules/jobs/JobEditor.tsx` (new), `src/modules/dashboard/ui/shell/nav-config.ts`
  - Do: lista, filtros, empty states, create/edit/archive/delete y provenance.
  - Verify: component tests, keyboard/a11y y E2E create→refresh→archive.

- [ ] **Registrar extracción IA**
  - Files: `src/shared/lib/ai/tasks.ts`, `src/shared/lib/jobs/extraction.ts` (new), `src/shared/lib/jobs/extraction.test.ts` (new)
  - Do: task `job-description-extract`, untrusted wrapping, evidence spans, cache tenant y fallback.
  - Verify: eval corpus, injection cases, invalid JSON repair y AI disabled.

- [ ] **Integrar fetch seguro**
  - Files: `src/lib/jobs/import-url.ts` (new), `src/lib/jobs/import-url.test.ts` (new), `src/lib/enrichment/source-policy.ts`
  - Do: API-first, policy, robots, DNS/redirect SSRF, size/type/time limits y HTML discard.
  - Verify: local/private/metadata/redirect bomb/login/CAPTCHA/denied-host fixtures fail closed.

- [ ] **Crear preview e import individual**
  - Files: `src/routes/api/jobs/import.ts` (new), `src/modules/jobs/JobImportDialog.tsx` (new)
  - Do: manual/paste/URL preview, coste máximo, diff editable y confirmación.
  - Verify: no persistir ni cobrar antes de confirmación; idempotent retry.

- [ ] **Crear worker de lotes**
  - Files: `src/routes/api/admin/jobs/run-import-worker.ts` (new), `src/lib/jobs/import-worker.ts` (new), `src/lib/jobs/import-worker.test.ts` (new)
  - Do: leases, per-host concurrency, cancellation, retry/backoff, partial success y reconciliation.
  - Verify: crash/restart, duplicate trigger, cancel y 15-item mixed fixture.

- [ ] **Construir UI de lotes**
  - Files: `src/routes/api/jobs/import/$batchId.ts` (new), `src/routes/api/jobs/import/$batchId/cancel.ts` (new), `src/modules/jobs/JobImportBatchPage.tsx` (new)
  - Do: CSV/URLs preview, progreso por item, errores descargables y retry selected.
  - Verify: E2E 15 URLs, refresh durante ejecución y mobile.

- [ ] **Añadir billing y límites**
  - Files: `src/shared/lib/billing/catalog.ts`, `src/shared/lib/billing/feature-authorization.ts`, `src/shared/lib/jobs/billing.ts` (new)
  - Do: entitlement, reservation máxima, settlement real/release y display de estimación.
  - Verify: insufficient credits, partial, cancel, provider failure y ledger reconciliation.

- [ ] **Implementar dedupe/version/refresh**
  - Files: `src/shared/lib/jobs/dedupe.ts` (new), `src/shared/lib/jobs/dedupe.test.ts` (new), `src/routes/api/jobs/$jobId/refresh.ts` (new), `src/routes/api/jobs/dedupe-preview.ts` (new)
  - Do: exact/probable matches, merge explícito, validators y immutable snapshots.
  - Verify: false-positive corpus, concurrent refresh y downstream version pin.

- [ ] **Completar privacidad y operaciones**
  - Files: `src/shared/lib/repositories/account-privacy.ts`, `docs/operations/job-workspace-runbook.md` (new), `.env.example`
  - Do: export/delete/retention, flags, metrics redacted, alerts y rollback.
  - Verify: account export/delete, retention worker, logs scan y kill-switch smoke.

- [ ] **Ejecutar release gate**
  - Files: `tests/e2e/job-workspace.spec.ts` (new), `scripts/db/verify-api-isolation-local.mjs`
  - Do: suite manual/URL/batch/dedupe/version/privacy/billing/degradation.
  - Verify: `pnpm lint && pnpm type-check && pnpm test && pnpm build && pnpm test:migration-integrity && pnpm test:rls:local && pnpm test:api-isolation:local && pnpm exec playwright test tests/e2e/job-workspace.spec.ts`.
