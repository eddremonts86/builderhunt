# Plan de entrega — dashboard personalizado por segmento

> **Status**: `pending`
> **Depends on**: [`02-segmentacion-usuarios`](../02-segmentacion-usuarios/spec.md), [`03-onboarding-segmentado`](../03-onboarding-segmentado/spec.md)
> **Blocks**: nothing
> **Reality check**: Bento y widgets existentes permiten una refactorización incremental.

## Fase 1 — inventario y contrato

- inventariar widgets, datos, permisos y entitlements;
- definir registro y presets puros;
- capturar visual/performance baseline.

## Fase 2 — compositor general

- extraer el dashboard actual como preset `general`;
- añadir error boundaries y carga independiente;
- conservar markup/test IDs críticos.

## Fase 3 — presets segmentados

- hiring primero como caso de control;
- investing solo con datos disponibles;
- building integrado con claim/portfolio;
- snapshots y pruebas de orden/visibilidad.

## Fase 4 — overrides

- persistir visibilidad/orden de widgets;
- restaurar defaults;
- resolver cambios de segmento;
- evitar layouts inválidos tras retirar widgets.

## Fase 5 — rollout

- shadow calculation del preset sin cambiar UI;
- activar por segmento/cohorte;
- comparar performance y acciones;
- promover solo presets con evidencia de mejora.

## Riesgos y rollback

| Riesgo | Mitigación |
|---|---|
| Tres codebases de dashboard | Registro y compositor únicos |
| N+1 requests | Auditoría y paralelización controlada |
| Widget revela datos | Auth server-side independiente |
| Personalización inútil | Medir acciones, no impresiones |
| Layout roto en mobile | Orden mobile por contrato |

Rollback: forzar preset `general` mediante flag e ignorar overrides sin borrarlos.

