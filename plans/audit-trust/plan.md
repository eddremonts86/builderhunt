# Plan: Trust & Security Enhancements

## Goal recap

Implement pricing transparency comparison grids, detail a security modal for GitHub Personal Access Tokens, establish a profile removal opt-out pipeline, and re-write over-promising copy elements on the landing page.

## Why this is a valuable addition

1. **Resolves Frictional Blockers**: Developers are highly sensitive to security. Explaining token encryption and scoping rules removes the main reason they abandon the registration flow.
2. **Legal & Compliance Readiness**: Having a verified automated opt-out / de-indexing route prevents GDPR complaints and privacy threats.
3. **Professional Appeal**: Polishing copy to sound analytical rather than hyperbolic matches the serious tone expected by enterprise tech leads.

## Phases

### Phase 1: Database Setup
- Add a boolean column `isDeindexed` to the `builders` table schema:
  ```sql
  ALTER TABLE builders ADD COLUMN is_deindexed BOOLEAN DEFAULT FALSE NOT NULL;
  ```
- Update schemas in `src/shared/lib/db/schema.ts`. Modify query routines inside `src/lib/search.ts` to exclude de-indexed builders (`where(eq(builders.isDeindexed, false))`).

### Phase 2: Landing Copy Updates & Pricing Component
- Edit H1 headlines and body paragraphs in `src/routes/_landing/index.tsx`.
- Create `src/modules/landing/components/PricingTable.tsx` implementing the table design. Mount it inside the landing layout section.

### Phase 3: Token Security Modal
- Create `src/modules/landing/components/TokenSecurityModal.tsx`.
- Bind the modal trigger to a help icon placed next to the GitHub Token input element in the search/settings panels.

### Phase 4: Opt-Out Route
- Create route `src/routes/privacy/remove.tsx` and its page container.
- Implement server function `requestDeindexing({ emailOrProfileUrl })`:
  - Validate parameters.
  - Send email verification token.
- Implement server function `confirmDeindexing({ token })`:
  - Flag builder record as `isDeindexed = true` and erase their details (bio, name, avatar) from the DB row to ensure complete removal compliance.

### Phase 5: Verification & Safety
- Verify that opt-out deletion requests erase personal information.
- Write tests confirming de-indexed profiles are never returned by keyword search pipelines.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **Spam removal requests** | Medium | Medium | Require email validation (sending verification links to their platform emails, or verifying GitHub OAuth claims) before deleting database profiles. |
| **Ambiguous pricing friction** | Low | Low | Make it clear that all core features remain completely free during the public beta phase. |

## Rollback plan

- Changes are cosmetic and route-isolated. The de-indexing column can remain active in the database even if the removal form is hidden from the UI.
