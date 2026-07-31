-- Wave 2 (plans/UI/tasks.md) "Shortlist metadata and visibility editing" — optimistic
-- concurrency for the rename/description/visibility PATCH. Existing rows default to
-- version 1, matching a freshly created list that has never been edited.
ALTER TABLE "builder_lists" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;
