# Feature: RSS Feeds per Saved Search

## Problem

Hoy las alertas de BuilderHunt son **email**. Email tiene tres problemas:

1. **Fricción alta.** El usuario tiene que dar su email (que ya hizo para el sign-up, OK), pero luego tiene que configurar un email separado, filtros, "from address", decidir si quiere daily/weekly/instant. Demasiados pasos para algo que el usuario quiere que "simplemente le llegue".
2. **Saturación.** Los developers vivimos saturados de email. Un email más de un producto SaaS se pierde entre 50 newsletters y 20 notificaciones.
3. **No es compartible.** Un email de alerta es privado por naturaleza. No puedo reenviarlo a un compañero sin que tenga cuenta.

Mientras tanto, **los developers seguimos usando RSS** (Feedly, Inoreader, NetNewsWire). Es donde consumimos HN, lobste.rs, dev newsletters convertidas, GitHub release feeds. Es nuestro substrate nativo.

## Goal

Cada saved search tiene una **URL pública de RSS** que el usuario puede:
1. Pegar en su reader (Feedly, Inoreader, etc.)
2. Compartir con un compañero (link público, no requiere auth)
3. Compartir públicamente en Twitter, su blog, etc.

Eso convierte cada saved search en un **endpoint compartible** de la app, y a cada usuario en un **posible evangelista** del producto.

## Non-goals

- **No es auth-gated.** El feed es público. La data que indexa es pública (ya scraped de fuentes públicas).
- **No es personalizable.** No hay "filtros en el feed", no hay "include/exclude keywords". Si quieres custom, edita la search.
- **No es un reemplazo de email.** Email sigue ahí para quien lo prefiera. RSS es **alternativa**, no **reemplazo**.
- **No es full-text.** El feed muestra builders nuevos que matchean, no un stream de cada commit/post. (Eso sería ruido.)
- **No es un RSS reader.** El usuario usa el suyo. BuilderHunt solo emite.

## User stories

1. **Como usuario**, quiero copiar la URL de RSS de mi saved search con un click, pegarla en Feedly, y empezar a recibir updates sin dar mi email ni configurar nada.
2. **Como usuario**, quiero compartir mi saved search con un compañero vía link, sin que tenga que registrarse para verlo.
3. **Como visitante anónimo** (llegando vía un link compartido), quiero ver un feed RSS válido que pueda subscribir inmediatamente en mi reader.
4. **Como usuario power**, quiero ver un feed combinado de todas mis saved searches en un solo endpoint (bonus, no v1).

## UX flow

**En la página de Saved searches (dashboard):**

```
┌─────────────────────────────────────────────────────────┐
│  Saved searches                                          │
│  ──────────────────                                      │
│  Rust async runtime                                      │
│  rust, async, tokio · 3 sources                         │
│                                          [Run] [RSS]    │
│                                                          │
│  Indie hackers in EU                                     │
│  indie, hacker, eu · 2 sources                           │
│                                          [Run] [RSS]    │
└─────────────────────────────────────────────────────────┘
```

**Click en [RSS]:**
- Modal/tooltip con la URL: `https://builderhunt.dev/api/feeds/<searchId>.xml`
- Botón "Copy"
- Botón "Open in Feedly" (deep link)
- Botón "Open in Inoreader" (deep link)
- Texto: "This feed is public. Anyone with the link can subscribe."

**Visitante anónimo pegando la URL en el browser:**
- Si acepta application/xml o un reader pide la URL → XML válido (RSS 2.0)
- Si es un humano en el browser → HTML "nice page" con explicación + link a la app

**Visitante pegando la URL en Feedly:**
- Feedly detecta RSS, muestra preview, permite subscribir

## Data shape (XML)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>BuilderHunt — Rust async runtime</title>
    <link>https://builderhunt.dev/search?q=...</link>
    <description>New builders matching "rust async runtime" — updated daily</description>
    <language>en-us</language>
    <lastBuildDate>Wed, 15 Jul 2026 19:00:00 GMT</lastBuildDate>
    <atom:link href="https://builderhunt.dev/api/feeds/<id>.xml" rel="self" type="application/rss+xml" />

    <item>
      <title>alice — Rust async runtime</title>
      <link>https://builderhunt.dev/builder/abc123</link>
      <guid isPermaLink="false">builderhunt-builder-abc123</guid>
      <pubDate>Wed, 15 Jul 2026 12:00:00 GMT</pubDate>
      <description><![CDATA[
        Senior Rust engineer working on async runtimes.
        Topics: rust, async, tokio
        Sources: github, hn
        Last seen: 2 days ago
        Why this match: matches keywords "rust", "async" in your saved search.
      ]]></description>
    </item>
    ...
  </channel>
</rss>
```

## Public discovery (bonus, v1.5)

Una página `/explore` que lista los saved searches públicos más populares (medidos por nº de subscriptores del feed o por nº de builders descubiertos). Marketing orgánico y SEO.

## Success metrics

- **Primary:** Nº de saved searches que tienen al menos 1 fetch del feed en los últimos 30 días. Target: 20% después de 4 semanas.
- **Secondary:** Nº de clicks en "Copy RSS link" / "Open in Feedly" en la página de saved searches. Target: 10% de los usuarios.
- **Viral:** Nº de feeds accedidos sin auth (proxy de "usuarios nuevos llegaron vía feed"). Target: 100/mes en el primer mes post-launch.

## Out of scope (this iteration)

- Auth-gated feeds
- Per-builder RSS (futuro, fácil de añadir)
- WebSub / PubSubHubbub (push updates en vez de poll)
- "Combined" feed multi-search
- Per-user "all my searches" feed
- Feed analytics dashboard (defer until we have meaningful volume)

## Open questions

- **¿Cache-Control?** RSS readers poll aggressively. Sugerido: `Cache-Control: max-age=3600` (1h).
- **¿Auth del user?** El feed es público pero el contenido es **de un saved search privado del user**. ¿Es OK? → Asumir que sí (la data es pública; el "saved" es organización personal). Si el user quiere hacer el feed privado, no lo exponemos en la UI.
- **¿Rate limiting?** Sí, en el endpoint: 60 req/h per IP, suficiente para un reader normal. Previene scraping.
- **¿Abuse / spam?** Si un user crea 50 saved searches para spamear RSS, ¿lo permitimos? → Rate limit en creación de saved searches (10/día) ya cubre esto.
- **¿Límite de items en el feed?** Cap a 50 items, ordenados por `lastSeen DESC`. Readers antiguos paginan via `?page=N` (no v1).
