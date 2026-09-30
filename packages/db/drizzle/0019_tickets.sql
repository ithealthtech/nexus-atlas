CREATE TABLE "tickets" (
	"org_id" uuid NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"client_id" uuid NOT NULL,
	"company_id" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"status" text DEFAULT '' NOT NULL,
	"closed" boolean DEFAULT false NOT NULL,
	"number" text DEFAULT '' NOT NULL,
	"priority" text DEFAULT '' NOT NULL,
	"opened_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"remote_updated_at" timestamp with time zone,
	"url" text,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tickets_org_id_source_external_id_pk" PRIMARY KEY("org_id","source","external_id")
);
--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tickets_client" ON "tickets" USING btree ("org_id","client_id");