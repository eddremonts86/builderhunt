# Plan de entrega — generación y adaptación de CV

> **Status**: `pending`
> **Depends on**: [`job-opportunities-workspace`](../job-opportunities-workspace/spec.md), [`ai-expansion`](../../phase-1/ai-expansion/spec.md), [`calendar-scheduling-interview-intelligence`](../../phase-1/calendar-scheduling-interview-intelligence/spec.md)
> **Blocks**: [`delegated-job-applications`](../delegated-job-applications/spec.md)
> **Reality check**: Reutiliza storage/extraction de documentos, task registry y billing. No debe
> almacenar CVs en `builders.metadata`, portfolio público ni tablas de candidate submissions.

## Fase 0 — truth contract, formato y evaluación

- aprobar taxonomy de career facts;
- elegir contrato estructurado y templates;
- crear corpus sanitizado y rúbrica;
- medir tokens/latencia/coste;
- documentar provider/privacy y retención.

Salida: unsupported claim policy verificable y pricing provisional.

## Fase 1 — perfil profesional manual

- tablas/permissions/RLS;
- career profile/facts CRUD;
- confirm/reject/supersede;
- UI manual sin IA;
- export/delete.

Salida: CV base puede construirse manualmente si IA está off.

## Fase 2 — upload y extracción

- integrar storage, scan y extraction;
- document lifecycle;
- task `career-facts-extract`;
- facts inbox con evidence spans;
- conflict detection.

Salida: PDF/DOCX/TXT importado no publica ni confirma claims.

## Fase 3 — CV base

- `resume-base-compose`;
- structured editor;
- deterministic validations;
- template/render PDF/DOCX/TXT;
- versions/diff/restore.

Salida: primer CV exportable con 100% fact coverage.

## Fase 4 — tailoring individual

- `resume-job-fit-analyze`;
- gap/evidence UI;
- `resume-tailor`;
- diff/lock/edit/approval;
- job version pinning.

Salida: variante explicable para una oferta.

## Fase 5 — batch

- batch state machine y worker;
- preflight, dedupe, credits;
- concurrency/cancel/retry/partial;
- review queue y ZIP approved.

Salida: 15 ofertas completan sin exceder reserva ni mezclar resultados.

## Fase 6 — hardening y rollout

- eval gates, RLS, privacy, injection, rendering y load;
- feature flags por manual/import/generate/tailor/batch;
- internal dogfood;
- beta personal workspaces;
- provider cost monitoring.

## Riesgos

| Riesgo | Mitigación |
|---|---|
| IA inventa experiencia | fact IDs obligatorios y export blocker |
| CV filtra PII | personal ownership, private storage y provider minimization |
| Lote excede coste | preflight, reserva, concurrency y cancel |
| Output visual roto | DTO + deterministic render + snapshots |
| Oferta manipula prompt | untrusted input y schema |
| “ATS score” engañoso | hygiene checks, no universal score |
| Facts cambian | dependency graph y stale marking |

## Rollback

Desactivar generación mantiene perfil/editor/export manual. Desactivar batch no afecta variantes
individuales. Los documentos y versiones permanecen accesibles; provider work queued se cancela y
reservas se liberan. No se borra contenido durante rollback.

