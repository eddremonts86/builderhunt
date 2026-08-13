# Plan — adopt the canonical table visual system

> **Status**: `implemented`
> **Depends on**: [`13-pagination-ci-gates`](../../../implemented/phase-3/13-pagination-ci-gates/spec.md)
> **Blocks**: nothing
> **Reality check**: the behavioral shell, surface registry, accessibility tests and screenshot harness already exist. The implementation should concentrate change in `src/shared/components/table/` and `src/shared/styles/globals.css`, then migrate the five visible raw tables.

## Delivery sequence

1. **Freeze the current inventory and reference contract.** Extend the table-surface report from a
   file count to an instance-aware manifest, distinguishing interactive grids, visible semantic
   tables, screen-reader equivalents and non-app email markup.
2. **Land table tokens before component changes.** Add the complete `--tbl-*` contract to the light
   theme, semantic dark overrides, typography, geometry, density and interaction utilities. No
   surface receives literal colors or dimensions.
3. **Type the cell vocabulary and column widths.** Extend `ColumnDef` with cell kind and explicit
   width policy, then make `gridTemplateColumns` derive the fixed/flexible layout from it. Preserve a
   temporary compatibility default while each surface is classified.
4. **Restyle the shared shell.** Apply the canonical container, 58px toolbar, 34px sticky header,
   inherited density, row variants, 44px footer and floating selection bar across all renderers.
5. **Make the nine cell kinds reusable.** Add small presentation primitives for primary, status,
   date, numeric, ratio, identity, empty and actions; category remains canonical plain text. Migrate
   surface column definitions in coherent groups rather than adding local JSX variants.
6. **Bring semantic tables onto the same system.** Add `SemanticTable`, then migrate cookies,
   pricing, conversion metrics and hygiene. Keep `BarSeries` screen-reader-only and email markup
   explicitly exempt.
7. **Lock coverage and visual behavior.** Add structural assertions, instance-aware inventory,
   desktop/mobile light/dark screenshots and manual route evidence. Update the visual-system docs
   only after the code and baselines agree.

## Adoption waves

| Wave | Surfaces | Reason |
| --- | --- | --- |
| Shell proof | Operations, integrations, sprint results | Existing visual baselines plus wide, multi-column data exercise sticky/header/scroll behavior |
| Admin grids | Users, incidents, abuse, refunds, disputes, blog, roadmap, changelog | Highest density of statuses, dates, numbers and actions |
| Tenant grids | Alerts, sprints, members/invitations, sessions, privacy | Confirms shared-schema rows, bounded tables and empty states |
| Specialized renderers | Search, grouped, stacked and board modes | Confirms the tokens do not assume only the default table renderer |
| Semantic tables | Pricing, cookies, conversion, hygiene | Removes the last visible local table styling without introducing grid behavior |

## Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Fixed widths create page overflow on mobile | High | High | Overflow belongs to the table scroller; assert the document width never exceeds the viewport at 375px |
| New 44/52/64px density breaks virtualization math | Medium | High | Keep one source of row-height truth and test virtual offsets/focus pinning for each density |
| Native-table guidance conflicts with the existing ARIA grid | High | Medium | Preserve the tested grid for interactive/virtualized data and use native markup only in `SemanticTable`; document the equivalence |
| Reference light colors fail in dark mode | High | High | Treat `--tbl-*` as semantic roles with `.dark` overrides and automated contrast checks |
| Migrating every column at once makes regressions hard to locate | Medium | Medium | Land shell compatibility first, then migrate surface groups with targeted screenshots |
| Footer pagination conflicts with infinite-scroll surfaces | Medium | Medium | Footer supports count-only, cursor actions or hidden mode; it never introduces page-number pagination |
| The table gate counts files rather than actual instances | High | Medium | Upgrade it to record every `<DataTable>` and visible `<table>` instance, including multiple instances in one file |

## Rollback

The rollout is token- and primitive-based. Keep the existing `DataTable` public query/pagination API
stable, so reverting the visual token block and shell classes restores the prior appearance without
touching data behavior. Raw-table migrations can be reverted per surface. Do not roll back the
instance-aware inventory or accessibility assertions; they are correctness improvements independent
of the chosen palette.

