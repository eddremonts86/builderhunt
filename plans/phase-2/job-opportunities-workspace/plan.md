# Plan de entrega — workspace interno de ofertas

> **Status**: `pending`
> **Depends on**: [`security-and-multitenancy`](../../phase-1/security-and-multitenancy/spec.md), [`ai-expansion`](../../phase-1/ai-expansion/spec.md)
> **Blocks**: [`ai-cv-generation-and-tailoring`](../ai-cv-generation-and-tailoring/spec.md), [`delegated-job-applications`](../delegated-job-applications/spec.md)
> **Reality check**: Debe crear un dominio nuevo y reutilizar `src/lib/enrichment/` para fetch
> seguro, `src/shared/lib/ai/` para extracción y el ledger de billing; no debe reutilizar tablas de
> entrevistas ni jobs operacionales.

## Fase 0 — decisiones y pruebas de riesgo

- aprobar clasificación “tenant-private + individual owner”;
- verificar adquisición permitida para fuentes prioritarias;
- probar SSRF/redirect/content-size contra el fetcher existente;
- reunir 50 ofertas sanitizadas en varios idiomas para evaluar extracción;
- fijar límite y coste después de medir tokens.

Salida: ADR de ownership, source registry, dataset de evaluación y rate card provisional.

## Fase 1 — contratos y migración

- schemas Zod, enums y state machines;
- tablas, índices, composite FKs, grants y RLS;
- permisos `job:read|create|update|delete|import`;
- actualización de data classification y authorization matrix.

Salida: migración restaurable y pruebas RLS usuario A/B.

## Fase 2 — CRUD manual vertical

- repositorio tenant-scoped;
- API list/create/read/update/archive/delete;
- `/jobs` con lista, detalle y formulario;
- filtros/status;
- export/delete account integration.

Salida: crear, editar, archivar y eliminar una oferta sin IA.

## Fase 3 — extracción de texto y URL

- registrar `job-description-extract`;
- integrar source policy y fetch seguro;
- producir propuesta con evidence spans;
- preview/diff antes de confirmar;
- cache, credits y fallback manual.

Salida: paste y URL individual funcionan con IA on/off.

## Fase 4 — importación por lotes

- batches/items y worker HTTP idempotente;
- CSV/URLs, preview, progreso, cancelación y retry;
- reservas/settlement de créditos;
- UI de resultados y errores;
- concurrencia por host y global.

Salida: 15 URLs con combinación de éxito, duplicado y error convergen correctamente.

## Fase 5 — dedupe, versionado y frescura

- normalización y fingerprints;
- merge preview;
- refresh con HTTP validators;
- version diff;
- expiration/stale signals.

Salida: un refresh no altera el snapshot enlazado a un CV anterior.

## Fase 6 — hardening y rollout

- unit, API, RLS, migration, SSRF, prompt injection, load y E2E;
- feature flags por manual/URL/batch;
- dashboards de backlog/coste/error;
- rollout interno → personal org beta → planes elegibles.

## Riesgos

| Riesgo | Mitigación |
|---|---|
| Exposición de búsqueda laboral a compañeros | owner_user_id además de RLS tenant |
| Scraping prohibido | source registry y deny-by-default |
| SSRF mediante URL | resolver/validar cada redirect y bloquear redes privadas |
| Lote caro | preview, reserva máxima, cancelación y settlement real |
| Oferta cambia después del CV | versiones inmutables |
| Dedupe destructivo | sugerencia y confirmación para matches ambiguos |
| IA inventa campos | null + evidence spans + revisión |

## Rollback

Flags independientes desactivan URL/batch/IA y conservan CRUD manual. La migración es aditiva. Un
rollback no borra ofertas; el worker deja items queued/cancelled de forma reconciliable. Los
downstreams ignoran el dominio cuando el feature flag está off.
