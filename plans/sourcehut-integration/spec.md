# Feature: SourceHut Integration

## Why (short)

Open source forge con base de users pequeña pero muy leal. Foco en privacidad y código abierto. Complementa a GitHub/GitLab con devs que rechazan Microsoft. **Nicho pero leal**: si tu usuario busca "open source maximalist", SourceHunt es donde están.

## API summary

- **Base URL**: `https://sr.ht/` (graphQL) + REST en `https://api.sourcehut.org/`
- **Auth**: opcional, mejora rate limit
- **Endpoints**:
  - `POST /query` (GraphQL) — search users by username
  - `GET /api/user/profile/{username}` — user details
  - `GET /api/user/repos` — repos
- **Rate limit**: sin auth ~60 req/h, con PAT ~600 req/h
- **Docs**: https://man.sr.ht/integrations/

## Why honorable mention

- **Nicho**: ~50k users vs 100M+ en GitHub
- **API menos madura** que GitHub/GitLab (GraphQL en beta)
- **Slow scrape**: response times pueden ser lentos

## Effort

**M (3-4 días)**. La API es GraphQL, hay que escribir el cliente, y el rate limit es agresivo (60/h sin auth).

## Recommendation

**No integrar en v1.** Hacer después de GitLab, cuando sepamos que el "open source forge" angle tiene tracción. Si BuilderHunt crece en el segmento EU/OSS, este es un buen paso 2.
