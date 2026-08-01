-- Custom SQL migration file, put your code below! --
-- plans/phase-1/43-solutions-intelligence Phase 4, "Add catalog, graph, evidence, and source-policy
-- schema". Global-public throughout: no `organization_id` on any table here, because a catalog fact is
-- not a tenant's property. An organization's private opinion about a component stays in its own tables.

-- Needed for the no-overlapping-versions exclusion constraint below: GiST cannot index equality on a
-- text column without it.
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE "solution_sources" (
  "key" text PRIMARY KEY NOT NULL,
  "kind" text NOT NULL,
  "label" text NOT NULL,
  "homepage_url" text NOT NULL,
  -- THE KILL SWITCH. Every source ships disabled, including official APIs: enabling one is an explicit
  -- maintainer act, never a deploy side effect.
  "enabled" boolean DEFAULT false NOT NULL,
  "allowed_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "geography" text,
  "owner_contact" text,
  "rate_limit_per_hour" integer,
  "refresh_interval_hours" integer,
  "retention_days" integer,
  "terms_reviewed_at" timestamp with time zone,
  "terms_reviewed_by" text REFERENCES "auth_users"("id") ON DELETE SET NULL,
  "register_notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "solution_sources_kind_check"
    CHECK ("kind" IN ('official_api', 'feed', 'licensed_dataset', 'user_submission', 'public_scrape', 'external_link_only')),
  -- The legal gate as a constraint: a scraping source cannot be enabled until a human review is
  -- recorded. The admin toggle therefore physically cannot turn on a crawl nobody signed off. Other
  -- kinds are exempt — an official API's terms are accepted by holding a key.
  CONSTRAINT "solution_sources_scrape_needs_review_check"
    CHECK ("kind" <> 'public_scrape' OR "enabled" = false OR "terms_reviewed_at" IS NOT NULL),
  -- External-link-only means we store nothing fetched from it, only the outbound link.
  CONSTRAINT "solution_sources_link_only_stores_nothing_check"
    CHECK ("kind" <> 'external_link_only' OR jsonb_array_length("allowed_fields") = 0)
);
CREATE INDEX "solution_sources_enabled_idx" ON "solution_sources" ("enabled");

CREATE TABLE "solution_capabilities" (
  "key" text PRIMARY KEY NOT NULL,
  "label" text NOT NULL,
  "description" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "solution_components" (
  "id" text PRIMARY KEY NOT NULL,
  "kind" text NOT NULL,
  "slug" text NOT NULL,
  "display_name" text NOT NULL,
  "lifecycle_state" text DEFAULT 'draft' NOT NULL,
  "source_key" text NOT NULL REFERENCES "solution_sources"("key") ON DELETE RESTRICT,
  "external_id" text,
  "homepage_url" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "solution_components_kind_check"
    CHECK ("kind" IN ('human_profile', 'human_role', 'agent', 'model', 'model_endpoint', 'mcp_server', 'tool', 'service')),
  CONSTRAINT "solution_components_lifecycle_check"
    CHECK ("lifecycle_state" IN ('draft', 'active', 'deprecated', 'withdrawn'))
);
CREATE UNIQUE INDEX "solution_components_kind_slug_unique" ON "solution_components" ("kind", "slug");
-- One component per (source, external record), so a refresh updates rather than duplicates. Partial:
-- generic human roles are authored, not ingested, and carry no external id.
CREATE UNIQUE INDEX "solution_components_source_external_unique"
  ON "solution_components" ("source_key", "external_id") WHERE "external_id" IS NOT NULL;
CREATE INDEX "solution_components_kind_lifecycle_idx" ON "solution_components" ("kind", "lifecycle_state");

CREATE TABLE "solution_component_versions" (
  "component_id" text NOT NULL REFERENCES "solution_components"("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "metadata" jsonb NOT NULL,
  "content_hash" text NOT NULL,
  "observed_at" timestamp with time zone NOT NULL,
  "valid_from" timestamp with time zone DEFAULT now() NOT NULL,
  "valid_until" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "solution_component_versions_pkey" PRIMARY KEY ("component_id", "version"),
  CONSTRAINT "solution_component_versions_validity_order_check"
    CHECK ("valid_until" IS NULL OR "valid_until" > "valid_from")
);
-- An unchanged refresh must not mint a version — same content-hash discipline as
-- builder_source_snapshots, and the reason a daily re-ingest does not grow this table without bound.
CREATE UNIQUE INDEX "solution_component_versions_content_unique"
  ON "solution_component_versions" ("component_id", "content_hash");
CREATE INDEX "solution_component_versions_current_idx"
  ON "solution_component_versions" ("component_id", "valid_from");

-- "Reject overlapping invalid versions" (the plan's verify line). Two versions of the same component
-- must not both claim to be the truth at the same instant, or "what did we believe when that run
-- executed" has two answers. A CHECK cannot express this — it is a constraint between rows — so it is
-- an exclusion constraint over the validity range. An open-ended version (valid_until NULL) is
-- modelled as extending to infinity, which is what makes "two current versions" impossible.
ALTER TABLE "solution_component_versions"
  ADD CONSTRAINT "solution_component_versions_no_overlap"
  EXCLUDE USING gist (
    "component_id" WITH =,
    tstzrange("valid_from", COALESCE("valid_until", 'infinity'::timestamptz)) WITH &&
  );

CREATE TABLE "solution_evidence" (
  "id" text PRIMARY KEY NOT NULL,
  "source_key" text NOT NULL REFERENCES "solution_sources"("key") ON DELETE RESTRICT,
  "component_id" text REFERENCES "solution_components"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "source_url" text,
  "content_hash" text NOT NULL,
  "payload" jsonb NOT NULL,
  "observed_at" timestamp with time zone NOT NULL,
  "expires_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "solution_evidence_kind_check"
    CHECK ("kind" IN ('official_metadata', 'benchmark', 'documentation', 'production_report', 'manual_review')),
  CONSTRAINT "solution_evidence_expiry_order_check"
    CHECK ("expires_at" IS NULL OR "expires_at" > "observed_at")
);
CREATE UNIQUE INDEX "solution_evidence_source_hash_unique" ON "solution_evidence" ("source_key", "content_hash");
CREATE INDEX "solution_evidence_component_idx" ON "solution_evidence" ("component_id", "observed_at");

CREATE TABLE "solution_component_capabilities" (
  "id" text PRIMARY KEY NOT NULL,
  "component_id" text NOT NULL,
  "component_version" integer NOT NULL,
  "capability_key" text NOT NULL REFERENCES "solution_capabilities"("key") ON DELETE RESTRICT,
  "evidence_level" text NOT NULL,
  -- RESTRICT: a claim may never outlive the observation behind it. This is the "dangling evidence"
  -- the plan asks the schema to reject — a claim whose evidence was purged is indistinguishable from
  -- an unsupported assertion, and the UI would still render it as evidenced.
  "primary_evidence_id" text NOT NULL REFERENCES "solution_evidence"("id") ON DELETE RESTRICT,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "solution_component_capabilities_version_fk"
    FOREIGN KEY ("component_id", "component_version")
    REFERENCES "solution_component_versions"("component_id", "version") ON DELETE CASCADE,
  CONSTRAINT "solution_component_capabilities_level_check"
    CHECK ("evidence_level" IN ('claimed', 'observed', 'verified', 'production_evidence'))
);
CREATE UNIQUE INDEX "solution_component_capabilities_unique"
  ON "solution_component_capabilities" ("component_id", "component_version", "capability_key");
CREATE INDEX "solution_component_capabilities_capability_idx"
  ON "solution_component_capabilities" ("capability_key", "evidence_level");

CREATE TABLE "solution_compatibility_edges" (
  "id" text PRIMARY KEY NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "edge_type" text NOT NULL,
  "from_component_id" text NOT NULL REFERENCES "solution_components"("id") ON DELETE CASCADE,
  "to_component_id" text NOT NULL REFERENCES "solution_components"("id") ON DELETE CASCADE,
  "constraints" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "confidence_bps" integer DEFAULT 0 NOT NULL,
  "discovery_method" text NOT NULL,
  "status" text DEFAULT 'proposed' NOT NULL,
  "primary_evidence_id" text NOT NULL REFERENCES "solution_evidence"("id") ON DELETE RESTRICT,
  "reviewed_by_user_id" text REFERENCES "auth_users"("id") ON DELETE SET NULL,
  "reviewed_at" timestamp with time zone,
  "valid_from" timestamp with time zone DEFAULT now() NOT NULL,
  "valid_until" timestamp with time zone,
  "last_verified_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "solution_edges_type_check"
    CHECK ("edge_type" IN ('can_perform', 'requires', 'accepts_output_from', 'integrates_with', 'hosted_by', 'reviewed_by', 'incompatible_with', 'substitutes_for')),
  CONSTRAINT "solution_edges_discovery_check"
    CHECK ("discovery_method" IN ('manual_review', 'official_metadata', 'semantic_similarity_reviewed')),
  CONSTRAINT "solution_edges_status_check"
    CHECK ("status" IN ('proposed', 'active', 'rejected', 'expired')),
  CONSTRAINT "solution_edges_confidence_range_check" CHECK ("confidence_bps" BETWEEN 0 AND 10000),
  CONSTRAINT "solution_edges_no_self_loop_check" CHECK ("from_component_id" <> "to_component_id"),
  CONSTRAINT "solution_edges_validity_order_check"
    CHECK ("valid_until" IS NULL OR "valid_until" > "valid_from"),
  -- spec.md: "Semantic similarity can propose an edge for review but cannot activate it." The
  -- composer builds real advice out of active edges, so an unreviewed guess becoming active means
  -- telling someone to combine two things nobody checked work together. Same shape, and same reason,
  -- as human_source_links_probabilistic_needs_review_check.
  CONSTRAINT "solution_edges_similarity_needs_review_check"
    CHECK ("discovery_method" <> 'semantic_similarity_reviewed' OR "status" <> 'active' OR "reviewed_by_user_id" IS NOT NULL)
);
-- One live edge per (from, to, type). Partial, so rejected and withdrawn history never blocks a later
-- correct edge.
CREATE UNIQUE INDEX "solution_edges_active_unique"
  ON "solution_compatibility_edges" ("from_component_id", "to_component_id", "edge_type")
  WHERE "status" = 'active' AND "valid_until" IS NULL;
CREATE INDEX "solution_edges_traversal_idx"
  ON "solution_compatibility_edges" ("from_component_id", "edge_type", "status");
CREATE INDEX "solution_edges_review_queue_idx" ON "solution_compatibility_edges" ("status", "created_at");

-- Grants. The app role READS the catalog and writes none of it: ingesting a component, attaching
-- evidence or activating an edge are worker and reviewed-platform actions, never something a request
-- can do. Verified against information_schema rather than assumed — the lesson from 0123, where
-- builder_source_snapshots had no role grants at all and every write failed 42501.
GRANT SELECT ON TABLE "solution_sources" TO "builderhunt_app";
GRANT SELECT ON TABLE "solution_capabilities" TO "builderhunt_app";
GRANT SELECT ON TABLE "solution_components" TO "builderhunt_app";
GRANT SELECT ON TABLE "solution_component_versions" TO "builderhunt_app";
GRANT SELECT ON TABLE "solution_component_capabilities" TO "builderhunt_app";
GRANT SELECT ON TABLE "solution_evidence" TO "builderhunt_app";
GRANT SELECT ON TABLE "solution_compatibility_edges" TO "builderhunt_app";

-- The worker ingests: it may create components, versions, evidence and proposed edges. It may not
-- flip `enabled` on a source — that is the operator's switch, and a worker that could enable its own
-- data source would make the kill switch decorative.
GRANT SELECT ON TABLE "solution_sources" TO "builderhunt_worker";
GRANT SELECT, INSERT ON TABLE "solution_capabilities" TO "builderhunt_worker";
GRANT SELECT, INSERT, UPDATE ON TABLE "solution_components" TO "builderhunt_worker";
GRANT SELECT, INSERT ON TABLE "solution_component_versions" TO "builderhunt_worker";
GRANT SELECT, INSERT ON TABLE "solution_component_capabilities" TO "builderhunt_worker";
GRANT SELECT, INSERT ON TABLE "solution_evidence" TO "builderhunt_worker";
GRANT SELECT, INSERT, UPDATE ON TABLE "solution_compatibility_edges" TO "builderhunt_worker";

-- Platform admins own the source register (including the kill switch), the edge review queue, and
-- retention deletes.
GRANT SELECT, INSERT, UPDATE ON TABLE "solution_sources" TO "builderhunt_platform";
GRANT SELECT, INSERT, UPDATE ON TABLE "solution_capabilities" TO "builderhunt_platform";
GRANT SELECT, INSERT, UPDATE ON TABLE "solution_components" TO "builderhunt_platform";
GRANT SELECT, INSERT, DELETE ON TABLE "solution_component_versions" TO "builderhunt_platform";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "solution_component_capabilities" TO "builderhunt_platform";
GRANT SELECT, INSERT, DELETE ON TABLE "solution_evidence" TO "builderhunt_platform";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "solution_compatibility_edges" TO "builderhunt_platform";
