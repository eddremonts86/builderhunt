# Plan de entrega — workspace interno de ofertas de trabajo

> **Status**: `pending`
> **Depends on**: [`security-and-multitenancy`](../../phase-1/security-and-multitenancy/spec.md), [`ai-expansion`](../../phase-1/ai-expansion/spec.md), [`stealth-scraping`](../../phase-1/stealth-scraping/spec.md), [`stripe-billing-platform`](../../phase-1/stripe-billing-platform/spec.md)
> **Blocks**: [`ai-cv-generation-and-tailoring`](../ai-cv-generation-and-tailoring/spec.md), [`delegated-job-applications`](../delegated-job-applications/spec.md)
> **Reality check**: Crea un dominio nuevo (`src/shared/lib/jobs/`, `src/lib/jobs/`, `src/modules/jobs/`, cuatro tablas) y reutiliza sin duplicar: `safeFetch` (`src/lib/enrichment/network.ts`), `isPathAllowedByRobots` (`src/lib/enrichment/robots.ts`), `HARD_BLOCKED_CONNECTOR_IDS` (`src/lib/enrichment/policies.ts`), `validateExternalHttpUrl` (`src/shared/lib/security/url-policy.ts`), el registro IA (`src/shared/lib/ai/tasks.ts`), la reserva/settlement de créditos (`src/shared/lib/billing/feature-authorization.ts`, `src/shared/lib/billing/rate-cards.ts`), el patrón de lease de `enrichment_jobs` y el worker HTTP de `src/routes/api/admin/alerts/run-worker.ts`. No toca `candidate_*`, `organization_builders`, `pipeline_*` ni `job_runs` (salvo escribir una fila por ejecución vía `withJobRun`).

Cada fase deja la aplicación desplegable. El orden es: decisiones → puro → schema → autorización →
repos → API → UI manual → IA → URL → billing → lotes → dedupe/versión → hardening.

## Fase 0 — decisiones y pruebas de riesgo

Nada de código de producto. Salidas: un ADR de propiedad individual dentro del tenant, el registro
de fuentes de oferta con permiso y base legal por fuente, un corpus de 50 ofertas saneadas en varios
idiomas, y una rate card provisional medida contra ese corpus.

**Criterio de salida**: la revisión de seguridad firma que un admin de organización no ve datos de
carrera de otro miembro, y existe al menos una fuente `enabled` con `permissionReference` real. Si
no hay ninguna, la Fase 6 (URL) se pospone y el plan entrega igualmente manual + paste.

## Fase 1 — contratos puros

`src/shared/lib/jobs/contracts.ts` (new) — enums, `jobExtractionSchema`, `evidenceSpanSchema`, DTOs de
request, máquinas de estado, límites) y `src/shared/lib/jobs/normalize.ts` (new) — canonicalización de URL,
`normalizeCompanyName`, `normalizeJobTitle`, `computeContentFingerprint`), cada uno con su test en
`tests/unit/shared/lib/jobs/`. Cero I/O, cero imports de `db` o `env`.

**Criterio de salida**: `pnpm test:unit` verde y `pnpm type-check` limpio. Sin cambio visible.

## Fase 2 — schema, RLS y grants

Las cuatro tablas en `src/shared/lib/db/schema.ts` con sus checks, índices y FKs compuestas; la
migración DDL generada; la migración de RLS + grants escrita a mano; y el registro en
`docs/architecture/data-classification.md` y `docs/architecture/authorization-matrix.md`.

La FK circular `job_opportunities.current_version_id` → `job_opportunity_versions` se crea
`DEFERRABLE INITIALLY DEFERRED` a mano: drizzle-kit no la emite y sin el `DEFERRABLE` insertar
oferta y versión en la misma transacción falla.

**Criterio de salida**: `pnpm test:migration-integrity`, `pnpm exec drizzle-kit check`,
`pnpm test:rls:local` y `pnpm db:audit-schema` en verde. Cuatro tablas vacías, cero cambio de
comportamiento.

## Fase 3 — principal de carrera, permisos y repositorios

`requireCareerPrincipal`, las cinco `PermissionAction` (`job:read|create|update|delete|import`),
y los repositorios tenant-scoped (`job-opportunities.ts`, `job-import.ts`). Todas las funciones
reciben `TenantTransaction` primero y ninguna importa el `db` global.

**Criterio de salida**: `pnpm security:boundaries` verde (ninguna comparación de rol inline),
tests unitarios del principal con las tres situaciones (sin sesión, con organización de empresa
activa, sin organización personal).

## Fase 4 — CRUD manual (API + UI): el vertical sin IA

`GET|POST /api/jobs`, `GET|PATCH|DELETE /api/jobs/$jobId`, `POST /api/jobs/$jobId/archive`,
`GET /api/jobs/$jobId/versions`, más `/jobs`, `JobsPage` y `JobEditor`, y la entrada de navegación.
`checkJobWorkspace()` entra en `scripts/db/verify-api-isolation-local.mjs` **antes** de cerrar la
fase, incluido el test negativo del admin (404, no 403).

**Criterio de salida**: una persona crea, edita, archiva y borra una oferta sin que exista ninguna
IA ni ningún fetch. `pnpm test:api-isolation:local` verde con los nuevos checks.

## Fase 5 — extracción de texto pegado

Registro de `job-description-extract`, `src/shared/lib/jobs/extraction.ts` (new) — cache tenant-scoped,
budget, reparación única, fallback), la rate card `job_description_extract`, el envoltorio de
billing y `POST /api/jobs/import/preview` en modo `pasted_text` con su diálogo.

**Criterio de salida**: pegar una oferta produce un preview editable; con `AI_DISABLED=true` produce
una versión `manual_required` sin abrir reserva; con créditos insuficientes devuelve `402` sin
llamar al proveedor.

## Fase 6 — importación de una URL

`src/lib/jobs/source-policies.ts` (new), `src/lib/jobs/import-url.ts` (new) y el modo `url` de
`/api/jobs/import/preview`. Las catorce defensas de `spec.md` con sus fixtures.

**Criterio de salida**: los fixtures de SSRF, redirección, tamaño, tipo, robots `disallowed` y
robots `unavailable` fallan cerrado y **ninguno** llega a invocar la IA ni a abrir una reserva.

## Fase 7 — lotes

`job_import_batches`/`job_import_items` pasan a usarse: creación con preflight de coste, parser CSV,
`src/lib/jobs/import-worker.ts` (new) — leases, concurrencia por host, cancelación, backoff, cierre y
reconciliación), el endpoint `POST /api/admin/jobs/run-import-worker`, la UI de progreso y el CSV de
errores.

**Criterio de salida**: un lote de 15 URLs con mezcla de éxito, duplicado y error converge a
`partial` con los 11 éxitos intactos; matar el proceso a mitad y volver a disparar el cron termina
el lote sin duplicar cobros; cancelar deja los `queued` en `cancelled` con coste cero.

## Fase 8 — dedupe, versionado y refresh

`src/shared/lib/jobs/dedupe.ts` (new), `POST /api/jobs/dedupe-preview`, `POST /api/jobs/$jobId/refresh`
con validadores condicionales, `POST /api/jobs/$jobId/merge` y `JobVersionDiff`.

**Criterio de salida**: un refresh sobre una oferta cuya versión 2 está pinneada crea la versión 3 y
la 2 sigue byte a byte igual; un `304` no crea versión ni gasta IA; el corpus de falsos positivos no
produce ninguna fusión automática.

## Fase 9 — privacidad, retención y release gate

Export/borrado de cuenta, retención de items fallidos, variables de entorno y flags, runbook,
métricas redactadas, E2E y la pasada completa de gates.

**Criterio de salida**: la lista de `security-policy.md` §Migration and release gate, punto por
punto.

## Riesgos

| # | Riesgo | Probabilidad | Radio de impacto | Mitigación | Decisión tomada |
| --- | --- | --- | --- | --- | --- |
| 1 | El predicado RLS se escribe solo con `organization_id` y un admin de la organización personal (no existe hoy, pero un invitado futuro sí) lee la búsqueda de empleo de otro | Media | Catastrófico (fuga del dato más sensible del producto) | Predicado `tenant AND owner` en las cuatro tablas; test negativo obligatorio que exige **404**, no 403, en `checkJobWorkspace()` | El predicado de tenant solo se declara insuficiente por escrito en `spec.md` §RLS y el test que lo prueba es condición de cierre de la Fase 4 |
| 2 | `safeFetch` exige `allowedHosts`, así que "importar cualquier URL" es literalmente imposible con la infraestructura actual | Alta (es un hecho del código, no un riesgo) | Alto (el producto prometería algo que no puede entregar) | Registro `JOB_SOURCE_POLICIES` deny-by-default; la UI dice qué fuentes están soportadas y ofrece "pegar el texto" como salida universal | Se acepta el alcance reducido. Importar de un host sin política devuelve `source_not_allowed`, no un error genérico, y el paste cubre el resto |
| 3 | Grants olvidados: la ruta funciona como owner de la BD y da `42501` como `builderhunt_app`/`builderhunt_worker` | Alta (`app-reality.md` constraint 7 documenta cinco casos reales) | Alto | Migración de grants dedicada; `checkJobWorkspace()` ejecuta lecturas y escrituras con los roles reales, incluido el worker vía `DATABASE_WORKER_URL` | El worker se prueba con el rol real y se exige `succeeded_count >= 1` en el fixture; un 0 es fallo, no pase |
| 4 | Reserva de créditos huérfana tras un crash entre reservar y liquidar | Media | Medio (crédito bloqueado del usuario) | `idempotencyKey` determinista por item; el reintento replica la reserva en vez de abrir otra; reconciliación al cerrar el lote | Una reserva **por item**, no por lote — ver riesgo 5 |
| 5 | Reservar el lote entero bloquearía 150 unidades a quien importa 3 URLs, porque `getRateCard` fija `maxUnits` y el llamante no puede pasar unidades | Alta (es el contrato de `feature-authorization.ts`) | Medio | Reserva por item en el momento de reclamarlo + preflight de saldo contra `3 × totalItems` al crear el lote | Descartada la reserva única por lote. El preflight da la garantía de coste máximo que el usuario necesita sin bloquear saldo |
| 6 | Prompt injection en la descripción descargada cambia el esquema o exfiltra datos | Media | Alto | `wrapUntrusted` + `system` que declara el bloque como dato inerte + validación zod estricta de la salida + una sola reparación + fallback determinista | Se añaden fixtures de inyección al corpus de Fase 0 y son parte del gate de la Fase 5 |
| 7 | El cache de IA se escribe con `cacheKeyFor`, que es global, y una extracción se comparte entre organizaciones | Media (es el helper "por defecto" del repo) | Alto | `tenantAiCacheKey({organizationId, artifact, input})` explícito; un test unitario afirma que dos organizaciones con el mismo texto generan claves distintas | Prohibido `cacheKeyFor` en este dominio, escrito en `spec.md` §IA y comprobado en el test |
| 8 | Un refresh muta la versión que un CV ya citó y el CV deja de ser auditable | Baja tras la decisión, Alta sin ella | Alto | Sin `GRANT UPDATE` y sin política `FOR UPDATE` en `job_opportunity_versions`; el refresh inserta versión nueva | La inmutabilidad se apoya en el motor, no en la disciplina del llamante. Un `UPDATE` da `42501` |
| 9 | Un plan downstream pone una FK `restrict` contra la versión y la oferta se vuelve indeleteable (el bug que `drizzle/0026_deleted_user_sentinel.sql` existe para arreglar) | Media | Alto (borrado de cuenta bloqueado) | Contrato publicado: FK compuesta `ON DELETE SET NULL` + copia desnormalizada de título/empresa | Escrito en `spec.md` §Contrato publicado como obligación, no sugerencia; el gate de borrado de cuenta lo prueba |
| 10 | Concurrencia por host mal implementada → se martillea un portal ajeno y nos bloquean | Media | Medio (reputación + fuente perdida) | Ventana `count(running) < perHostConcurrency` dentro del `claim`, default 1, más `maxRequestsPerMinute` por política | Nunca se elude un 429: se respeta `Retry-After` y se reintenta con backoff, con techo de 3 intentos |
| 11 | El worker cross-organización filtra datos entre tenants porque sus políticas son `USING (true)` | Media | Catastrófico | Reclamo cross-org, procesamiento **por organización en su propia transacción** con `withWorkerOrganization`; `checkJobWorkspace()` afirma que un item de la organización A nunca escribe en una oferta de B | La relajación se declara por escrito en `spec.md` §RLS con su justificación (el barrido de leases no puede conocer el tenant a priori) |
| 12 | Migración a mano sin snapshot ni entrada de journal → `pnpm test:migration-integrity` en rojo | Media (ya pasó con `0045`) | Bajo | Toda migración a mano se acuña con `pnpm exec drizzle-kit generate --custom`; el snapshot y el journal aparecen en la línea `Files:` de cada tarea | Ningún número de migración se escribe en el plan: se lee `drizzle/meta/_journal.json` en el momento de implementar |
| 13 | Colisión de merge con los otros dos planes de carrera en `schema.ts`, `tasks.ts`, `rate-cards.ts`, `permissions.ts` y `billing-shared.ts` | Alta | Bajo | Todos los identificadores llevan prefijo `job`/`jobOpportunity`/`jobImport`; la única task IA es `job-description-extract`; la única rate card es `job_description_extract` | Registrado en el informe al orquestador; este plan va primero en la cadena, así que define el estilo |
| 14 | Alcance: alguien añade scraping general, papelera o compartir en equipo durante la Fase 7 | Media | Alto | Los tres están en §No objetivos con su razón técnica | Compartir requiere consentimiento y un modelo de visibilidad que este dominio deliberadamente no tiene |
| 15 | El corpus de Fase 0 no se mide y la rate card queda inventada | Media | Medio (se cobra de más o se agota el crédito) | La Fase 0 no cierra sin las mediciones; la rate card sube de `version` cuando cambian los números | `maxUnits: 3` es provisional y así está marcado en el comentario del código |

## Rollback

Sin down-migrations: `security-policy.md` regla 9 exige migraciones inmutables y hacia delante.

- **Fase 2** es puramente aditiva: cuatro tablas nuevas, cero columnas alteradas en tablas
  existentes. El rollback es una migración hacia delante que las borra en orden seguro de FK
  (`job_import_items`, `job_import_batches`, luego `job_opportunity_versions` tras soltar la FK
  diferida de `job_opportunities.current_version_id`, y por último `job_opportunities`).
- **Fases 3–4** se ocultan quitando la entrada de `nav-config.ts` y la ruta `/jobs`. La API queda
  viva pero inalcanzable desde la UI; ninguna superficie existente cambia, así que nada se rompe.
- **Fase 5** se desactiva con `AI_DISABLED_TASKS=job-description-extract`: el CRUD manual sigue
  funcionando y las importaciones producen versiones `manual_required`. No hace falta desplegar.
- **Fase 6** se desactiva con `JOB_IMPORT_URL_ENABLED=false`: `/api/jobs/import/preview` en modo
  `url` devuelve `503 feature_disabled` y la UI oculta la pestaña. El paste no se ve afectado.
- **Fase 7** se desactiva quitando la entrada de cron. El endpoint es idempotente y sin cron es un
  no-op; los items quedan `queued` y se reconcilian solos cuando el cron vuelve, o se cancelan en
  masa desde la UI. Ningún crédito queda reservado porque la reserva ocurre al reclamar, no al
  crear.
- **Fase 8** se revierte quitando los botones de merge y refresh; los datos ya escritos son válidos
  (versiones inmutables, nada que deshacer).
- **Downstream**: mientras el flag `JOB_WORKSPACE_ENABLED` esté en `false`, los planes de CV y
  candidaturas tratan el dominio como ausente y no muestran sus entradas. Es la misma degradación
  que ya usan las acciones deshabilitadas de la Fase 4.
