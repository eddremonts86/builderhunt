# Tareas — candidaturas delegadas

> **Status**: `pending`
> **Depends on**: [`job-opportunities-workspace`](../job-opportunities-workspace/spec.md), [`ai-cv-generation-and-tailoring`](../ai-cv-generation-and-tailoring/spec.md), [`ai-expansion`](../../phase-1/ai-expansion/spec.md)
> **Blocks**: nothing
> **Reality check**: Se crea un tracker personal nuevo; no modificar `pipeline_*`,
> `candidate_submissions` ni integrations ATS para almacenar candidaturas del job seeker.

- [ ] **Aprobar política de autonomía y fuentes**
  - Files: `docs/architecture/application-agent-policy.md` (new), `docs/operations/application-source-register.md` (new), `docs/architecture/application-agent-threat-model.md` (new)
  - Do: mandate, human confirmation, prohibited actions/questions, caps, portal terms y incidents.
  - Verify: product/security/privacy/legal review; policy dice explícitamente “no server submit”.

- [ ] **Definir contratos y state machines**
  - Files: `src/shared/lib/applications/contracts.ts` (new), `src/shared/lib/applications/contracts.test.ts` (new)
  - Do: mandates/runs/candidates/applications/kits/answers/events DTOs y transitions.
  - Verify: exhaustive transition tests, revoke/pause, duplicate y sensitive categories.

- [ ] **Crear tablas y RLS**
  - Files: `src/shared/lib/db/schema.ts`, `drizzle/` (new generated migration), `drizzle/meta/_journal.json`, `drizzle/migration-hashes.json`
  - Do: siete recursos del spec con owner+tenant keys, immutable events, checks/indexes/grants/RLS.
  - Verify: migration/restore/direct SQL RLS, user A/B y org-admin denial.

- [ ] **Añadir permisos**
  - Files: `src/shared/lib/authorization/permissions.ts`, `src/shared/lib/authorization/permissions.test.ts`, `docs/architecture/authorization-matrix.md`
  - Do: `application:*`, `mandate:*`, `answer-fact:*` owner-only.
  - Verify: role/ownership matrix, stale membership y security boundaries.

- [ ] **Implementar repositorios**
  - Files: `src/shared/lib/repositories/job-applications.ts` (new), `src/shared/lib/repositories/application-runs.ts` (new), `src/shared/lib/repositories/job-applications.test.ts` (new)
  - Do: CRUD/transitions, immutable events, uniqueness, mandates, leases y batches.
  - Verify: isolation, concurrency, idempotency y invalid transitions.

- [ ] **Crear tracker manual**
  - Files: `src/routes/api/applications/index.ts` (new), `src/routes/api/applications/$applicationId.ts` (new), `src/routes/_dashboard/career/applications/index.tsx` (new), `src/modules/applications/ApplicationsBoard.tsx` (new), `src/modules/dashboard/ui/shell/nav-config.ts`
  - Do: list/kanban/detail/status, job/resume link y audit timeline.
  - Verify: E2E create→move→archive, a11y y no employer pipeline writes.

- [ ] **Crear answer bank seguro**
  - Files: `src/routes/api/career/application-answers.ts` (new), `src/shared/lib/repositories/application-answers.ts` (new), `src/modules/applications/ApplicationAnswerSettings.tsx` (new)
  - Do: confirmed answers, sensitivity, expiry, encryption/minimization y never-auto categories.
  - Verify: sensitive questions stay unresolved; export/delete and owner isolation.

- [ ] **Crear mandate wizard**
  - Files: `src/routes/api/application-mandates/index.ts` (new), `src/routes/api/application-mandates/$mandateId.ts` (new), `src/routes/_dashboard/career/applications/mandate.tsx` (new), `src/modules/applications/MandateWizard.tsx` (new)
  - Do: rules/caps/sources/actions/version/expiry/pause/revoke con preview.
  - Verify: deny-default, max bounds, revoke immediate y version pin.

- [ ] **Implementar hard filters**
  - Files: `src/shared/lib/applications/hard-filters.ts` (new), `src/shared/lib/applications/hard-filters.test.ts` (new)
  - Do: location/salary/sponsorship/employment/exclusions/stale/duplicate con unknown semantics.
  - Verify: table-driven corpus; protected traits absent de inputs.

- [ ] **Crear gateway de discovery externo**
  - Files: `src/lib/jobs/connectors/contracts.ts` (new), `src/lib/jobs/connectors/registry.ts` (new), `src/lib/jobs/connectors/fake.ts` (new), `src/lib/jobs/connectors/registry.test.ts` (new)
  - Do: interfaz paginada/cursor para APIs oficiales y feeds autorizados; cada resultado entra por
    normalización/dedupe del job workspace. Deny-by-default para fuentes no registradas.
  - Verify: fake connector cubre pagination, retry, rate limit, cursor resume, revoke y source denial.

- [ ] **Registrar tasks IA**
  - Files: `src/shared/lib/ai/tasks.ts`, `src/shared/lib/applications/ai-contracts.ts` (new), `src/shared/lib/applications/ai-contracts.test.ts` (new)
  - Do: `candidate-job-fit` y `application-cover-letter`, evidence links, TTL, allowances y schemas.
  - Verify: registry, injection, invalid output, AI-disabled y no unsupported claims.

- [ ] **Implementar scoring explicable**
  - Files: `src/lib/applications/fit-service.ts` (new), `src/lib/applications/fit-service.test.ts` (new)
  - Do: facts/job versions, requirement mapping, deterministic score, gaps y cached fingerprints.
  - Verify: eval ranking, numeric reproducibility, missing/unknown y provider degradation.

- [ ] **Crear run worker**
  - Files: `src/lib/applications/run-worker.ts` (new), `src/lib/applications/run-worker.test.ts` (new), `src/routes/api/admin/applications/run-worker.ts` (new)
  - Do: consultar saved jobs y connectors permitidos por mandate; normalizar/importar, filtrar,
    puntuar, aplicar caps, leases/cancel y tenant-isolated batches.
  - Verify: duplicate triggers, crash/restart, revoked mandate, daily cap y multi-tenant failure.

- [ ] **Crear run/inbox UX**
  - Files: `src/routes/api/application-runs/index.ts` (new), `src/routes/api/application-runs/$runId.ts` (new), `src/routes/_dashboard/career/applications/runs/$runId.tsx` (new), `src/modules/applications/ApplicationRunPage.tsx` (new)
  - Do: progress, ranking, evidence/gaps, include/exclude y cost.
  - Verify: E2E manual/scheduled run, refresh, cancel y screen reader.

- [ ] **Orquestar application kits**
  - Files: `src/lib/applications/build-kit.ts` (new), `src/lib/applications/build-kit.test.ts` (new), `src/routes/api/applications/$applicationId/kit.ts` (new)
  - Do: pin job/profile/resume, tailor, optional letter, answer mapping y unresolved checklist.
  - Verify: no unsupported facts, sensitive empty, stale inputs y partial provider failure.

- [ ] **Crear review y approval UX**
  - Files: `src/routes/_dashboard/career/applications/$applicationId.tsx` (new), `src/modules/applications/ApplicationKitReview.tsx` (new)
  - Do: score, CV diff, letter, answers, unresolveds, approve/reject/regenerate.
  - Verify: no approval con blockers; edits/version audit y mobile/a11y.

- [ ] **Implementar portal handoff**
  - Files: `src/shared/lib/applications/source-links.ts` (new), `src/routes/api/applications/$applicationId/mark-submitted.ts` (new), `src/modules/applications/PortalHandoff.tsx` (new)
  - Do: safe URL, checklist, user submit confirmation y separate manual/verified states.
  - Verify: open redirect blocked, CSRF, duplicate submit state y server network spy proves no form POST.

- [ ] **Diseñar prefill opcional**
  - Files: `plans/phase-2/browser-extension-overlay/spec.md`, `plans/phase-2/browser-extension-overlay/plan.md`, `plans/phase-2/browser-extension-overlay/tasks.md`
  - Do: extender aquel plan únicamente tras aprobación para authenticated, user-triggered prefill;
    nunca final submit, CAPTCHA bypass o sensitive autofill.
  - Verify: revisión del diseño antes de cualquier código del extension.

- [ ] **Integrar scheduling, notifications y billing**
  - Files: `src/shared/lib/applications/billing.ts` (new), `src/shared/lib/billing/catalog.ts`, `src/shared/lib/billing/feature-authorization.ts`, `src/shared/lib/operational-schedule-registry.ts`
  - Do: daily run, caps, notification summary, reservation/settlement/release y kill switches.
  - Verify: cost ceiling, cancel/revoke, no-double-charge, missed run y reconciliation.

- [ ] **Completar privacy/audit/retention**
  - Files: `src/shared/lib/repositories/account-privacy.ts`, `docs/operations/application-agent-runbook.md` (new), `.env.example`
  - Do: export/delete, retention, source/AI audit, incident/complaint path y redacted metrics.
  - Verify: subject lifecycle, log scan, provider failure y rollback drill.

- [ ] **Ejecutar eval y release gate**
  - Files: `tests/e2e/delegated-applications.spec.ts` (new), `tests/evals/candidate-job-fit.eval.ts` (new), `tests/fixtures/fake-job-portal/` (new)
  - Do: fake portal, mandate, discovery, scoring, kit, approval, handoff y manual submit.
  - Verify: eval + `pnpm lint && pnpm type-check && pnpm test && pnpm build && pnpm test:migration-integrity && pnpm test:rls:local && pnpm test:api-isolation:local && pnpm exec playwright test tests/e2e/delegated-applications.spec.ts`.
