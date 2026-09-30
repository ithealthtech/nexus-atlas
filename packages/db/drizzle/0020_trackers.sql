CREATE TABLE "tracker_checks" (
	"org_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"host" text NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"ok" boolean NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	CONSTRAINT "tracker_checks_asset_id_kind_pk" PRIMARY KEY("asset_id","kind"),
	CONSTRAINT "tracker_checks_kind_check" CHECK ("tracker_checks"."kind" in ('domain','ssl'))
);
--> statement-breakpoint
ALTER TABLE "tracker_checks" ADD CONSTRAINT "tracker_checks_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracker_checks" ADD CONSTRAINT "tracker_checks_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracker_checks" ADD CONSTRAINT "tracker_checks_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tracker_checks_due" ON "tracker_checks" USING btree ("org_id","kind","checked_at");