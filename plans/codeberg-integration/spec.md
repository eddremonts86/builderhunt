# Feature: Codeberg (Gitea) Integration

## Why (short)

Codeberg es la instancia Gitea más grande. Open source, EU-based (Berlín), fuerte entre devs que rechazan GitHub. Tiene la API estándar de Gitea que también sirve para **cualquier instancia Gitea auto-hospedada** (universities, empresas). Es el equivalente EU-friendly de GitHub.

## API summary

- **Base URL**: `https://codeberg.org/api/v1/` (Gitea-compatible)
- **Auth**: opcional, mejora rate limit
- **Endpoints** (Gitea standard):
  - `GET /users/search?q={query}&limit=20` — user search
  - `GET /users/{username}` — user details
  - `GET /users/{username}/repos` — repos
  - `GET /repos/search?limit=20&q={query}` — repo search
- **Rate limit**: 500/h sin auth, ~5000/h con token
- **Docs**: https://docs.gitea.io/en-us/api-1.0.html

**Bonus**: same API works for any self-hosted Gitea instance. Could add support for "custom Gitea" later.

## Why honorable mention

- **Nicho**: ~100k users vs 100M+ on GitHub
- **API familiar** (Gitea is well-documented)
- **Same pattern as GitHub**: just different base URL
- **Self-hosted potential**: v2 could let users add their company's Gitea

## Effort

**S-M (1-2 días)**. Pattern is identical to GitHub; just change base URL and shape of response. Faster than GitLab because Gitea is simpler.

## Recommendation

**Integrate after GitLab** (which proves the "second forge" demand). Could be done in parallel if we have capacity. The pattern is the same, so the marginal effort is small.
