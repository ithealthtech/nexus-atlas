CREATE TABLE "reported_infections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"source" text NOT NULL,
	"event_id" text NOT NULL,
	"status" text NOT NULL,
	"reported_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reported_infections_status" CHECK ("reported_infections"."status" in ('active','resolved'))
);
--> statement-breakpoint
ALTER TABLE "reported_infections" ADD CONSTRAINT "reported_infections_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reported_infections" ADD CONSTRAINT "reported_infections_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reported_infections" ADD CONSTRAINT "reported_infections_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reported_infections_once" ON "reported_infections" USING btree ("org_id","client_id","asset_id","source","event_id");