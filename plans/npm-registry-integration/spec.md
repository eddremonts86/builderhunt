# Feature: npm Registry Integration

## Problem

GitHub user search encuentra developers, pero **no encuentra package maintainers** directamente. Si alguien busca "state management" en BuilderHunt, debería ver a los maintainers de `redux`, `zustand`, `jotai`, etc. — la gente que **construyó** las herramientas. Esa es una clase DIFERENTE de builder que ninguna otra fuente captura.

npm registry tiene TODOS los packages con su `_npmUser` (publisher) y `maintainers` (array con nombres + emails). Es **el registro canónico** del ecosistema JS.

## Goal

Indexar npm packages y sus maintainers como entities indexables:
- Search por keyword → returns matching packages
- Each package → list of maintainers (the "people")
- Each maintainer → profile (username, email, packages they maintain, download counts)

## Non-goals

- **No es coverage completo de npm.** Solo packages con keyword match. No scrapeamos todo el registry.
- **No es solo "packages"**. El foco es **los maintainers**, no los packages. Los packages son el medio para encontrar maintainers.
- **No es npm Enterprise / private packages.** Solo el registry público.
- **No es score por downloads.** Downloads ≠ quality, especialmente para libs pequeñas.

## API summary

- **Base URL**: `https://registry.npmjs.org/` (CouchDB-style) y `https://api.npms.io/` (búsqueda)
- **Auth**: not required for read
- **Endpoints clave**:
  - `GET https://api.npms.io/v2/search?q=rust&size=20` — search packages with score
  - `GET https://registry.npmjs.org/{package}` — full package metadata (maintainers, versions, time)
  - `GET https://api.npmjs.org/downloads/point/last-week/{package}` — weekly download count
- **Rate limit**: no documented limit on the registry; npms.io has informal limits
- **Docs**: https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md

## Data shape

Two entity types in one source:

**Package** (kind: 'repo' for now, could be 'package' later):
```ts
{
  id: `npm-${package.name}`,
  kind: 'repo',
  source: 'npm',
  sourceId: package.name,
  username: package.name,
  displayName: package.name,
  bio: package.description,
  profileUrl: `https://www.npmjs.com/package/${package.name}`,
  followersCount: package.weeklyDownloads,  // proxy for "popularity"
  topics: package.keywords,
  metadata: {
    version: package.version,
    license: package.license,
    maintainers: package.maintainers.map(m => m.name),
    weeklyDownloads: package.weeklyDownloads,
  }
}
```

**Maintainer** (kind: 'person'):
```ts
{
  id: `npm-user-${username}`,
  kind: 'person',
  source: 'npm',
  sourceId: username,
  username,
  displayName: maintainer.name || username,
  bio: `Maintains ${packages.length} npm package${packages.length === 1 ? '' : 's'}: ${packages.slice(0, 5).join(', ')}${packages.length > 5 ? '…' : ''}`,
  profileUrl: `https://www.npmjs.com/~${username}`,
  followersCount: undefined,  // not exposed
  topics: packages.flatMap(p => p.keywords).slice(0, 10),
  metadata: {
    email: maintainer.email,
    packageCount: packages.length,
    packages: packages.slice(0, 20),
  }
}
```

> **Important**: The npm registry exposes maintainer **emails** publicly (in the package metadata). This is opt-out by package authors but default-on. We can use this for cross-source dedup later.

## User stories

1. **Como usuario**, busco "graphql" y veo a los maintainers de los packages populares de GraphQL (`graphql`, `apollo-server`, `urql`, etc.).
2. **Como usuario**, busco "react state" y veo a los maintainers de las librerías de state management.
3. **Como usuario**, en `/search`, toggle "npm" en los sources.

## Success metrics

- **Primary**: % of JS/TS-related saved searches that have ≥ 1 npm result. Target: 60% (npm is huge for JS).
- **Secondary**: CTR on npm results is within 30% of GitHub. The data is different (maintainers not PR contributors) but should be valuable.

## Open questions

- **Email display**: We have maintainer emails. Do we show them on profile pages? **No, never** (privacy / ToS). Only use for dedup internally.
- **Score**: how to rank maintainers? Number of packages, total weekly downloads of their packages, recency of last publish. Use a similar recency-weighted approach as GitHub.
- **"Old" packages**: a package last published 5 years ago — show or not? Default: only show if `last_published > 2 years ago` filter, or rank them lower.

## Out of scope (this iteration)

- PyPI, RubyGems, crates.io (separate feature, similar pattern)
- npm Enterprise / org accounts
- Package security audit data
- Dependents graph
