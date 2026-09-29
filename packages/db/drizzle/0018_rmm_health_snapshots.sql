CREATE TABLE "rmm_health_snapshots" (
	"org_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"day" date NOT NULL,
	"counts" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rmm_health_snapshots_org_id_client_id_day_pk" PRIMARY KEY("org_id","client_id","day")
);
--> statement-breakpoint
ALTER TABLE "rmm_health_snapshots" ADD CONSTRAINT "rmm_health_snapshots_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rmm_health_snapshots" ADD CONSTRAINT "rmm_health_snapshots_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rmm_health_snapshots_day" ON "rmm_health_snapshots" USING btree ("org_id","day");