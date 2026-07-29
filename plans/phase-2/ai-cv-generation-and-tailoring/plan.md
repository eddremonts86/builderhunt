# Plan de entrega — generación y adaptación de CV con IA

> **Status**: `pending`
> **Depends on**: [`job-opportunities-workspace`](../job-opportunities-workspace/spec.md) (sólo las fases 6–7; las fases 1–5 no lo necesitan), [`ai-expansion`](../../phase-1/21-ai-expansion/spec.md), [`security-and-multitenancy`](../../phase-1/01-security-and-multitenancy/spec.md)
> **Blocks**: [`delegated-job-applications`](../delegated-job-applications/spec.md)
> **Reality check**: Extiende `src/shared/lib/db/schema.ts` (8 tablas nuevas), `src/shared/lib/ai/tasks.ts` (5 tasks), `src/shared/lib/billing/rate-cards.ts`, `src/shared/lib/billing-shared.ts`, `src/shared/lib/authorization/permissions.ts`, `src/shared/lib/repositories/account-privacy.ts`, `src/modules/dashboard/ui/shell/nav-config.ts` y `scripts/db/verify-api-isolation-local.mjs`. Clona la forma RLS/grants de `drizzle/0085_candidate_documents_rls_grants.sql`, el patrón de worker de `src/routes/api/admin/alerts/run-worker.ts` y el contrato de storage de `src/lib/storage/types.ts`. **No** reutiliza `candidate_documents` (FK obligatoria a `candidate_submissions`; ver spec.md §Decisión sobre el foundation de documentos) y **no** implementa un segundo contrato de storage.

## Fases (orden de dependencia — la app es entregable después de cada una)

### Fase 0 — contrato de verdad, formato y corpus de evaluación

Documentar la taxonomía de `career_facts`, la política de unsupported claims, qué campos salen al
proveedor y cuáles no, el aviso de consentimiento y la retención. Escribir el módulo puro de
contratos (`src/shared/lib/resumes/contracts.ts` (new)) con los DTOs, enums, máquinas de estado y el
generador de `claimId`, con sus tests. Construir el corpus sanitizado de evaluación (CVs cortos y
largos, dos idiomas, ofertas ambiguas y adversariales, hechos contradictorios, fechas y métricas) y
la rúbrica.

**Salida**: una política de unsupported claims verificable y tipos compartidos; cero cambios de
comportamiento en la app.
**Criterio de cierre**: `pnpm test -- tests/unit/shared/lib/resumes/contracts.test.ts` verde y
revisión de seguridad/privacidad aprobada sobre `docs/architecture/resume-truth-contract.md` (new).

### Fase 1 — schema, RLS y grants

Las 8 tablas con todos sus checks, índices y FKs compuestas. Una migración DDL generada y una
migración RLS+grants escrita a mano, ambas minteadas con `drizzle-kit generate --custom` para que
existan entrada de journal y snapshot. Registro en `docs/architecture/data-classification.md` y
`docs/architecture/authorization-matrix.md`.

**Salida**: ocho tablas vacías con la conjunción tenant AND owner activa. La app no cambia.
**Criterio de cierre**: `pnpm test:migration-integrity`, `pnpm test:rls:local` y
`pnpm test:migrations:local` verdes; una lectura directa como `builderhunt_app` sin
`app.user_id` devuelve **0 filas, no un error**.

### Fase 2 — principal, permisos, repositorios y ciclo de vida de privacidad

`requireCareerPrincipal` (si no lo trajo ya `job-opportunities-workspace`), las seis acciones de
permiso sin `elevated`, los repositorios de perfil/hechos/CV bajo `TenantTransaction`, el helper
`withCareerWorkerSubject`, y el export/borrado de cuenta. Extensión de
`scripts/db/verify-api-isolation-local.mjs` con `checkCareerResumes()`, **incluido el test negativo
de org-admin → 404**.

**Salida**: API interna completa y aislamiento probado, sin superficie HTTP todavía.
**Criterio de cierre**: `pnpm test:api-isolation:local` y `pnpm security:boundaries` verdes; el
borrado duro de una cuenta con perfil, hechos, documentos y CVs completa sin bloquearse en una FK.

### Fase 3 — perfil profesional manual (**entregable sin IA y sin upload**)

Rutas `/api/career/profile` y `/api/career/facts`, área `career` en el nav, editor de perfil y facts
inbox. Todo a mano: la persona teclea, confirma y edita.

**Salida**: una persona construye un perfil profesional confirmado con `AI_DISABLED=true` y sin un
solo byte en object storage. Ésta es la fase que hace irrelevante que el pipeline de documentos siga
sin escribirse.
**Criterio de cierre**: E2E que crea perfil, añade 5 hechos, confirma 4, rechaza 1 y recarga, con
`AI_DISABLED=true`.

### Fase 4 — CV base determinista, validador de verdad y export

`composeResumeDeterministic`, el módulo de templates, `validateResumeTruth` + `assertFactSubset`, el
repositorio y las rutas de `resume_versions`, el editor estructurado, los tres renderers
(HTML/TXT/PDF con Playwright) y `GET …/export`.

**Salida**: **primer PDF descargable con cobertura de hechos del 100 %, cero llamadas a un
proveedor y cero créditos.** El producto ya es útil aquí.
**Criterio de cierre**: E2E que descarga un PDF y un TXT; test que demuestra que un `content` con un
bullet sin `factIds` deja `verification_status = 'failed'` y que el `check` de BD rechaza
`export_state = 'exportable'`; el PDF pasa extracción de texto.

### Fase 5 — IA de composición y revisión

Rate cards, límites de plan, `resume-base-compose` y `resume-quality-review` en el registry, la capa
de orquestación con `reserveCredits`/`checkAndConsumeBudget` + caché tenant-scoped + repair retry +
`assertFactSubset`, y la UI que ofrece "generar con IA" junto al camino determinista.

**Salida**: generación asistida en planes de pago; el camino gratuito intacto.
**Criterio de cierre**: `pnpm security:provider-metering` verde; con `AI_DISABLED=true` la UI ofrece
el compositor determinista y ninguna ruta responde 500; el corpus de inyección no produce ni un
claim sin respaldo.

### Fase 6 — documentos: upload, scan, extracción

Adaptadores contra `src/lib/storage/types.ts` (S3/MinIO, ClamAV, parser PDF/DOCX/TXT con
`pdfjs-dist`/`mammoth`/`file-type`), rutas de upload con consentimiento, worker de scan+extract+
retención, task `career-facts-extract`, evidencia en el facts inbox y detección de conflictos.

**Salida**: importar un CV existente produce hechos **propuestos**, jamás confirmados.
**Criterio de cierre**: fixtures limpio / infectado / sobredimensionado / MIME falsificado / audio
renombrado / PDF cifrado fallan cerrado; el worker corre como el rol real `builderhunt_worker`
contra un documento sembrado y devuelve `factsProposed >= 1`; el sweeper de retención borra objeto y
fila.

**Riesgo de alcance**: si el foundation de documentos sigue sin código, esta fase incluye tres
adaptadores que no estaban en la estimación original. Se entrega igual, pero es la fase más grande
del plan y debe planificarse como tal.

### Fase 7 — tailoring individual

`resume-job-fit-analyze` y `resume-tailor` con sus fallbacks deterministas, `POST …/fit` y
`POST …/tailor`, la pantalla de requisitos/evidencia/gaps/diff con bloqueo de secciones, y el
anclaje a `job_opportunity_version_id`.

**Salida**: una variante explicable por oferta.
**Criterio de cierre**: un requisito que la persona no cumple sigue siendo `missing` en la salida y
no aparece como claim; cambiar la oferta después no altera la variante generada; el diff contra la
base es exacto.

### Fase 8 — lote

Preflight con dedupe y coste máximo, reserva única, worker con leases y concurrencia 3, cancelación,
éxito parcial, liquidación, cola de revisión y ZIP de aprobadas.

**Salida**: 15 ofertas producen 15 variantes independientes sin exceder la reserva.
**Criterio de cierre**: un lote de 15 con 2 fallos deliberados cierra `partial` y `settled`;
matar el worker a mitad y relanzarlo no duplica cargos ni items; cancelar en el item 9 conserva 8
variantes y liquida sólo lo consumido.

### Fase 9 — hardening y release gate

Gates de eval (unsupported claim rate = 0), corpus de inyección, RLS, privacidad, render, carga,
feature flags por capacidad (`manual` / `import` / `generate` / `tailor` / `batch`), dogfood interno
y monitorización de coste por proveedor.

**Criterio de cierre**: `pnpm ci:local` verde más los gates específicos listados en `tasks.md`.

---

## Riesgos

| # | Riesgo | Probabilidad | Radio de impacto | Mitigación | Decisión tomada |
| --- | --- | --- | --- | --- | --- |
| 1 | **La IA afirma algo que la persona nunca hizo** y se envía a un empleador | Alta si no se diseña contra ello | Catastrófico: destruye la confianza en el producto y expone a la persona en una entrevista | Cuatro capas independientes (spec.md §Mecanismo de veracidad): `factIds.min(1)` en zod, `assertFactSubset` en código, FK compuesta en la BD y dos `check` que hacen imposible `export_state='exportable'` con claims sin respaldo | Se rechaza **la salida entera** ante una violación, nunca se conservan los claims buenos. Un claim sin respaldo se excluye del render y sólo se puede borrar o convertir en hecho afirmado por la persona |
| 2 | **RLS con predicado sólo de tenant** deja que un org-admin lea la búsqueda de empleo de un miembro | Alta (es el defecto por defecto al copiar otras tablas) | Alto: fuga de datos laborales sensibles dentro de la empresa del sujeto | Predicado `organization_id AND owner_user_id` en las 8 tablas; test negativo obligatorio org-admin → **404** en `checkCareerResumes()` | El 403 está prohibido: confirmaría la existencia del recurso |
| 3 | **Grants olvidados** → la ruta funciona como owner de la BD y da `42501` como `builderhunt_app` | Alta (modo de fallo documentado del repo) | Alto: funciona en dev, cae en producción | Migración RLS+grants dedicada con la lista por rol tabla a tabla, más `pnpm test:rls:local` y `checkCareerResumes()` antes de cerrar la Fase 2 | Cada tabla del spec lista sus GRANTs explícitos; ninguna se deduce |
| 4 | **El worker lee cero filas en silencio** por usar `withWorkerOrganization`, que no fija `app.user_id` | Alta | Alto: la extracción y el lote "funcionan" y no producen nada, y un verify ingenuo pasa vacío | `withCareerWorkerSubject` fija ambos GUCs; la aceptación de las fases 6 y 8 exige `factsProposed >= 1` / `succeeded_count >= 1` corriendo como el rol real `builderhunt_worker` | Un cero se trata como grant o GUC roto, no como "no había trabajo" |
| 5 | **Un lote multiplica el coste** más allá de lo que la persona esperaba | Media | Alto (monetario y de confianza) | Una sola reserva por lote con `maxUnits` del rate card (el cliente no puede ampliarlo), preflight que muestra el máximo, `check` de BD que impide cerrar un lote sin liquidar | Cancelar a mitad **liquida** lo consumido, no libera: el coste ya se incurrió y fingir lo contrario descuadraría el ledger |
| 6 | **Reserva huérfana** si el worker muere a mitad | Media | Medio | Lease por item, recuperación de leases vencidos en cada corrida, contador `orphanedReservations` en el resultado del worker, y el `check` `status terminal ⇒ settlement_state in ('settled','released')` | Se prueba matando el worker a mitad de un lote de 15 |
| 7 | **El renderer PDF abre una superficie nueva** (ejecución, SSRF, exfiltración desde el texto de un hecho) | Media | Alto | Chromium ya presente (`Dockerfile:41`), `javaScriptEnabled: false`, `page.route('**', abort)`, CSP `default-src 'none'`, fuentes embebidas como `data:`, sandbox conservado, timeout 15 s, browser propio por render | **Cero dependencias nuevas.** DOCX se difiere al plan sucesor `resume-server-rendering` porque exigiría un escritor nuevo y su revisión de supply chain |
| 8 | **La oferta contiene una inyección de prompt** | Alta (es contenido de terceros) | Medio | `wrapUntrusted` + system prompt que declara el bloque como dato + corpus adversarial en la eval | Aunque el modelo obedeciera, el claim resultante necesitaría un `factId` real inexistente y las capas 1–2 lo tumban. La defensa no depende de que el modelo se porte bien |
| 9 | **Un `factId` de otro usuario** en la salida del modelo | Baja | Alto | `assertFactSubset` + FK compuesta a `career_facts(organization_id, id)` + RLS que ya lo hizo invisible | Tres capas independientes; ninguna es suficiente sola |
| 10 | **El foundation de documentos nunca se implementa** y el plan queda a medias | Media (sólo aterrizó el schema) | Medio | Las fases 1–5 y 7–8 no dependen del upload; la Fase 6 se aísla y, si hace falta, implementa los tres adaptadores contra el contrato ya existente | El plan es entregable y útil sin subir un solo archivo. La única pérdida es importar un CV viejo |
| 11 | **Reutilizar `candidate_documents`** por presión de "no duplicar" | Media (el README lo sugiere) | Alto: `submission_id NOT NULL` lo hace imposible, y el cascade borraría CVs al borrar submissions ajenas | Tablas propias `career_documents`/`career_document_extractions` con el mismo diseño; la decisión y su evidencia quedan en spec.md | Se reutiliza el **diseño** y el **contrato de tipos**, no las filas |
| 12 | **Borrar un hecho invalida CVs ya enviados** | Media | Medio | `resume_claim_facts.fact_id` es `RESTRICT`; el camino es `superseded`, que marca `stale` sin destruir evidencia | El borrado duro real sólo ocurre en el borrado de cuenta, que borra versiones antes que hechos |
| 13 | **La caché filtra un CV entre tenants** | Media (la API genérica invita al fallo) | Crítico | Prohibido `getCached`/`setCached` (clave `ai:cache:{taskId}:{hash}` sin organización, `cache.ts:43`); obligatorio `tenantAiCacheKey` con `ownerUserId` en el input canónico | Un test unitario afirma que dos sujetos con input idéntico producen claves distintas |
| 14 | **Cinco tasks comparten un presupuesto** y una consume el de las demás | Media | Medio | `allowances` por task y por tier en el registry, más rate cards independientes por operación; el lote tiene su propia operación y su propio techo | El presupuesto es por task, no por plan; agotar `resume-tailor` no bloquea `resume-quality-review` |
| 15 | **Conflictos de merge** con los otros dos planes de carrera en 8 archivos compartidos | Alta | Bajo | Prefijos `career`/`resume` en todo identificador; superficies compartidas listadas en spec.md | Los conflictos serán textuales, no semánticos |
| 16 | **El plan free queda muerto** con `STRIPE_BILLING_ENABLED=false` y nadie puede autoupgradearse | Alta | Alto: la feature no se usa | El camino determinista completo (perfil, hechos, CV base, editor, validador, PDF, TXT, 3 versiones) es gratis | Lo de pago es la asistencia de IA y el lote, no el producto |

---

## Rollback

Recuperación hacia adelante, nunca down-migrations (`_meta/security-policy.md` regla 9).

- **Fase 1** es puramente aditiva: ocho tablas vacías. Se revierte con una migración hacia adelante
  que las borra en orden seguro de FK (`resume_claim_facts`, `resume_generation_runs`,
  `resume_batches`, `resume_versions`, `career_document_extractions`, `career_documents`,
  `career_facts`, `career_profiles`). Ninguna tabla existente se modifica, así que no hay nada que
  restaurar.
- **Fase 2** es código muerto sin rutas. Se revierte quitando las funciones; los permisos nuevos no
  los consulta nadie.
- **Fase 3** se oculta quitando el área `career` de `nav-config.ts`; las rutas API siguen sirviendo a
  quien tenga el enlace, y los datos permanecen.
- **Fase 4** se revierte quitando el botón de export. Las versiones ya emitidas siguen legibles en el
  editor; nada se borra.
- **Fase 5** se apaga con `AI_DISABLED_TASKS=resume-base-compose,resume-quality-review`. La UI cae
  al compositor determinista **sin degradar el producto**: es exactamente el camino de la Fase 4.
  Las reservas en vuelo se liberan; ninguna versión ya generada se toca.
- **Fase 6** se apaga con `CANDIDATE_UPLOADS_ENABLED=false`: el área de upload se deshabilita con su
  motivo y el resto del producto no se entera. Los documentos ya subidos siguen descargables y el
  sweeper de retención sigue corriendo.
- **Fase 7** se apaga con `AI_DISABLED_TASKS=resume-job-fit-analyze,resume-tailor`; el fallback
  determinista de reordenación sigue disponible, así que el tailoring no desaparece, sólo deja de
  reescribir.
- **Fase 8** se apaga poniendo `RESUME_BATCH_LIMITS` a 0 y quitando la entrada de cron. El worker es
  idempotente y no hace nada sin lotes en cola; los lotes en vuelo se liquidan por lo consumido en la
  siguiente corrida antes de que el flag los pare.
- **En ningún caso un rollback borra contenido**: perfiles, hechos, documentos y versiones sobreviven
  a cualquier desactivación. El único efecto de apagar es que dejan de crearse cosas nuevas.
