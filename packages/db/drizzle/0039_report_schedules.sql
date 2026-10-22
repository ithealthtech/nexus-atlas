CREATE TABLE "report_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"definition" jsonb NOT NULL,
	"cadence" text NOT NULL,
	"day" integer NOT NULL,
	"hour" integer NOT NULL,
	"recipients" jsonb NOT NULL,
	"attach_pdf" boolean DEFAULT true NOT NULL,
	"client_link" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_status" text,
	"last_error" text DEFAULT '' NOT NULL,
	"last_run_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_schedules_cadence_check" CHECK ("report_schedules"."cadence" in ('weekly','monthly','quarterly'))
);
--> statement-breakpoint
ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_last_run_id_report_runs_id_fk" FOREIGN KEY ("last_run_id") REFERENCES "public"."report_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_schedules_owner" ON "report_schedules" USING btree ("org_id","owner_id");--> statement-breakpoint
CREATE INDEX "report_schedules_due" ON "report_schedules" USING btree ("enabled","next_run_at");--> statement-breakpoint
-- Deleting a client also removes the schedules that report on it, along with its snapshots and templates, on every
-- deletion path (merges and organization erasure included).
CREATE OR REPLACE FUNCTION public.atlas_purge_client_reports() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM public.report_runs AS r
    WHERE r.org_id = OLD.org_id AND EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(r.client_ids) AS ref(id) WHERE lower(ref.id) = OLD.id::text
    );
  DELETE FROM public.report_templates AS t
    WHERE t.org_id = OLD.org_id AND EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(t.definition->'clientIds') AS ref(id) WHERE lower(ref.id) = OLD.id::text
    );
  DELETE FROM public.report_schedules AS s
    WHERE s.org_id = OLD.org_id AND EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(s.definition->'clientIds') AS ref(id) WHERE lower(ref.id) = OLD.id::text
    );
  RETURN OLD;
END;
$$;
