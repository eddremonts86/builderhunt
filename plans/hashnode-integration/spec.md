# Feature: Hashnode Integration

## Why (short)

Hashnode es un competitor directo de DEV.to. Misma audiencia (developers que escriben), mismas features (articles, tags, follows). Si DEV.to está integrado, Hashnode también debería estarlo — son complementarios, no redundantes.

## API summary

- **Base URL**: `https://api.hashnode.com/`
- **Auth**: API key (free tier)
- **Endpoints** (GraphQL):
  - `query { user(username: "X") { ... } }` — user details
  - `query { users(publicationId: ...) { ... } }` — publication users
  - `query { feed(type: "PUBLICATION", ... ) }` — articles
- **Rate limit**: ~1000 req/h
- **Docs**: https://api.hashnode.com/

## Why honorable mention (not top pick)

- **High overlap with DEV.to**: same audience, same content type
- **API GraphQL**: more complex than REST
- **Lower traffic** than DEV.to in 2026
- **Different signal**: Hashnode users often have personal domains; more "professional blogger" vibe

## Effort

**M (2-3 días)**. GraphQL client, similar pattern to DEV.to. The marginal value over DEV.to is small (same audience).

## Recommendation

**Skip for now** unless we have a strong reason. DEV.to already covers the "developers who write" segment. If we see users specifically asking "find me Hashnode writers", we add it.

Better candidates to spend that 2-3 days on: Stack Overflow, Lobsters, or Hugging Face.
