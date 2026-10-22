CREATE TABLE "client_health" (
	"org_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"day" date NOT NULL,
	"score" integer,
	"parts" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_health_org_id_client_id_day_pk" PRIMARY KEY("org_id","client_id","day")
);
--> statement-breakpoint
ALTER TABLE "client_health" ADD CONSTRAINT "client_health_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_health" ADD CONSTRAINT "client_health_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "client_health_day" ON "client_health" USING btree ("org_id","day");