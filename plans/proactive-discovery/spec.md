# Feature: Proactive Discovery ("Builders you should know about")

## Problem

Hoy BuilderHunt es un **buscador pasivo**: el usuario llega, escribe keywords, mira resultados, se va. Solo vuelve cuando tiene una necesidad concreta. Eso es una **utilidad**, no un producto. Las utilidades se reemplazan fácil.

La mayoría de las sesiones de búsqueda descubren personas que el usuario **no sabía que estaba buscando**. Esa es la parte que más valor genera, y la que el usuario no activa por sí mismo. Si BuilderHunt solo espera la pregunta, está perdiendo el 80% del valor de su grafo cruzado.

## Goal

Convertir BuilderHunt de "search when you need to" a "abro BuilderHunt y descubro a alguien nuevo cada día". Una sección **"For you"** en el dashboard que empuja builders adyacentes a los intereses del usuario, antes de que los pida.

## Non-goals

- **No es un sistema de recomendación ML.** Es una query SQL con scoring de overlap (keywords + topics + sources + repos). Nada de embeddings, nada de collaborative filtering.
- **No es infinite scroll.** Cards curadas (8-12 por carga), refrescadas una vez al día o cuando el usuario guarda builders nuevos.
- **No es un feed social.** Sin likes, sin shares, sin follows. Es un digest curado por la data, no por humanos.
- **No reemplaza la búsqueda.** El usuario siempre puede buscar más allá de lo recomendado.

## User stories

1. **Como usuario nuevo** (sin saved searches ni saved builders), quiero ver sugerencias starter ("Try searching for X" o top builders en temas populares) para entender qué hace el producto.
2. **Como usuario con 1+ saved searches**, quiero ver cada día 5-10 builders adyacentes que matchean mis intereses pero que aún no he visto, sin tener que pedirlos.
3. **Como usuario activo**, quiero poder ocultar builders de mis recomendaciones (mark as "not relevant") para refinar lo que veo.
4. **Como usuario**, quiero ver **por qué** se me recomienda alguien (qué keyword / topic / source coincide) para entender el match y confiar en la sugerencia.

## UX flow

**Ubicación:** sección "For you" en el dashboard, **encima de las stats cards** (es la primera cosa que el usuario ve al loguearse).

**Empty state (usuario nuevo, 0 saved searches):**
```
┌─────────────────────────────────────────────────┐
│  ✨  For you                                     │
│  Run a search to start getting daily picks.     │
│                                                  │
│  [ Try: rust distributed systems ]              │
│  [ Try: indie hackers in EU ]                   │
│  [ Try: AI agents in production ]               │
└─────────────────────────────────────────────────┘
```

**Populated state:**
```
┌─────────────────────────────────────────────────┐
│  ✨  For you                            ↻ Refresh │
│  3 new picks based on your 4 saved searches    │
│  ─────────────────────────────────────────────  │
│  [Card] [Card] [Card]                            │
│  [Card] [Card] [Card]                            │
│  [Card] [Card]                                   │
│                                                  │
│  Why these?  matches "rust async runtime" (2)  │
│              in HN, GitHub                      │
└─────────────────────────────────────────────────┘
```

**Card (similar a la card de "Recent builders" actual pero con metadata extra):**
- Avatar
- Name + handle
- Source badges (puede tener varios: github + hn)
- Topics
- 1-line bio
- "Why you're seeing this: matches 'rust async' in 2 saved searches"
- Quick action: **Save** (primary) / **Dismiss** (ghost)

## Success metrics

- **Primary:** % de usuarios activos semanales que ven al menos 1 recomendación semanal. Target: 50% después de 4 semanas del launch.
- **Secondary:** Click-through rate (CTR) de "Save" en una card de For-you. Target: >15% (vs. ~5% CTR típico de search).
- **Guardrail:** Tasa de "Dismiss". Si >40% de cards son dismissed, el algoritmo es demasiado ruidoso.

## Data shape (API response)

```ts
type Recommendation = {
  builder: {
    id: string
    username: string
    displayName: string | null
    avatarUrl: string | null
    bio: string | null
    source: 'github' | 'reddit' | 'hn' | 'devto'
    followersCount: number | null
    topics: string[]
  }
  reasons: Array<{
    type: 'keyword' | 'topic' | 'source' | 'repo'
    value: string             // "rust async runtime", "github", "tokio-rs/tokio"
    matchedSearchName: string // name of the user's saved search that matched
  }>
  score: number                // 0-100, for tiebreaking
  seenAt: string | null        // null = new, ISO string = already shown
}
```

## Open questions

- **¿Multi-source builders?** Si un builder aparece en GitHub Y HN, ¿lo mostramos 1 vez con varios source badges, o 1 vez por source? → Asumir 1 builder = 1 card con badges múltiples.
- **¿Cross-user recommendations?** ¿"Other people who saved X also saved Y"? Requiere ≥N saved searches similares. Skip por ahora (cold start).
- **¿Recency del builder vs del match?** Si un builder matchea keywords pero lleva 2 años inactivo, ¿lo mostramos? → Filtrar `lastSeen > 90 days` salvo override.
- **¿Refresh explícito?** "↻ Refresh" carga más, o solo feedback visual? → Empezar solo visual, server-side ya devuelve los top N.

## Out of scope (this iteration)

- Email digest con recomendaciones (futuro: similar a "weekly digest")
- "Similar builders" en la página de perfil (futuro, fácil de añadir después)
- Feedback loop persistente (actualmente dismiss es client-side only)
- "Trending in your topics" feed
