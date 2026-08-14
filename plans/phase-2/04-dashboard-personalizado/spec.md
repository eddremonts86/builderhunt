# Especificación — dashboard personalizado por segmento

> **Status**: `partially-implemented`
> **Depends on**: [`02-segmentacion-usuarios`](../../implemented/phase-2/02-segmentacion-usuarios/spec.md), [`03-onboarding-segmentado`](../03-onboarding-segmentado/spec.md)
> **Blocks**: nothing
> **Reality check**: `/dashboard` already has a typed widget registry
> (`src/modules/dashboard/lib/widget-registry.ts`), accessible customization controls, and
> organization-scoped, versioned preferences through `/api/dashboard/preferences` backed by
> `drizzle/0151_dashboard_preferences.sql`, `drizzle/0152_dashboard_preferences_grants.sql` and
> `drizzle/0153_dashboard_preferences_order.sql`. This plan adds segment presets and context; it
> must reuse those contracts.

## Objetivo

Priorizar señales, acciones y widgets relevantes para el objetivo del usuario conservando una
experiencia consistente, configurable y completa.

## Arquitectura

### Registro de widgets

Cada widget declara:

- ID estable;
- componente;
- datos requeridos;
- permiso/entitlement requerido;
- tamaño permitido;
- estado empty/loading/error;
- eventos de interacción.

### Presets

`DashboardPreset` define orden, visibilidad, tamaño y CTA por segmento:

- `general`;
- `hiring`;
- `investing`;
- `building`.

El preset es presentación. El servidor sigue autorizando cada fuente de datos de forma independiente.

### Resolución

```text
segment preference
  → preset
  → filter unavailable by permission/entitlement
  → apply user layout overrides
  → render widgets with independent error boundaries
```

## Contenido recomendado

### Hiring

- shortlist/builders guardados;
- recomendaciones recientes;
- sourcing sprints activos;
- entrevistas/calendario;
- alertas;
- CTA: iniciar búsqueda o sprint.

### Investing

- saved queries/radares;
- señales recientes;
- builders seguidos;
- actividad por tecnologías/temas;
- alertas;
- CTA: crear radar.

Solo se muestran widgets soportados por datos reales.

### Building

- estado de claim/perfil;
- acciones para completar portfolio;
- disponibilidad/open-to;
- actividad pública verificada;
- oportunidades o visitas únicamente cuando existan métricas reales;
- CTA: completar/compartir perfil.

### General

Mantiene la composición actual y sirve a null, other, errores o segmentos nuevos.

## Configuración

- selector de densidad existente permanece;
- usuario puede ocultar/reordenar/restaurar preset;
- overrides se guardan por usuario, no cambian recursos;
- cambiar segmento pregunta si se conserva layout o se restaura preset.

## Datos y rendimiento

- evitar un endpoint gigante específico por segmento;
- widgets reutilizan endpoints existentes cuando sea razonable;
- agregar endpoint de contexto/preset ligero;
- fetch paralelo y lazy para widgets secundarios;
- preservar budgets de rendimiento y settle signal E2E.

## Accesibilidad y resiliencia

- orden DOM comprensible aunque el layout visual cambie;
- keyboard reorder o alternativa accesible;
- un widget fallido no tumba el dashboard;
- empty states accionables y honestos;
- layout mobile explícito por preset.

## Métricas

- impresión/interacción de widget;
- uso de CTA;
- activación/retención por preset;
- porcentaje que modifica/restaura layout;
- latencia y tasa de error por widget.

## No objetivos

- dashboards completamente separados;
- drag-and-drop obligatorio en MVP;
- permisos basados en segmento;
- generar widgets con LLM;
- esconder navegación válida solo porque un preset no la prioriza.

## Criterios de aceptación

- fallback general siempre renderiza;
- presets producen diferencias funcionales;
- permisos y entitlements se respetan en servidor;
- cambio de segmento actualiza sin perder recursos;
- dashboard cumple rendimiento, accesibilidad y E2E.
