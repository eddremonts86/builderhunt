# Plan de entrega — investigación de ICP y buyer personas

> **Status**: `pending`
> **Depends on**: nothing
> **Blocks**: nothing — participant-dependent work lives in
> [`phase-5/04-post-launch-discovery`](../../phase-5/04-post-launch-discovery/plan.md).
> **Reality check**: La landing en `src/modules/landing/components/HomePage.tsx` contiene casos de
> uso, pero no constituye validación. Las métricas actuales de onboarding agregan usuarios y no
> distinguen objetivos.

## Fase 1 — preparar el estudio

- declarar hipótesis por segmento;
- definir screener y criterios de exclusión;
- preparar guion neutral, consentimiento y scorecard;
- capturar baseline actual de adquisición y activación.

## Fase 2 — congelar el baseline

- registrar las consultas, ventanas temporales y fuentes de cada métrica disponible;
- marcar explícitamente las métricas que aún no están instrumentadas;
- enlazar el paquete y el baseline desde el plan post-launch que ejecutará las entrevistas.

La contratación de participantes, las entrevistas, los tests moderados, la síntesis y la decisión
se ejecutan en phase 5. Mantenerlos aquí duplicaría tareas y volvería a bloquear cinco planes con
trabajo externo que no puede completarse antes de lanzar.

## Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Muestra de conveniencia | Reclutar fuera de la red inmediata |
| Sesgo de solución | Preguntar por comportamientos pasados antes de mostrar BuilderHunt |
| Síntesis inventada | Vincular cada conclusión a notas anonimizadas |
| Claude tratado como investigación | Usarlo solo para crítica y clustering |
| Scope creep | Decidir taxonomía, no diseñar tres productos completos |

## Rollback

No hay cambios de runtime. Si la evidencia contradice la taxonomía propuesta, se reemplazan los
valores antes de crear migraciones. Si solo hiring supera el umbral, el MVP captura un objetivo
principal y mantiene los demás como experimentos de landing, no como ramas completas.
