CREATE TABLE "discovery_state" (
	"id" text PRIMARY KEY NOT NULL,
	"cursor" integer DEFAULT 0 NOT NULL,
	"last_cell_key" text,
	"last_run_at" timestamp with time zone,
	"stats" jsonb DEFAULT '{"runs":0,"upserted":0,"errors":0}'::jsonb NOT NULL
);
