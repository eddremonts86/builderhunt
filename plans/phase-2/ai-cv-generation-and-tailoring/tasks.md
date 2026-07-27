# Tareas — generación y adaptación de CV

> **Status**: `pending`
> **Depends on**: [`job-opportunities-workspace`](../job-opportunities-workspace/spec.md), [`ai-expansion`](../../phase-1/ai-expansion/spec.md), [`calendar-scheduling-interview-intelligence`](../../phase-1/calendar-scheduling-interview-intelligence/spec.md)
> **Blocks**: [`delegated-job-applications`](../delegated-job-applications/spec.md)
> **Reality check**: El foundation de documentos debe reutilizarse; si su Phase 5 no está
> implementada, upload/import queda bloqueado pero el perfil manual puede avanzar.

- [ ] **Aprobar truth y privacy contracts**
  - Files: `docs/architecture/career-data-classification.md` (new), `docs/architecture/resume-truth-contract.md` (new), `docs/operations/resume-ai-evaluation.md` (new), `docs/architecture/data-classification.md`
  - Do: definir facts, confirmation, provider fields, retention, ownership y export blockers.
  - Verify: security/privacy/product review con casos numéricos, fechas y credentials.

- [ ] **Definir contratos estructurados**
  - Files: `src/shared/lib/resumes/contracts.ts` (new), `src/shared/lib/resumes/contracts.test.ts` (new)
  - Do: profile/fact/resume DTOs, enums, schemas, state machines y fact-reference validation.
  - Verify: unit tests incluyendo unsupported claim, stale, locale y unknown fields.

- [ ] **Crear tablas y RLS**
  - Files: `src/shared/lib/db/schema.ts`, `drizzle/` (new generated migration), `drizzle/meta/_journal.json`, `drizzle/migration-hashes.json`
  - Do: profile, facts, documents, versions, runs, batches/items y consent evidence con
    owner+tenant constraints.
  - Verify: migrations, restore, direct SQL RLS, org-admin denial y user A/B.

- [ ] **Añadir permisos**
  - Files: `src/shared/lib/authorization/permissions.ts`, `src/shared/lib/authorization/permissions.test.ts`, `docs/architecture/authorization-matrix.md`
  - Do: `career:*` y `resume:*` ownership-only; no elevated org role shortcut.
  - Verify: permission table tests y security review.

- [ ] **Implementar repositorios**
  - Files: `src/shared/lib/repositories/career-profiles.ts` (new), `src/shared/lib/repositories/resumes.ts` (new), `src/shared/lib/repositories/resumes.test.ts` (new)
  - Do: CRUD, fact transitions, versions, dependencies, stale propagation y batches.
  - Verify: transaction, concurrency, deletion, immutability y isolation tests.

- [ ] **Crear perfil/facts API**
  - Files: `src/routes/api/career/profile.ts` (new), `src/routes/api/career/facts/index.ts` (new), `src/routes/api/career/facts/$factId.ts` (new)
  - Do: strict DTOs, propose/confirm/reject/supersede y optimistic versioning.
  - Verify: HTTP 401/403/409/422/200 y authority-field rejection.

- [ ] **Crear perfil profesional manual**
  - Files: `src/routes/_dashboard/career/profile.tsx` (new), `src/modules/resumes/CareerProfileEditor.tsx` (new), `src/modules/resumes/CareerFactsInbox.tsx` (new), `src/modules/dashboard/ui/shell/nav-config.ts`
  - Do: wizard/editor, completeness, evidence/source y confirmation.
  - Verify: a11y/component tests y E2E manual with AI disabled.

- [ ] **Integrar storage/extraction**
  - Files: `src/routes/api/resumes/uploads.ts` (new), `src/routes/api/resumes/uploads/$documentId/complete.ts` (new), `src/lib/storage/`, `src/lib/scheduling/`
  - Do: reuse signed upload, checksum, quarantine, ClamAV y PDF/DOCX/TXT extraction; no parallel adapter.
  - Verify: clean/infected/oversize/spoofed MIME/delete/expired URL fixtures.

- [ ] **Registrar tasks IA**
  - Files: `src/shared/lib/ai/tasks.ts`, `src/shared/lib/resumes/ai-contracts.ts` (new), `src/shared/lib/resumes/ai-contracts.test.ts` (new)
  - Do: registrar `career-facts-extract`, `resume-base-compose`, `resume-job-fit-analyze`,
    `resume-tailor`, `resume-quality-review`; schemas, TTL, allowances y untrusted inputs.
  - Verify: registry tests, invalid output repair, kill switch y prompt injection corpus.

- [ ] **Orquestar extracción de facts**
  - Files: `src/lib/resumes/extract-career-facts.ts` (new), `src/routes/api/resumes/$documentId/extract.ts` (new)
  - Do: evidence spans, conflict detection, proposed-only y billing settlement.
  - Verify: date/numeric fidelity, no silent confirm, provider fail y retry idempotente.

- [ ] **Crear CV base y editor**
  - Files: `src/routes/api/resumes/index.ts` (new), `src/routes/api/resumes/$resumeId.ts` (new), `src/routes/_dashboard/career/resumes/index.tsx` (new), `src/routes/_dashboard/career/resumes/$resumeId.tsx` (new), `src/modules/resumes/ResumeEditor.tsx` (new)
  - Do: compose, edit structured sections, locks, version/diff/restore y quality issues.
  - Verify: every bullet factIds, stale propagation y E2E create/edit/restore.

- [ ] **Implementar renderers**
  - Files: `src/lib/resumes/render-html.ts` (new), `src/lib/resumes/render-pdf.ts` (new), `src/lib/resumes/render-docx.ts` (new), `src/lib/resumes/render-text.ts` (new), `src/lib/resumes/renderers.test.ts` (new)
  - Do: deterministic ATS template, sanitized links, font/license y contact post-processing.
  - Verify: PDF text extraction, DOCX reopen, TXT snapshot, visual snapshots y injection.

- [ ] **Implementar tailoring individual**
  - Files: `src/lib/resumes/analyze-job-fit.ts` (new), `src/lib/resumes/tailor-resume.ts` (new), `src/routes/api/resumes/$resumeId/tailor.ts` (new), `src/modules/resumes/TailorResumePage.tsx` (new)
  - Do: pin job version, fit/gaps, diff, provenance, cost preflight y approval.
  - Verify: unsupported requirement stays gap; no fabricated keywords; job mutation preserves output.

- [ ] **Crear batch worker**
  - Files: `src/lib/resumes/batch-worker.ts` (new), `src/lib/resumes/batch-worker.test.ts` (new), `src/routes/api/resume-batches/index.ts` (new), `src/routes/api/admin/resumes/run-batch-worker.ts` (new)
  - Do: 15+ jobs, dedupe, leases, concurrency, cancel/retry/partial y immutable inputs.
  - Verify: crash/restart, duplicate trigger, cancellation y mixed 15-item batch.

- [ ] **Crear batch review UX**
  - Files: `src/routes/_dashboard/career/resume-batches/$batchId.tsx` (new), `src/modules/resumes/ResumeBatchPage.tsx` (new), `src/routes/api/resume-batches/$batchId.ts` (new)
  - Do: preflight, progress, compare, approve/reject/regenerate y ZIP approved.
  - Verify: E2E refresh/cancel/retry/export and mobile.

- [ ] **Integrar billing**
  - Files: `src/shared/lib/resumes/billing.ts` (new), `src/shared/lib/billing/catalog.ts`, `src/shared/lib/billing/feature-authorization.ts`
  - Do: entitlements, rate card por task, reservation/extension/settlement/release y cost DTO.
  - Verify: insufficient credit, estimate bound, partial, retry no-double-charge y reconciliation.

- [ ] **Completar privacy lifecycle**
  - Files: `src/shared/lib/repositories/account-privacy.ts`, `src/shared/lib/repositories/career-processing-consents.ts` (new), `src/routes/_landing/legal/privacy.tsx`, `docs/operations/external-services-register.md`, `docs/operations/resume-data-runbook.md` (new)
  - Do: versioned processing notice/consent, subject export/delete, storage/cache purge, retention y
    provider incident response.
  - Verify: delete end-to-end, backup/restore controls y logs/content scan.

- [ ] **Ejecutar eval y release gate**
  - Files: `tests/e2e/resume-generation.spec.ts` (new), `tests/evals/resume-truth.eval.ts` (new), `.env.example`
  - Do: corpus, unsupported claim zero gate, formats, batch, privacy, billing y degradation.
  - Verify: eval gate + `pnpm lint && pnpm type-check && pnpm test && pnpm build && pnpm test:migration-integrity && pnpm test:rls:local && pnpm exec playwright test tests/e2e/resume-generation.spec.ts`.
