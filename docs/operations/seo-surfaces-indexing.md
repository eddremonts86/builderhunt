# SEO surfaces — indexing state

## Decision (plan 45, 2026-07-30)

All three public SEO surfaces — `blog`, `changelog`, `roadmap` — are
launched with `index, follow` (the default in
`src/shared/lib/seo/surfaces.ts::DEFAULT_DIRECTIVES`).

| Surface    | `noindex` | `nofollow` | Rationale                                                                              |
| ---------- | --------- | ---------- | -------------------------------------------------------------------------------------- |
| `blog`     | `false`   | `false`    | `46-content-marketing` exists to earn organic traffic. `noindex` defeats the purpose. |
| `changelog`| `false`   | `false`    | Buyers, integrators and search engines expect the version history of a product to be findable. |
| `roadmap`  | `false`   | `false`    | The public roadmap is a commitment page. Hiding it removes the inbound signal that pulls evaluators in. |

## Operator runbook

The three surfaces are governed by one registry
(`src/shared/lib/seo/surfaces.ts::SEO_SURFACES`) and one database table
(`public_surface_indexing`). The registry is the source of truth for *which*
surfaces exist; the table is the source of truth for *what each one is doing
right now*. A platform admin can change the row from `/admin/content`.

The two must agree. Concretely:

- `src/shared/lib/seo/surfaces.ts::SEO_SURFACE_DEFINITIONS` lists the surfaces.
- The public head, `robots.txt` and `sitemap.xml` all read from that registry.
  A surface that is registered but has no row uses `DEFAULT_DIRECTIVES`.
- A row in `public_surface_indexing` overrides the default.

### Verifying a change

```bash
# The head tag is what crawlers actually see.
curl -s https://app.example.com/blog | grep -i 'name="robots"'

# robots.txt is the hint for compliant crawlers.
curl -s https://app.example.com/robots.txt
```

Both must agree. If they don't, one of them is reading from a stale row or
from a registry entry that is no longer in the database.

### When to override

The default is `index, follow` for a reason. Override only when:

- A post or changelog entry has content that must not be public (e.g. a
  security advisory that the team wants to publish on the site but not
  surface in search while the fix is rolling out). In that case, set
  `noindex=true` on the individual post (not the whole surface) — see
  `src/routes/_landing/blog/$slug.tsx::robotsMetaTag` for the per-post
  override.
- A legal review requires hiding the public roadmap. In that case, set
  `noindex=true, nofollow=true` on the `roadmap` row, not the constant.

### What NOT to do

- Do **not** change `DEFAULT_DIRECTIVES` to `noindex, nofollow` as a "safety
  default". The reasoning is in the constant's docstring: the surfaces in
  this registry are public marketing/product pages whose product-spec
  default is "indexable". A `noindex` default would silently defeat the
  purpose of `46-content-marketing` and the public roadmap feature — the
  failure is the absence of traffic, not a loud error.
- Do **not** add a new SEO surface by editing the registry without also
  adding a row in `public_surface_indexing` for it. The sync script
  (`scripts/db/sync-platform-content.ts`) does not own this table; a row
  appears on first write, and until then the default applies.
