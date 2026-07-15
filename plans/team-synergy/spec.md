# Feature: Co-founder & Team Synergy Matchmaking

## Problem

Building successful tech startups or winning hackathons requires balanced teams. However, sourcing platforms only evaluate candidates in isolation. 

Founders and developers have no way to assess:
1. If two developers' skill sets are complementarily distributed (e.g. avoiding two pure database experts without anyone to build the user interface).
2. If their development styles will cause friction (e.g. one developer who writes strict, heavily typed, fully tested code vs. an indie hacker who codes fast and deploys without tests).
3. If they share overlapping technology interests that allow them to collaborate smoothly.

## Goal

Provide a team-building compatibility algorithm ("Synergy Matchmaking"). Users can select two builders (or match their own claimed profile against a candidate) and compute:
- A compatibility percentage ("Synergy Score").
- A "Skill Distribution Matrix" displaying complementary skill sets (Design, Frontend, Backend, Systems, Databases).
- An AI-generated collaboration review detailing synergy highlights and potential friction points.

## Non-goals

- **No personality or psychological testing.** Sourcing evaluation is strictly technical, based on public code history, topics, and development habits.
- **No job recruiting match.** This is for builder-to-builder pairing, not candidate-to-company matching.

## User stories

1. **As a founder**, I want to select two developers in my saved shortlist and run a "Synergy Check" to see how they would work together.
2. **As a developer**, on my own dashboard, I want to search for potential co-founders and filter them by complementary skill scores.
3. **As a user**, I want to see a visual radar chart showing the distribution of skills between the two matched developers.

## Technical architecture

### 1. Synergy API Engine
- Implement a server endpoint `POST /api/matchmaking/synergy` taking `builderId1` and `builderId2`.
- Load profiles and AI Enrichment records (strengths, primaryFocus, codingStyle) for both candidates.
- Pass profiles to the Gemini API (`gemini-2.5-flash`) requesting a structured JSON response:
  ```json
  {
    "synergyScore": 87,
    "distribution": {
      "builder1": { "design": 20, "frontend": 30, "backend": 80, "database": 90, "devops": 60 },
      "builder2": { "design": 90, "frontend": 90, "backend": 40, "database": 30, "devops": 20 }
    },
    "complementaryAnalysis": "String (explaining how their skills lock together)",
    "frictionPoints": ["String", "String"],
    "synergyHighlights": ["String", "String"]
  }
  ```

### 2. Matching Metrics & Rules
- **Synergy Score Algorithm**: Combined baseline calculated from:
  - **Language overlap**: Sharing at least one common language (e.g. TypeScript or Python) to ensure they can share codebases (+20 pts).
  - **Complementary distribution**: High variance in primaryFocus (e.g., if Builder A is Frontend and Builder B is Backend, +40 pts).
  - **Habits alignment**: Compatibility of codingStyle (e.g., if one is TDD-strict and the other is MVP-fast, outline as friction but score based on complementary speed, +20 pts).
  - **Topic alignment**: Shared interest in target domains (e.g. both interested in "AI agents" or "Web3", +20 pts).

## UX integration

- Create a `/match` route in `src/routes/_dashboard/match/index.tsx`.
- **Side-by-Side Selector**: Split screen layout displaying both builder cards.
- **Skill Radar Chart**: Render a double-colored radar chart using SVG or a lightweight charting utility showing the overlapping skills distribution (e.g. builder A in blue, builder B in gold).
- **Synergy Dossier Card**: Elegant bento grid showing:
  - Main score badge with circular animation.
  - Symmetrical columns for "Why it works" and "Collaboration Risks".

## Success metrics

- **Product Differentiation**: BuilderHunt becomes the go-to platform for co-founder searches and hackathon team formations, distinct from simple candidate lists.
- **User Retention**: Daily active users of the `/match` feature save 40% more candidate pairings than standard search pages.
