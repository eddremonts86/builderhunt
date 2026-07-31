# Tareas — landing segmentada

> **Status**: `pending`
> **Depends on**: [`01-investigacion-icp`](../01-investigacion-icp/spec.md), [`02-segmentacion-usuarios`](../02-segmentacion-usuarios/spec.md)
> **Blocks**: nothing
> **Reality check**: `HomePage.tsx`, sitemap y layouts públicos ya existen.

- [ ] **Crear message matrix aprobada**
  - Files: `docs/marketing/phase-3-segment-message-matrix.es.md`
  - Do: JTBD, problema, promesa, evidencia, objeción, CTA y afirmaciones prohibidas por segmento.
  - Verify: cada claim enlaza a feature real o se elimina.

- [ ] **Crear configuración tipada de contenido**
  - Files: `src/modules/landing/content/segment-pages.ts`, `tests/unit/modules/landing/content/segment-pages.test.ts`
  - Do: contenido exhaustivo sobre `UserSegment` y metadata.
  - Verify: tests de segmentos, links, CTA y claims obligatorios.

- [ ] **Crear componentes compartidos**
  - Files: `src/modules/landing/components/SegmentSelector.tsx`, `src/modules/landing/components/SegmentLandingPage.tsx`, `tests/unit/modules/landing/components/SegmentSelector.test.tsx`
  - Do: selector/tab accesible, secciones y CTA reutilizables.
  - Verify: keyboard, screen reader, no-JS y component tests.

- [ ] **Crear páginas públicas**
  - Files: `src/routes/_landing/for/hiring-teams.tsx`, `src/routes/_landing/for/investors.tsx`, `src/routes/_landing/for/builders.tsx`
  - Do: SSR, head/canonical/OG/structured data y contenido específico.
  - Verify: HTTP 200 SSR y screenshots mobile/desktop.

- [ ] **Integrar selector en home**
  - Files: `src/modules/landing/components/HomePage.tsx`
  - Do: mantener mensaje principal y añadir selector/enlaces sin layout shift.
  - Verify: visual regression, reduced motion y Lighthouse.

- [ ] **Preservar hint hasta onboarding**
  - Files: `src/shared/lib/landing-segment-hint.ts`, `src/modules/auth/components/SignUpPage.tsx`, `src/routes/onboarding/goal.tsx`
  - Do: validar, TTL, first-party storage y precedencia de preferencia persistida.
  - Verify: e2e landing → signup → goal y valores manipulados/expirados.

- [ ] **Actualizar descubrimiento SEO**
  - Files: `src/routes/sitemap[.]xml.ts`, `src/routes/robots[.]txt.ts`, `src/routes/__root.tsx`
  - Do: sitemap, crawling y structured data coherente.
  - Verify: parsear sitemap, canonical único y OG preview.

- [ ] **Instrumentar funnel y feature flags**
  - Files: `src/shared/lib/conversion-events.ts`, `src/shared/lib/conversion-client.ts`, `src/routes/api/analytics/conversion.ts`, `.env.example`, `docs/operations/segmented-landing-rollout.md`
  - Do: extender el funnel existente con view/select/CTA/signup/onboarding/activation sin PII.
  - Verify: evento sintético atraviesa funnel y flag off restaura home/rutas.

- [ ] **Ejecutar QA de lanzamiento**
  - Files: `docs/design/responsive-qa-checklist.md`, `docs/accessibility-verification.md`
  - Do: revisar navegadores, breakpoints, teclado, lectores, performance, copy legal y claims.
  - Verify: `pnpm build`, tests, Playwright, performance budget y smoke runtime.
