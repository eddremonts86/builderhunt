# Feature: Product Hunt Integration

## Problem

BuilderHunt tracks developer contributions to code repositories (GitHub, GitLab) and technical content (Dev.to, Hashnode). However, code activity is only one side of the coin. Many builders are tech creators who launch SaaS products, open-source tools, or utilities directly to communities. 

Without Product Hunt, we miss:
1. Product-minded developers who build, launch, and monetize software (indie hackers, solo founders).
2. The traction signals (upvotes, reviews, product tiering) of projects built by these developers.
3. Valuable context on whether a builder's project is a hobby codebase or a launched product with real users.

## Goal

Search and ingest builder profiles from Product Hunt. This is achieved by:
- Querying for products ("posts") that match search keywords.
- Extracting the "makers" (creators) of those products.
- Mapping their Product Hunt user profiles (karma, follower count, headline) to our developer schema.

## Non-goals

- **No product directories hosting.** We are not rebuilding Product Hunt; we only list the builder's profile and links to their launched products.
- **No social actions.** Users cannot upvote or review Product Hunt projects from BuilderHunt.

## User stories

1. **As a user**, when I search for "markdown editor", I want to see the creators of popular markdown editors launched on Product Hunt, along with their upvote counts.
2. **As a user**, I want to filter search results to only show makers from Product Hunt using the source pill.
3. **As a user**, in the builder detail view, I want to see a card displaying the products they have launched on Product Hunt, including the product name, tagline, upvote count, and launch date.

## API summary

- **Base Endpoint**: `https://api.producthunt.com/v2/api/graphql`
- **Auth**: Requires a Client Token / Developer Token passed as `Authorization: Bearer PRODUCTHUNT_TOKEN`.
- **Key GraphQL Queries**:
  - Search posts by term and fetch their makers:
    ```graphql
    query SearchMakers($query: String!) {
      posts(search: $query, first: 15) {
        nodes {
          name
          tagline
          votesCount
          url
          createdAt
          makers {
            id
            name
            username
            headline
            profileImage
            twitterUsername
            gitHubUsername
            websiteUrl
          }
        }
      }
    }
    ```
  - Fetch detailed user profile by username:
    ```graphql
    query GetUserProfile($username: String!) {
      user(username: $username) {
        id
        name
        username
        headline
        coverImage
        profileImage
        followers {
          totalCount
        }
        karma
        websiteUrl
        twitterUsername
        gitHubUsername
      }
    }
    ```

## Data shape

Reuses the `RawBuilder` structure with `source: 'producthunt'`:

```ts
export interface RawBuilder {
  id: string              // `ph-${userId}`
  kind: 'person'
  source: 'producthunt'
  sourceId: string        // Product Hunt User ID
  username: string        // handle/username
  displayName?: string    // name
  avatarUrl?: string      // profileImage
  bio?: string            // headline
  profileUrl: string      // `https://www.producthunt.com/@${username}`
  followersCount?: number // followers count from GraphQL query
  language?: string
  country?: string
  topics: string[]        // parsed from product tags
  metadata: {
    karma: number
    launchedProducts: Array<{
      name: string
      tagline: string
      votesCount: number
      url: string
      createdAt: string
    }>
    twitterUsername?: string
    gitHubUsername?: string
  }
}
```

## UX integration

- Add `producthunt` to the `Source` type.
- Add Product Hunt SVG Icon (custom "P" brand logo) to icons asset list.
- Color theme: Dark Orange/Red (`#da552f` / `rgb(218, 85, 47)`).
- Pill badge style: `.badge-producthunt`.

## Success metrics

- **Coverage**: Increase the representation of "indie hackers" and "solo founders" in tech queries by 20%.
- **Retention**: Active recruiters who filter by Product Hunt stay on profile views 15% longer due to the tangible product validation.

## Open questions

- **Rate Limit Constraints**: Product Hunt GraphQL API has a complexity-based rate limit system. How do we prevent running out of credits during high-concurrency searches?
  - *Recommendation*: Cache the resolved "makers" of posts aggressively (e.g. 1 hour) since product launch rosters do not change frequently.
- **Cross-linking profiles**: The API returns `gitHubUsername` and `twitterUsername` for makers. This allows automatic de-duplication at search time if the builder is also indexed via GitHub.
