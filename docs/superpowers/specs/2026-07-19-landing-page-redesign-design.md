# Landing Page Redesign Specification

Document the design proposal and architectural changes to convert standard landing page sections into premium, interactive components.

## 1. Goal

Redesign the five main areas of the BuilderHunt landing page identified in the layout critique to achieve a premium, interactive, and warm-light aesthetic. This redesign focuses on frontend presentation, animation, and responsive layout enhancements without changing any core logic or database interactions.

---

## 2. Proposed Changes

### Area 1: Social Proof & Source Integration
- **Current State:** A static white bar containing simple text statistics.
- **Redesign:** A continuous, hardware-accelerated horizontal auto-scrolling marquee (`infinite scroll`).
  - **Content:** The marquee will display custom cards for the four platforms (GitHub, Reddit, Hacker News, DEV.to).
  - **Interactivity:** On hover, the marquee pauses, and individual cards display native brand color glow borders and scale slightly.
  - **Aesthetics:** The badges are styled using the Tailwind theme colors with sub-pixel alignment and clean SVG icons.

### Area 2: Three Steps Timeline ("How It Works")
- **Current State:** Three standard columns with static text cards.
- **Redesign:** A connected chronological timeline flow.
  - **Timeline Line:** A dashed gradient SVG line connecting steps `01`, `02`, and `03` that lights up as the user scrolls.
  - **Card Preview Panel:** Inside each card, add a interactive simplified preview of the product matching the step:
    - **Step 1:** A clean mock input search field with simulated typing/keyword badges.
    - **Step 2:** A mock developer profile card with stats and a score indicator.
    - **Step 3:** A dashboard action bar with buttons like "Export CSV" and "Add Alerts" with micro-animations.
  - **Visuals:** Large terracotta numbers (`01`, `02`, `03`) using a display serif/sans-serif font.

### Area 3: Features Grid ("Built for Builders")
- **Current State:** Standard 3x2 grid of identical feature cards.
- **Redesign:** A dynamic Bento Grid layout.
  - **Bento Grid:** Two key features ("Recency-weighted scoring" and "Multi-source discovery") span multiple tracks (`md:col-span-2`), while others occupy single slots.
  - **Rich Previews:**
    - **Recency-weighted scoring:** Add an inline SVG line chart simulating score decay over time (half-life decay representation).
    - **Multi-source discovery:** Add a stylized cluster of brand icons connecting to a single central builder profile avatar.
  - **Interactivity:** Apply custom border-glow tracking gradients using CSS custom properties (`--mouse-x` / `--mouse-y`) or radial masks on hover, along with smooth lift translation.

### Area 4: Use Cases / Personas Selector ("Who It's For")
- **Current State:** A 2x2 grid of text-heavy cards showing "Pain" and "How we help".
- **Redesign:** An interactive tabbed/split panel layout.
  - **Tabs:** Horizontal tabs to select the target Persona ("Open-source Maintainers", "Founders Sourcing Hires", "Recruiters & Talent Partners", "DevRel & Community Teams").
  - **Split Panel:**
    - **Left Side:** Clean typography describing the challenge and how BuilderHunt solves it.
    - **Right Side:** A mock interactive visual demonstrating the specific solution (e.g. contributor shortlist, notification log, candidate dashboard).

### Area 5: Premium Footer
- **Current State:** A standard gray link column layout.
- **Redesign:** Modernized footer.
  - **Newsletter Subscription:** Incorporate a newsletter signup form with a glassmorphic blurred backdrop, a terracotta accent focus border, and a responsive submit button.
  - **Visual Hierarchy:** Reposition links, improve whitespace, and add fine-grained hover states (sliding line underlines or color transitions).

---

## 3. Style Sheets and Design Tokens

We will append the following utilities and animations to `src/shared/styles/globals.css`:
- `@keyframes scroll-marquee` for the social proof bar.
- Tailwind v4 theme extensions for custom borders, transitions, and hover-glow effects.
- Custom background grids and serif/display font styles matching the "Warm, premium, ordered" brand personality.

---

## 4. Verification Plan

1. **Development Server:** Run `pnpm dev` locally to review the modified landing page.
2. **Visual Verification:** Manually test responsiveness on multiple viewport widths (Mobile, Tablet, Desktop) and check that animations are hardware-accelerated.
3. **Accessibility (WCAG AA):** Ensure contrast ratios remain above 4.5:1 on text elements and ensure screen reader tags are present for all SVGs and tickers.
