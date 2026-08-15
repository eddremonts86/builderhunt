# Plan de entrega — onboarding segmentado

> **Status**: `implemented`
> **Depends on**: [`02-segmentacion-usuarios`](../../implemented/phase-2/02-segmentacion-usuarios/spec.md)
> **Blocks**: [`04-dashboard-personalizado`](../04-dashboard-personalizado/spec.md)
> **Reality check**: Se debe evolucionar la state machine y rutas actuales, no crear otro onboarding.

## Fase 1 — diseñar el state machine v2

- mapear pasos y transiciones por segmento;
- definir eventos de activación con recursos reales;
- diseñar migración desde progreso 0..3;
- mantener fallback v1/general.

## Fase 2 — persistencia y API

- añadir columnas de versión/step/activación;
- reemplazar avance numérico confiado por comandos/step keys validados;
- devolver estado suficiente para render y resume;
- probar concurrencia, repetición y navegación inválida.

## Fase 3 — selección de objetivo

- añadir route `goal`;
- persistir en preferencias;
- aceptar hint de landing tras validación;
- garantizar que cambiar el objetivo reinicia solamente el progreso incompatible, nunca los datos.

## Fase 4 — ramas

- adaptar búsqueda/guardado para hiring;
- crear configuración de radar para investing reutilizando saved queries/alerts;
- integrar claim para building;
- construir success compartido con contenido parametrizado.

## Fase 5 — instrumentación y rollout

- eventos por step key;
- dashboard de funnel;
- activar para equipo interno, luego 10%, 50%, 100%;
- comparar activación, no solo completion.

## Riesgos

| Riesgo | Mitigación |
|---|---|
| Duplicación de UI | Configuración y componentes compartidos |
| Branch sin feature real | Fallback honesto y gate de research |
| Estado histórico incompatible | flow_version y migración explícita |
| Parámetro de landing manipulado | Validación y confirmación |
| Completion mejora pero valor no | Métrica de activación separada |

## Rollback

Desactivar onboarding v2, mantener nuevas columnas y servir v1. Las preferencias de segmento y
recursos creados sobreviven. No decrementar ni borrar progreso automáticamente.

