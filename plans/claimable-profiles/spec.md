# Feature: Public Claimable Builder Profiles

## Problem

BuilderHunt hoy es una plataforma de **un solo lado**: solo los "cazadores" (recruiters, founders, maintainers) la usan. Los builders (las personas indexadas) no saben que existen, no pueden reclamar su perfil, y no pueden enriquecer la data que los representa.

Eso es un problema porque:
1. **Data drift.** Si un builder cambia de enfoque, de país, o deja de estar activo, no hay forma de que la plataforma lo sepa. La data se queda obsoleta.
2. **Confianza cero.** Un recruiter ve "John Doe — Rust async" sin verificación. ¿Es el John correcto? ¿Está todavía activo? No hay forma de saberlo.
3. **Sin flywheel.** Cazadores guardan builders → esa data no vuelve a los builders → builders nunca llegan a la plataforma → el crecimiento depende 100% de la adquisición por parte de los cazadores.
4. **Sin moat de network effects.** Cualquiera puede scrapear la misma data de GitHub. La única defensa sostenible es que los builders quieran **estar** en BuilderHunt.

## Goal

Convertir BuilderHunt en una plataforma de **dos lados**:
- **Cazadores** descubren, guardan, contactan.
- **Builders** reclaman su perfil, lo enriquecen, lo mantienen, y (opcionalmente) declaran su disponibilidad.

El día que un builder busca su propio nombre en Google y encuentra su perfil BuilderHunt — con un badge "Verified" y un link a su repo — la plataforma se vuelve imparable. Ahora el builder tiene una razón para volver, actualizar su info, y mantener su perfil fresco.

## Non-goals

- **No es un LinkedIn.** No es una red social, no es un portfolio completo, no hay endorsements ni recomendaciones.
- **No es público-anónimo.** Los profiles son públicos. Si el builder quiere estar fuera, no reclamamos. Pero la data scraped de fuentes públicas ya es pública.
- **No es verificado-por-empleador.** Verified = "este perfil es realmente de esta persona y está mantenido por ella". No = "esta persona es un developer senior".
- **No requiere todos los campos.** Un builder puede reclamar sin añadir nada. Solo el badge cambia.

## User stories

### Builders (lado "reclamado")
1. **Como builder**, quiero buscar mi nombre, encontrar mi perfil, y reclamarlo con un click.
2. **Como builder**, quiero verificar que el perfil es mío vía OAuth (GitHub, Reddit, etc.) o vía un email al email público de mi profile.
3. **Como builder verificado**, quiero añadir/editar mis topics, mi bio, y mi "open to" status (chats, hires, mentoring, nada).
4. **Como builder verificado**, quiero ver analytics: cuántas personas me han guardado, qué keywords usaron, top sources.

### Visitantes (público)
5. **Como visitante**, quiero ver `/builders/<username>` y ver el perfil completo con badge de verificación si aplica.
6. **Como visitante**, quiero ver "saved by 12 people" o "tracked by 3 teams" como social proof.
7. **Como visitante no-auth**, no puedo guardar (auth required) pero puedo ver el perfil completo y subscribir al RSS del builder.

### Cazadores (lado autenticado)
8. **Como cazador**, los perfiles reclamados y verificados aparecen más arriba en search (signal boost).

## UX flow

### Página pública de perfil: `/builders/<username>`

```
┌─────────────────────────────────────────────────────────┐
│  [avatar]  John Doe  ✓ Verified                          │
│            @johndoe  · github.com/johndoe                │
│            Senior Rust engineer working on async runtimes│
│                                                         │
│  Topics: [rust] [async] [distributed-systems] [tokio]  │
│  Source: GitHub  Hacker News                             │
│  Last seen: 2 days ago                                   │
│                                                         │
│  ─────────────────────────────────────────────────       │
│                                                         │
│  🟢  Open to: chats about Rust, mentoring               │
│                                                         │
│  ─────────────────────────────────────────────────       │
│                                                         │
│  Stats                                                  │
│  • 47 stars · 12 forks on top repo                      │
│  • 23 HN comments this month                            │
│  • Trending in: rust, async, distributed systems       │
│                                                         │
│  Recent activity                                        │
│  • 2 days ago — 1.2k stars on tokio-rs/mio              │
│  • 5 days ago — Top HN comment on "async Rust in 2026"  │
│  • 1 week ago — Release v0.3.2 of hyper                 │
│                                                         │
│  ─────────────────────────────────────────────────       │
│                                                         │
│  Saved by 12 people · 3 teams                           │
│                                                         │
│  [  Save to my list  ]  [  Add note  ]                   │
│  [  Subscribe to RSS  ]                                 │
│                                                         │
│  ─────────────────────────────────────────────────       │
│                                                         │
│  Is this you? [Claim this profile →]                   │
└─────────────────────────────────────────────────────────┘
```

### Reclamar perfil (no auth)

1. Visit `/builders/<id>` (no auth)
2. Click "Is this you? Claim this profile"
3. **Modal:** "We'll send a verification link to the email we have on file. If that doesn't work, you can verify via [GitHub OAuth]."
4. Enter email → receive link with signed token
5. Click link → if matches, profile becomes `claimed + pending_verified`
6. Optional: connect GitHub OAuth to flip to `verified`

### Builder dashboard (auth required, is a claimed builder)

`/me/dashboard`:
```
┌─────────────────────────────────────────────────────────┐
│  Your profile  ✓ Verified                                │
│  ────────────────────────────                           │
│  This week                                              │
│  12 people saved you                                    │
│  8 people searched for your handle directly            │
│  Top keywords others used: "rust", "async", "tokio"    │
│                                                         │
│  [  Edit profile  ]  [  View public profile  ]          │
│  [  Set "open to" status  ]  [  Notification settings  ]│
└─────────────────────────────────────────────────────────┘
```

## Data model changes

**`builders` table — new columns:**

```sql
ALTER TABLE builders ADD COLUMN
  is_claimed boolean DEFAULT false NOT NULL,
  claimed_by_user_id text REFERENCES auth_users(id) ON DELETE SET NULL,
  claimed_at timestamp with time zone,
  is_verified boolean DEFAULT false NOT NULL,
  verified_at timestamp with time zone,
  open_to_status jsonb DEFAULT '[]'::jsonb,  -- ['chats', 'mentoring', 'hires']
  claimed_topics jsonb DEFAULT '[]'::jsonb;  -- builder-curated topics (separate from scraped)
```

**New table: `builder_claim_requests`**

```sql
CREATE TABLE builder_claim_requests (
  id text PRIMARY KEY,
  builder_id text NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  email text NOT NULL,
  token text NOT NULL UNIQUE,
  expires_at timestamp with time zone NOT NULL,
  used_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
```

**New table: `builder_profile_views` (for analytics)**

```sql
CREATE TABLE builder_profile_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  builder_id text NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  viewer_id text REFERENCES auth_users(id) ON DELETE SET NULL,  -- null if anonymous
  viewed_at timestamp with time zone DEFAULT now() NOT NULL
);
-- Index on (builder_id, viewed_at DESC) for analytics
```

## Success metrics

- **Primary:** % of indexed builders who are claimed within 90 days. Target: 10% (assuming we have 1000+ indexed builders).
- **Secondary:** % of claimed builders who add `open_to_status` or `claimed_topics`. Target: 50% of claimed.
- **Tertiary:** Click-through rate from "Claim this profile" CTA. Target: 1% of anonymous profile views.
- **Quality:** Profile freshness — % of verified profiles with `verified_at < 180 days`. Target: > 70%.

## Out of scope (this iteration)

- GitHub OAuth verification (v2 — email verification is enough for v1)
- Editable bio / avatar (the scraped bio is the bio for v1)
- "Endorsements" from other users
- Builder-to-builder connections
- Public builder directory (`/builders` listing all claimed builders)
- Custom vanity URLs (`builderhunt.dev/johndoe`)
- Multi-language profile support

## Open questions

- **¿Quién puede reclamar un perfil?** Cualquiera con acceso al email del builder (sea el builder o no). Si el impostor reclama, el builder real puede "dispute" y reset. **Para v1:** confiamos en el email + OAuth. Disputes en v2.
- **¿El perfil es público incluso si no está reclamado?** Sí. Los datos scraped son públicos. Reclamar = control del builder, no = publicity.
- **¿Verified badge = real authority?** No. Verified = "el builder mantiene este perfil". No dice nada sobre skills.
- **¿Builders pueden tener cuentas sin ser builders indexados?** Sí, en `/me/onboarding` pueden crear su perfil desde cero si no están en el índice. (v2)

## Privacy

- **`open_to_status`:** público. El builder lo elige explícitamente.
- **`claimed_topics`:** público. Refuerza la data scraped.
- **Email:** privado. Solo se usa para enviar el verification link, no se muestra.
- **`builder_profile_views`:** el builder ve aggregate counts, no la lista de viewers.
- **Disputes:** si alguien reclama un perfil que no es suyo, el builder real puede "dispute" con proof (commit, post). Reseteamos. (v2)
