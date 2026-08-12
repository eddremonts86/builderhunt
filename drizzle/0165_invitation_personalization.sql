ALTER TABLE "organization_invitations" ADD COLUMN "invitation_intent" text;--> statement-breakpoint
ALTER TABLE "organization_invitations" ADD COLUMN "invitee_role_title" text;--> statement-breakpoint

-- Defence in depth, not a substitute for the Zod parse at the route boundary.
--
-- `invitation-personalization.ts` normalizes every write, and these say the same thing to anything
-- that reaches the table another way: a future admin script, a repair query, a backfill written in a
-- hurry. Both columns stay NULLABLE, because every invitation created before this migration has NULL
-- here and the read path normalizes that to the `other` intent — a backfill would have to invent a
-- sender's reason.
ALTER TABLE "organization_invitations"
  ADD CONSTRAINT "organization_invitations_invitation_intent_check"
  CHECK (
    "invitation_intent" IS NULL
    OR "invitation_intent" IN ('hiring', 'investing', 'building', 'other')
  );--> statement-breakpoint

-- `btrim` equality is the interesting half. Length alone would accept "   " as a 3-character title,
-- and a title that is only whitespace renders as an empty line the recipient cannot account for —
-- so the constraint requires the stored value to already be trimmed, which makes an untrimmed write
-- an error rather than a silently ugly card. `char_length` counts characters, not bytes: an emoji or
-- an accented name must not cost a caller part of their 120.
ALTER TABLE "organization_invitations"
  ADD CONSTRAINT "organization_invitations_invitee_role_title_check"
  CHECK (
    "invitee_role_title" IS NULL
    OR (
      "invitee_role_title" = btrim("invitee_role_title")
      AND char_length("invitee_role_title") BETWEEN 1 AND 120
    )
  );
