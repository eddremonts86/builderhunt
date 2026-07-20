CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "builder_embeddings" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"source_id" text NOT NULL,
	"content_hash" text NOT NULL,
	"document" text NOT NULL,
	"profile" jsonb NOT NULL,
	"embedding" vector(768),
	"embedded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "builder_embeddings_source_unique" UNIQUE("source","source_id")
);
--> statement-breakpoint
CREATE INDEX "builder_embeddings_pending_idx" ON "builder_embeddings" USING btree ("embedded_at");
--> statement-breakpoint
CREATE INDEX "builder_embeddings_hnsw_idx" ON "builder_embeddings" USING hnsw ("embedding" vector_cosine_ops);
