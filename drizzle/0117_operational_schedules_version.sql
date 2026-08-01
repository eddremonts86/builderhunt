-- Custom SQL migration file, put your code below! --
ALTER TABLE "operational_schedules" ADD COLUMN "version" integer NOT NULL DEFAULT 1;
