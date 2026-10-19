CREATE TABLE "licenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"name" text NOT NULL,
	"vendor" text DEFAULT '' NOT NULL,
	"seats" integer NOT NULL,
	"assignments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"unit_cost_cents" integer DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"billing_cycle" text DEFAULT 'monthly' NOT NULL,
	"renewal_date" date,
	"auto_renew" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "licenses_seats_check" CHECK ("licenses"."seats" > 0 and jsonb_array_length("licenses"."assignments") <= "licenses"."seats"),
	CONSTRAINT "licenses_cost_check" CHECK ("licenses"."unit_cost_cents" >= 0),
	CONSTRAINT "licenses_status_check" CHECK ("licenses"."status" in ('active', 'cancelled')),
	CONSTRAINT "licenses_cycle_check" CHECK ("licenses"."billing_cycle" in ('monthly', 'annual', 'one_time'))
);
--> statement-breakpoint
ALTER TABLE "licenses" ADD CONSTRAINT "licenses_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "licenses" ADD CONSTRAINT "licenses_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "licenses_client_idx" ON "licenses" USING btree ("org_id","client_id");