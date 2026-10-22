CREATE TABLE "bitdefender_endpoints" (
	"org_id" uuid NOT NULL,
	"endpoint_id" text NOT NULL,
	"company_id" text NOT NULL,
	"client_id" uuid NOT NULL,
	"asset_id" uuid,
	"name" text NOT NULL,
	"os" text DEFAULT '' NOT NULL,
	"ip" text DEFAULT '' NOT NULL,
	"macs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"online" boolean,
	"last_seen_at" timestamp with time zone,
	"infected" boolean DEFAULT false NOT NULL,
	"detection" boolean DEFAULT false NOT NULL,
	"signatures_outdated" boolean,
	"product_outdated" boolean,
	"licence" text DEFAULT 'unknown' NOT NULL,
	"policy_name" text DEFAULT '' NOT NULL,
	"policy_applied" boolean,
	"isolated" boolean DEFAULT false NOT NULL,
	"risk_score" integer,
	"risk_impact" text DEFAULT '' NOT NULL,
	"modules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"product_version" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bitdefender_endpoints_org_id_endpoint_id_pk" PRIMARY KEY("org_id","endpoint_id"),
	CONSTRAINT "bitdefender_endpoints_licence_check" CHECK ("bitdefender_endpoints"."licence" in ('active','expired','pending','none','unknown'))
);
--> statement-breakpoint
ALTER TABLE "bitdefender_endpoints" ADD CONSTRAINT "bitdefender_endpoints_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bitdefender_endpoints" ADD CONSTRAINT "bitdefender_endpoints_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bitdefender_endpoints" ADD CONSTRAINT "bitdefender_endpoints_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bitdefender_endpoints_client" ON "bitdefender_endpoints" USING btree ("org_id","client_id");--> statement-breakpoint
CREATE INDEX "bitdefender_endpoints_asset" ON "bitdefender_endpoints" USING btree ("asset_id");