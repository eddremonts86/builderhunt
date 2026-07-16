# Feature: Onboarding Flow

## Problem

Hoy, un usuario nuevo que se registra ve el dashboard con:
- 0 saved searches
- 0 saved builders
- "For you" con empty state (5 starter suggestions)
- For you dice "Run a search to start getting daily picks"

Eso es **frío**. No hay guía, no hay "aha moment", no hay próximo paso claro. La mayoría de signups se van a ir sin hacer una sola búsqueda. El "activation rate" (signups que completan su primer saved search) probablemente está < 30%.

Sin onboarding:
1. El usuario no entiende qué hace el producto
2. No sabe qué buscar primero
3. Se siente abrumado por las 12 fuentes
4. Se va sin volver

## Goal

Onboarding de 3 pasos que termina con el usuario en su primer "aha moment":

1. **Welcome** — qué es BuilderHunt, el value prop
2. **First search** — guiada, con sugerencias pre-llenadas
3. **Save results** — elige 3+ builders, "boom, ya tienes un radar"

Medir el éxito: **activation rate sube a > 60%** (signup → primer saved search)

## Non-goals

- **No es un wizard de 10 pasos.** 3 pasos, máx.
- **No es obligatorio.** Se puede saltar. Pero si lo hace, conversion sube.
- **No es un tour del producto.** Es un "ah, esto es lo que hago aquí".
- **No es para usuarios authed existentes** (v1) — solo nuevos signups
- **No es un "verify your email" flow.** Eso es Better Auth, separado.

## User stories

1. **Como usuario nuevo**, quiero ver un welcome screen que me diga en 5 segundos qué hace BuilderHunt
2. **Como usuario nuevo**, quiero una primera búsqueda pre-poblada con sugerencias (no pensar qué buscar)
3. **Como usuario nuevo**, quiero poder guardar 3+ builders con un click desde los resultados
4. **Como usuario nuevo**, quiero un "Congrats, your first radar is live!" con un CTA claro de qué sigue
5. **Como usuario que skipea onboarding**, no quiero ser forzado. La dashboard normal debe ser usable.

## UX flow

### Step 1: Welcome (skippable)

```
┌─────────────────────────────────────────────────────┐
│  Welcome to BuilderHunt 👋                          │
│                                                      │
│  BuilderHunt helps you find active developers across  │
│  GitHub, Reddit, HN, DEV.to, Stack Overflow, npm,    │
│  Hugging Face, GitLab, Codeberg — all in one place.  │
│                                                      │
│  Save a search, get daily picks of people building   │
│  the things you care about.                          │
│                                                      │
│  [ Show me how → ]  [ Skip, take me to dashboard ]  │
└─────────────────────────────────────────────────────┘
```

### Step 2: First search (with pre-filled suggestion)

```
┌─────────────────────────────────────────────────────┐
│  What are you looking for?                            │
│                                                      │
│  Try one of these:                                   │
│  [ rust async runtime ]                              │
│  [ indie hackers in EU ]                             │
│  [ AI agents in production ]                        │
│  [ react performance ]                               │
│  [ python ML engineers ]                             │
│                                                      │
│  Or type your own: [________________] [Search]      │
│                                                      │
│  We'll search 8 sources: GitHub, HN, Reddit, DEV.to, │
│  Stack Overflow, npm, Hugging Face, GitLab, Codeberg│
└─────────────────────────────────────────────────────┘
```

### Step 3: Save builders (with bulk save)

After search results load:
- "Save your favorites to start a radar"
- Each card has a "Save" button (already in the card)
- Counter: "Saved 0/3" → "Saved 1/3" → "Saved 3/3, you can finish later"
- Skip button: "I'll save later"

### Step 4: Success

```
┌─────────────────────────────────────────────────────┐
│  🎉 Your radar is live!                              │
│                                                      │
│  You'll get fresh picks in your dashboard every day. │
│  Saved: 5 builders · 1 search                        │
│                                                      │
│  [ Go to dashboard → ]                               │
│  [ See today's picks → ]                             │
└─────────────────────────────────────────────────────┘
```

## Data model

**New table: `onboarding_progress`**

```sql
CREATE TABLE onboarding_progress (
  user_id text PRIMARY KEY REFERENCES auth_users(id),
  step int NOT NULL DEFAULT 0,  -- 0..3
  completed boolean NOT NULL DEFAULT false,
  skipped boolean NOT NULL DEFAULT false,
  completed_at timestamp with time zone,
  first_query_id text REFERENCES saved_queries(id),
  first_builder_ids jsonb DEFAULT '[]'::jsonb,  -- list of builder ids saved in step 3
  created_at timestamp with time zone DEFAULT now()
);
```

**New env var**: none

**New packages**: none

## API endpoints

- `GET /api/onboarding/status` — current user's progress (0-3, completed, skipped)
- `POST /api/onboarding/skip` — mark as skipped, redirect to dashboard
- `POST /api/onboarding/complete` — mark step as done
- `GET /api/onboarding/suggestions` — list of 5 starter queries (pre-defined or from a `onboarding_suggestions` table)

## Server logic

**When to show onboarding:**
- User signed up in last 7 days
- `onboarding_progress.completed = false` AND `skipped = false`
- OR no record exists yet

**Skip conditions:**
- User already has 1+ saved searches (they figured it out themselves)
- User has 5+ saved builders
- User clicked "Skip" 3+ times

**Where to show:**
- After sign-up, redirect to `/onboarding/welcome` (not dashboard)
- On dashboard, show a dismissable banner: "👋 First time here? Start the 3-step tour" (if eligible)

**Tracking:**
- Sign-up → create `onboarding_progress` row with step=0
- Each step → POST `/api/onboarding/complete` with step number
- Step 3 done → mark completed=true, completed_at=now
- Skipped → mark skipped=true

## Success metrics

- **Primary**: Activation rate (signup → first saved search) within 7 days. Target: > 60%
- **Secondary**: Avg time to first save. Target: < 5 minutes
- **Tertiary**: Skip rate. Target: < 30% (high skip = onboarding is annoying)
- **Guardrail**: Drop-off at each step. Step 1→2 should be > 80%, Step 2→3 should be > 50%

## Out of scope (v1)

- Personalized onboarding (different per persona: recruiter vs founder vs dev)
- Video tutorials
- Onboarding for power users returning after 30+ days
- A/B testing framework (use LaunchDarkly or similar later)
- Tooltips / hotspots for advanced features

## Open questions

- **Should step 2 auto-search the suggestion when clicked?** Yes — one less click
- **Should we track which starter suggestion they picked?** Yes — `first_query_id` in DB
- **Multi-language onboarding?** No — English v1, translate later

## Dependencies

- Existing: `authUsers`, `savedQueries`, `builders` tables
- New table: `onboarding_progress`
- Schema migration: 1 new table

## Estimated effort

| Phase | Effort |
|-------|--------|
| 1 — Data model + API | S (2-3h) |
| 2 — Welcome screen | S (2-3h) |
| 3 — Search step | S (2-3h) |
| 4 — Save step + success | M (3-4h) |
| 5 — Skip logic + dashboard banner | S (2-3h) |
| **Total** | **~2 days** |
