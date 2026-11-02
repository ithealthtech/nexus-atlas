CREATE TABLE "alert_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"version" integer,
	"rule_id" text NOT NULL,
	"rule_name" text NOT NULL,
	"kind" text NOT NULL,
	"test" boolean DEFAULT false NOT NULL,
	"client_id" uuid,
	"item_name" text NOT NULL,
	"event_key" text NOT NULL,
	"reason" text NOT NULL,
	"channel" text NOT NULL,
	"destination" text NOT NULL,
	"destination_label" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"teams_format" text DEFAULT 'text' NOT NULL,
	"link" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text DEFAULT '' NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_deliveries_status" CHECK ("alert_deliveries"."status" in ('pending','sending','sent','failed','uncertain','skipped')),
	CONSTRAINT "alert_deliveries_channel" CHECK ("alert_deliveries"."channel" in ('email','teams'))
);
--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alert_deliveries_once" ON "alert_deliveries" USING btree ("org_id","rule_id","event_key","channel","destination");--> statement-breakpoint
CREATE INDEX "alert_deliveries_due" ON "alert_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "alert_deliveries_org" ON "alert_deliveries" USING btree ("org_id","created_at");