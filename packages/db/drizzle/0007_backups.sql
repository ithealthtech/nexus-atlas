CREATE TABLE "backup_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"file_name" text,
	"size" bigint,
	"rows" integer,
	"files" integer,
	"error" text,
	"started_by_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "backup_runs_trigger_check" CHECK ("backup_runs"."trigger" in ('schedule','manual')),
	CONSTRAINT "backup_runs_status_check" CHECK ("backup_runs"."status" in ('running','done','failed'))
);
--> statement-breakpoint
CREATE INDEX "backup_runs_created" ON "backup_runs" USING btree ("created_at");