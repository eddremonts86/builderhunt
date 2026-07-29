# Plan de entrega — investigación de ICP y buyer personas

> **Status**: `pending`
> **Depends on**: nothing
> **Blocks**: [`02-segmentacion-usuarios`](../02-segmentacion-usuarios/spec.md), [`06-landing-segmentada`](../06-landing-segmentada/spec.md)
> **Reality check**: La landing en `src/modules/landing/components/HomePage.tsx` contiene casos de
> uso, pero no constituye validación. Las métricas actuales de onboarding agregan usuarios y no
> distinguen objetivos.

## Fase 1 — preparar el estudio

- declarar hipótesis por segmento;
- definir screener y criterios de exclusión;
- preparar guion neutral, consentimiento y scorecard;
- capturar baseline actual de adquisición y activación.

## Fase 2 — entrevistar

- ejecutar primero hiring, porque coincide mejor con el producto actual;
- ejecutar investing sin presentar capacidades que todavía no existen;
- ejecutar building separando valor de red y willingness-to-pay;
- sintetizar después de cada bloque de cinco para detectar saturación o sesgo.

## Fase 3 — probar mensajes

- crear tres variantes de propuesta de valor;
- realizar tests moderados de comprensión;
- medir qué cree la persona que hace BuilderHunt, para quién es y cuál sería su siguiente acción;
- descartar mensajes que requieren explicación verbal.

## Fase 4 — decidir

- puntuar los segmentos con la misma rúbrica;
- clasificar cada uno como primario, experimento o lado de oferta;
- definir buyer, usuario final y pagador;
- cerrar nombres y valores internos de la taxonomía.

## Fase 5 — handoff

- entregar contratos y eventos propuestos a segmentación;
- entregar mensajes, objeciones y CTA a landing;
- entregar criterios de activación a onboarding/dashboard;
- registrar preguntas no resueltas para rondas posteriores.

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

