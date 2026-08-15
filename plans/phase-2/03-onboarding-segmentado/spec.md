# Especificación — onboarding segmentado

> **Status**: `implemented`
> **Depends on**: [`02-segmentacion-usuarios`](../../implemented/phase-2/02-segmentacion-usuarios/spec.md)
> **Blocks**: [`04-dashboard-personalizado`](../04-dashboard-personalizado/spec.md)
> **Reality check**: El onboarding actual está implementado en `src/routes/onboarding/`,
> `src/shared/lib/onboarding.ts` y `src/routes/api/onboarding/`. Su flujo
> welcome → search → save → success activa hiring, usa progreso 0..3 y es skippable.

## Objetivo

Conservar un solo framework de onboarding, pero conducir a cada persona hasta una acción inicial
que corresponda a su objetivo y pueda medirse como activación real.

## Flujo v2

```text
welcome → goal → action by segment → confirmation → personalized next step
```

### Hiring

1. seleccionar objetivo `hiring`;
2. elegir stack/rol/localización o una starter query;
3. ejecutar búsqueda;
4. guardar al menos tres builders;
5. CTA a dashboard, sprint o alertas.

Activación: `tracked_builders >= 3` o primer sourcing sprint creado.

### Investing

1. seleccionar objetivo `investing`;
2. definir tesis ligera: tecnologías, industria o tipo de builder;
3. ejecutar discovery;
4. guardar búsqueda/radar y seguir entidades;
5. CTA a señales/alertas.

Activación: primera búsqueda guardada con alerta/radar. No se llamará “deal flow” mientras el
producto no modele compañías, rondas y relaciones de inversión.

### Building

1. seleccionar objetivo `building`;
2. localizar el propio perfil;
3. iniciar o completar claim;
4. añadir disponibilidad, temas y portfolio cuando las capacidades existentes lo permitan;
5. CTA al perfil/portfolio.

Activación: claim verificado o, si la verificación es asíncrona, claim iniciado con siguiente paso
claro. No fabricar visitas u oportunidades.

### Other o sin selección

Usar el flujo actual de búsqueda como experiencia general. Nunca bloquear acceso al dashboard.

## Estado

Extender `onboarding_progress` con:

- `flow_version`;
- `current_step_key`;
- `activation_type`;
- `activation_ref_id`;
- `activated_at`.

Mantener columnas históricas durante la migración. La state machine del servidor determina pasos
válidos según segmento y no confía en un step arbitrario del cliente.

## Entrada desde landing

La landing puede enviar `?segment=hiring|investing|building`. El valor se valida, se guarda como
intención temporal y se confirma en onboarding. Un parámetro de URL nunca concede permisos ni
sobrescribe silenciosamente una elección persistida.

## UX

- explicar el beneficio de elegir objetivo;
- permitir volver y cambiar antes de completar;
- progreso con nombres, no números opacos;
- skip en todos los pasos;
- refresh/deep-link seguros;
- copy y ejemplos diferentes por segmento;
- éxito con una siguiente acción concreta.

## Métricas

- prompt → selección;
- inicio → completion por segmento;
- tiempo hasta activación;
- skip y abandono por step key;
- activación D1 y retorno D7;
- comparación con cohorte del onboarding v1.

## Rollout

- feature flag por porcentaje/cohorte;
- usuarios con onboarding v1 completado no se reabren automáticamente;
- usuarios en progreso terminan v1 o migran mediante regla documentada;
- detener rollout si completion o activación cae materialmente respecto al baseline.

## No objetivos

- vídeo tour;
- tres árboles de rutas duplicados;
- recomendación mediante LLM;
- bloquear producto hasta completar;
- onboarding específico por rol de organización.

## Criterios de aceptación

- todos los segmentos llegan a una acción funcional existente;
- estado inválido no salta pasos sensibles;
- reload y back funcionan;
- skip siempre sale;
- los eventos permiten construir funnel por segmento;
- fallback general cubre null/other/enum futuro.

