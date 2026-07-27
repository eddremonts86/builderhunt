CREATE TABLE "public_surface_indexing" (
	"surface" text PRIMARY KEY NOT NULL,
	"noindex" boolean DEFAULT true NOT NULL,
	"nofollow" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
