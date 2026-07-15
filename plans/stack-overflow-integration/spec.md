# Feature: Stack Overflow Integration

## Problem

Hoy BuilderHunt indexa GitHub, Reddit, HN, DEV.to. Falta **el registro canónico de expertise técnica**: Stack Overflow. Sus top users por tag son **los que responden** — señal de expertise. Si un usuario busca "kubernetes operator" en BuilderHunt, debería ver a los top SO users de `kubernetes` y `k8s.io`, no solo devs que commit code.

## Goal

Indexar SO users con expertise signal:
- Username, display name, avatar
- Reputation (proxy fuerte de expertise)
- Top tags (proxy de dominio)
- Answers count (proxy de participación)
- Bio (a veces tienen uno)

## Non-goals

- **No es full-text de questions.** Solo users.
- **No es SO for Teams.** Solo el público.
- **No es scraping de answers.** Demasiado volumen.
- **No es reputation real-time.** Cache agresivo (cambia poco).

## API summary

- **Base URL**: `https://api.stackexchange.com/2.3/`
- **Auth**: optional but recommended (10k req/día sin key, 300 con key por IP)
- **Endpoint clave**:
  - `GET /users?site=stackoverflow&pagesize=20&order=desc&sort=reputation&filter=!-*f(6s)8tG`
  - `GET /users/{ids}?site=stackoverflow`
  - `GET /tags?site=stackoverflow` (for tag list)
  - `GET /users/{ids}/top-tags?site=stackoverflow` (top tags per user)
- **Rate limit**: 300 req/día sin key por IP, 10k/día con key
- **Docs**: https://api.stackexchange.com/docs

**Critical**: the API has a QUOTA model. The free key is per-IP, easy to exhaust. Need a registered app + key.

## Data shape

```ts
{
  id: `so-${user.user_id}`,
  kind: 'person',
  source: 'stackoverflow',
  sourceId: String(user.user_id),
  username: user.display_name,
  displayName: user.display_name,
  avatarUrl: user.profile_image,
  bio: user.about_me || `Top tags: ${topTags.join(', ')}`,
  profileUrl: user.link,
  followersCount: user.reputation,  // SO doesn't have followers; use rep
  topics: topTags.slice(0, 5),
  metadata: {
    reputation: user.reputation,
    goldBadges: user.badge_counts.gold,
    silverBadges: user.badge_counts.silver,
    bronzeBadges: user.badge_counts.bronze,
    answerCount: user.answer_count,
    questionCount: user.question_count,
    location: user.location,
    accountAge: user.creation_date,
  }
}
```

## User stories

1. **Como usuario**, busco "rust async" y veo a los top SO users de los tags `rust` y `async`.
2. **Como usuario**, en `/search`, toggle "Stack Overflow" en los sources.
3. **Como usuario**, en los results, las tarjetas de SO muestran reputation como "followers" y top tags como topics.

## Success metrics

- **Primary**: % of saved searches that find at least 1 SO user. Target: 50% (SO covers most popular programming topics).
- **Secondary**: CTR on SO results is within 30% of GitHub.
- **Quality guardrail**: dismiss rate < 30% (SO reputation is a strong signal).

## Open questions

- **Reputation as followers**: SO doesn't have a follower count. Use reputation (proxy for expertise). Or use `accept_rate` (how often their answers are accepted).
- **Top tags**: fetch separately (`/users/{ids}/top-tags`) per user. That's 1 extra request per user. Cache 1h.
- **Search by tag or by keyword?** SO search is by tag. We can pass our query as a tag filter, but might miss matches. Two options:
  - (a) Search users by their top tags overlapping with query
  - (b) Use SO search API for users matching a query (less precise)
  - **Recommended**: (a) — fetch top SO users, filter by tag overlap with query.

## Out of scope (this iteration)

- SO for Teams / Enterprise
- Answers / questions
- Real-time reputation changes
- Stack Exchange network (other sites: Server Fault, Super User, etc. — v2)
