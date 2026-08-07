# Plan de entrega — landing segmentada

> **Status**: `pending`
> **Depends on**: [`02-segmentacion-usuarios`](../02-segmentacion-usuarios/spec.md)
> **Blocks**: nothing
> **Reality check**: Se extiende el sistema público actual y sus componentes; no se crea una app de
> marketing separada.

## Fase 1 — arquitectura de contenido

- convertir hallazgos ICP en message matrix;
- auditar cada claim contra producto;
- preparar screenshots/proof y FAQ;
- aprobar mensajes antes de código.

## Fase 2 — contratos y componentes

- configurar contenido tipado por segmento;
- crear componentes compartidos de selector, beneficios y CTA;
- preservar SSR y progressive enhancement.

## Fase 3 — páginas y home

- publicar hiring primero;
- publicar investing detrás de flag experimental;
- publicar builders cuando claim flow soporte la promesa;
- añadir selector y enlaces internos.

## Fase 4 — handoff y analítica

- validar/persistir hint;
- conectar signup/onboarding;
- instrumentar funnel completo;
- probar atribución y consentimiento.

## Fase 5 — SEO, QA y rollout

- metadata/OG/structured data/sitemap;
- accessibility, responsive, visual y performance QA;
- lanzamiento gradual;
- revisión de métricas con guardrails de activación.

## Riesgos

| Riesgo | Mitigación |
|---|---|
| Mensaje promete producto futuro | Claim audit obligatorio |
| Doorway SEO pages | Contenido único y sustancial |
| Investor distrae del ICP fuerte | Flag y no-go explícito |
| Hint se vuelve autoridad | Enum allowlisted y confirmación |
| Optimización engañosa de CTR | Medir activación downstream |

## Rollback

Desactivar selector y rutas segmentadas, retirar sitemap entries y conservar home actual. Los hints
ya persistidos siguen siendo preferencias válidas, pero onboarding usa fallback si el segmento se
retira de la taxonomía.
