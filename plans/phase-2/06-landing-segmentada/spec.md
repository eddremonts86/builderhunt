# Especificación — landing segmentada

> **Status**: `pending`
> **Depends on**: [`02-segmentacion-usuarios`](../../implemented/phase-2/02-segmentacion-usuarios/spec.md)
> **Blocks**: nothing
> **Reality check**: La home pública usa `src/modules/landing/components/HomePage.tsx`; existe
> routing público, SEO, sitemap, pricing y analytics de conversión. La landing actual contiene casos
> de uso generales, pero no ofrece páginas ni funnel persistente para los nuevos segmentos.

## Objetivo

Permitir que cada visitante reconozca rápidamente que BuilderHunt resuelve su trabajo, vea
capacidades reales y llegue a signup/onboarding con su intención preservada y medible.

## Estrategia

### Home

La home conserva un posicionamiento principal único. Mientras investigación no demuestre lo
contrario, hiring es el mensaje dominante por cercanía con el producto actual.

Incluye selector:

- “Estoy contratando”;
- “Estoy descubriendo oportunidades de inversión”;
- “Quiero gestionar mi perfil como builder”.

El selector cambia el panel de beneficios y enlaza a una página profunda; no reescribe toda la home
de forma invisible.

### Páginas por segmento

- `/for/hiring-teams`;
- `/for/investors`;
- `/for/builders`.

Cada página contiene:

1. problema/JTBD en lenguaje del segmento;
2. workflow de tres pasos;
3. evidencia/capacidades reales;
4. beneficios y objeciones;
5. screenshot/demo auténtico;
6. FAQ;
7. CTA con segment hint;
8. enlaces a pricing, privacidad y seguridad.

## Mensajes iniciales sujetos a investigación

### Hiring

- promesa: encontrar builders activos con evidencia pública reciente;
- CTA: “Start finding builders”;
- prueba: búsqueda, perfiles multi-source, tracking, sprints e interviews.

### Investing

- promesa prudente: descubrir y seguir builders técnicos alrededor de una tesis;
- CTA: “Create a discovery radar”;
- no prometer deal flow, compañías, rondas o proprietary data inexistentes.

### Building

- promesa: reclamar y enriquecer una identidad basada en trabajo público verificable;
- CTA: “Find my profile”;
- no prometer leads, visitas o contratación garantizada.

## Handoff al producto

CTA añade un valor allowlisted `segment`. Durante signup se conserva en almacenamiento temporal
seguro y onboarding lo confirma. Reglas:

- validar enum;
- first-party only;
- TTL limitado;
- elección persistida gana sobre hint antiguo;
- nunca usar para permisos, precios o acceso.

## SEO

- metadata, canonical, OG y structured data únicos;
- sitemap incluye las tres páginas;
- contenido sustancial, no doorway pages duplicadas;
- enlaces internos desde home/footer;
- si un segmento queda `no-go`, su página se elimina o se convierte en contenido no transaccional.

## Experimentación

- feature flag de selector/páginas;
- asignación estable de variante;
- eventos: view, segment_select, CTA, signup, onboarding_start, activation;
- atribución first-touch y last-touch claramente diferenciada;
- privacidad: sin fingerprinting adicional ni query literals.

## Accesibilidad y rendimiento

- tabs/selector con semántica y teclado correctos;
- contenido útil sin JavaScript;
- imágenes responsive y budgets actuales;
- reduced motion;
- mobile first y CTAs claros.

## Métricas

- comprensión cualitativa antes del lanzamiento;
- CTR a signup por segmento;
- signup completion;
- onboarding start/completion;
- activación por origen;
- conversión a pago cuando volumen lo permita;
- no optimizar CTR a costa de activación o confianza.

## No objetivos

- tres marcas;
- pricing diferente por persona;
- contenido inventado;
- testimonios o números sin fuente;
- personalización encubierta basada en tracking;
- páginas generadas masivamente.

## Criterios de aceptación

- cada afirmación corresponde a una capacidad real o está marcada como upcoming;
- CTA preserva segmento hasta onboarding;
- SEO/sitemap/OG completos;
- eventos reconstruyen funnel;
- página funciona SSR, mobile, teclado y sin JS;
- rollback devuelve home actual.
