ALTER TABLE "sourcing_sprints" ADD COLUMN "include_self_managed" boolean;--> statement-breakpoint

-- The per-surface half of the inclusion policy (plan: phase-2/07-perfiles-autogestionados).
--
-- Nullable, and `null` is the sprint saying nothing rather than saying no: the organiser's own
-- standing preference decides then, and only an explicit `false` here narrows this one shortlist.
-- That precedence is the spec's — "el toggle global solo se aplica si el toggle por superficie no
-- está definido" — and it is why the two levels cannot share one tri-state column.
--
-- A column rather than a key in `variants`: the choice belongs to the sprint, not to one query
-- variant, and a value buried in jsonb is one no report can group by.
