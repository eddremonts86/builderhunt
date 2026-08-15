# Plan de entrega — dashboard personalizado por segmento

> **Status**: `partially-implemented`
> **Depends on**: [`02-segmentacion-usuarios`](../../implemented/phase-2/02-segmentacion-usuarios/spec.md), [`03-onboarding-segmentado`](../03-onboarding-segmentado/spec.md)
> **Blocks**: nothing
> **Reality check**: The compositor primitives, registry, accessible reordering, persistence API,
> optimistic concurrency and tenant-isolation e2e coverage already exist. The remaining work is
> segment context, presets and rollout measurement.

## Delivered foundation

- `src/modules/dashboard/lib/widget-registry.ts` is the stable typed registry.
- `src/modules/dashboard/components/DashboardCustomizeDialog.tsx` provides keyboard-accessible
  visibility, pinning and ordering controls.
- `src/routes/api/dashboard/preferences.ts`,
  `src/shared/lib/dashboard/preferences-contract.ts` and
  `src/shared/lib/repositories/dashboard-preferences.ts` persist organization-scoped preferences
  with optimistic concurrency; migrations are `0151`–`0153`.

## Fase 1 — inventario y contrato segmentado

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

## Fase 4 — integrar overrides existentes

- resolver cambios de segmento sobre el contrato de preferencias existente;
- mantener restauración, revisiones y reconciliación de widgets retirados;
- no crear una segunda tabla, ruta o formato de preferencias.

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
