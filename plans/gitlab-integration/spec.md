# Feature: GitLab Integration

## Problem

Hoy BuilderHunt indexa developers desde GitHub, pero ignora GitLab. GitLab tiene una base enorme de developers (especialmente Europa y empresas) que **no están en GitHub** o tienen perfiles paralelos. Si un usuario busca "rust async" en BuilderHunt, solo ve la mitad de los candidatos.

GitLab también es donde vive buena parte del código open source empresarial (Google, Siemens, NASA, etc.). Es un eje de "enterprise OSS" que BuilderHunt no captura.

## Goal

Indexar developers de GitLab.com (la instancia SaaS pública) con la misma calidad de signal que GitHub:
- Username, display name, bio, avatar
- Repos públicos con stars/forks (no expuesto en la API pública — solo "projects")
- Actividad pública: contribs a proyectos, issues abiertas
- Filtros: por actividad reciente, por país, por bio keyword

## Non-goals

- **No es self-hosted GitLab.** Solo `gitlab.com`. Self-hosted requiere que cada empresa exponga su API; fuera de scope.
- **No es merge requests / issues / snippets.** Solo personas y opcionalmente proyectos públicos. El resto suma ruido.
- **No es sync de followers/following.** GitLab no expone grafo social comparable a GitHub.

## User stories

1. **Como usuario**, al buscar "kubernetes operator" en BuilderHunt, quiero ver developers de GitLab junto a los de GitHub, Reddit, HN, DEV.to.
2. **Como usuario**, en `/search`, quiero un toggle "GitLab" en la fila de sources (al lado de GitHub) para incluir o excluir GitLab de mis búsquedas.
3. **Como usuario**, en los saved searches, quiero poder filtrar específicamente por GitLab o combinar GitHub + GitLab.
4. **Como usuario**, en los results, las tarjetas de GitLab deben distinguirse visualmente de las de GitHub (otro brand).

## API summary

- **Base URL**: `https://gitlab.com/api/v4/`
- **Auth**: opcional (mejor rate limit con token, 6000/h vs 2000/h)
- **Endpoints clave**:
  - `GET /search?scope=users&search=X` — search by username/name/email (fuzzy)
  - `GET /users?username=X` — lookup by exact username
  - `GET /users/:id` — user details
  - `GET /users/:id/projects` — public projects
  - `GET /search?scope=projects&search=X` — search projects
- **Rate limit**: 2000/h unauth, 6000/h con PAT
- **Docs**: https://docs.gitlab.com/api/users/

## Data shape

Reutiliza el `RawBuilder` actual, con un nuevo `source: 'gitlab'`:

```ts
{
  id: `gl-${user.id}`,
  kind: 'person' | 'repo',
  source: 'gitlab',
  sourceId: String(user.id),
  username: user.username,
  displayName: user.name ?? user.username,
  avatarUrl: user.avatar_url,
  bio: user.bio ?? undefined,
  profileUrl: user.web_url,
  followersCount: user.followers,           // not exposed! see open questions
  topics: [],                               // not exposed either
  metadata: {
    publicProjects: user.projects_limit,     // wrong field, see open questions
    createdAt: user.created_at,
    location: user.location,
    organization: user.organization,
    jobTitle: user.job_title,
  }
}
```

> **Important caveat**: GitLab's free API does NOT expose followers/following counts, topics, or stargazer counts on public projects. This is a real signal-quality gap. See "Open questions" below.

## UX integration

- New `gitlab` value in the `Source` type
- New pill in the search page source filter
- New `SOURCE_META.gitlab = { label: 'GitLab', color: 'badge-gitlab', Icon: GitLabIcon }` (need a GitLab brand SVG — same as we did for GitHub/Reddit/HN/DEV.to)
- Source pill color: orange (GitLab's brand color is `#FC6D26` / `#FCA326`)

## Success metrics

- **Primary**: % of saved searches that have at least 1 GitLab result. Target: 30% (most queries will have some GitLab signal).
- **Secondary**: Click-through rate from GitLab results is within 20% of GitHub results. If much lower, the data is too sparse.
- **Quality guardrail**: GitLab results that get "dismissed" rate < 50% (vs >40% for other sources). Above this, disable GitLab by default and revisit data quality.

## Open questions

- **Followers count not exposed.** GitLab's API returns the user object but not `followers`. Options:
  - (a) Set `followersCount: undefined` and use `createdAt` as a proxy for "freshness"
  - (b) Approximate via `user.projects_limit` and `publicProjects` (also not exposed)
  - (c) Score GitLab users differently — use search relevance + recency + bio match
  - **Recommended**: (c). Add a `sourceQuirks` flag in the scoring system to give GitLab a different (and honest) score breakdown.
- **Stargazers on projects also not exposed.** GitLab calls them "stars" but they're not in the public API. Only "forks_count" and "open_issues_count" are.
- **Avatar URLs are full URLs** (not relative like some sources). No proxy needed.
- **De-duplication**: a user with the same email on both GitHub and GitLab should appear once. Cross-source dedup is a v2 feature; for v1, same email → merge.

## Out of scope (this iteration)

- Self-hosted GitLab instances
- Merge requests / issues / snippets
- Group membership (visible in API but adds noise)
- Following graph / social signals
- GitLab CI pipelines (irrelevant for builder discovery)
