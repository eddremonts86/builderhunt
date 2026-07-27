# Plan de entrega — candidaturas delegadas

> **Status**: `pending`
> **Depends on**: [`job-opportunities-workspace`](../job-opportunities-workspace/spec.md), [`ai-cv-generation-and-tailoring`](../ai-cv-generation-and-tailoring/spec.md), [`ai-expansion`](../../phase-1/ai-expansion/spec.md)
> **Blocks**: nothing
> **Reality check**: El MVP prepara y asiste; no envía formularios externos. Debe crear un dominio
> candidate-side separado de `hiring-pipeline-kanban`, ATS e interview candidate submissions.

## Fase 0 — mandato, políticas y eval

- aprobar autonomía human-in-the-loop;
- definir prohibited actions/questions;
- source registry y caps;
- corpus de job/profile matches;
- scoring rubric, coste y quality gates;
- threat model de portal/extension.

Salida: policy que impide submit y facts sensibles por diseño.

## Fase 1 — application tracker manual

- tablas, RLS, permissions y events;
- answer facts manual;
- CRUD y kanban personal;
- enlazar job y resume existente;
- status transitions.

Salida: el usuario puede registrar y seguir candidaturas sin IA.

## Fase 2 — mandates y runs

- wizard de reglas;
- version/pause/revoke/expiry;
- worker idempotente;
- toma ofertas internas;
- hard filters/dedupe/freshness.

Salida: un run produce shortlist determinista sin generar kits.

## Fase 3 — scoring

- task `candidate-job-fit`;
- explainable requirement mapping;
- deterministic score;
- threshold/weights;
- eval y fallback.

Salida: ranked shortlist con gaps y evidence.

## Fase 4 — kits

- CV tailoring integration;
- optional cover letter;
- answer mapping y unresolved questions;
- immutable kit versions;
- review/approve/reject.

Salida: ningún kit puede aprobarse con unsupported claim o required unanswered fact.

## Fase 5 — portal handoff

- safe outbound link;
- download/copy;
- manual submitted status;
- opcional browser-extension prefill con user click;
- no final submit.

Salida: evidencia E2E de que el servidor nunca envía.

## Fase 6 — scheduled delegation

- schedule/caps;
- background discovery/scoring/preparation;
- notifications;
- pause/cancel/cost controls;
- per-source throttling.

Salida: daily run no supera mandato ni presupuesto.

## Fase 7 — hardening y rollout

- RLS, privacy, bias, injection, costs, load y E2E;
- internal dogfood con fake portals;
- closed beta;
- incident/complaint path;
- post-launch quality monitoring.

## Riesgos

| Riesgo | Mitigación |
|---|---|
| Spam masivo | approval individual, caps y dedupe |
| Respuesta falsa/sensible | confirmed answer bank y never-auto categories |
| Discriminación | protected traits excluidos y eval |
| Portal prohíbe automatización | source registry, no bypass, user submit |
| Doble candidatura | owner+job uniqueness y transitions |
| Oferta caducada | freshness check antes de kit/handoff |
| Coste alto | hard filters antes de IA y preflight |
| Confusión employer/candidate data | dominio y rutas separados |

## Rollback

Flags desactivan scheduled runs, IA, kits y prefill por separado. El tracker manual permanece.
Workers activos se cancelan, reservas se liberan y ningún estado submitted se revierte. Revocar un
mandato impide nuevo trabajo inmediatamente.

