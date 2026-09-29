CREATE TABLE "rmm_device_status" (
	"org_id" uuid NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"client_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"online" boolean,
	"last_seen_at" timestamp with time zone,
	"protection" text,
	"protection_product" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rmm_device_status_org_id_source_external_id_pk" PRIMARY KEY("org_id","source","external_id"),
	CONSTRAINT "rmm_device_status_kind_check" CHECK ("rmm_device_status"."kind" in ('server','workstation','other')),
	CONSTRAINT "rmm_device_status_protection_check" CHECK ("rmm_device_status"."protection" is null or "rmm_device_status"."protection" in ('running','not_running','missing'))
);
--> statement-breakpoint
ALTER TABLE "rmm_device_status" ADD CONSTRAINT "rmm_device_status_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rmm_device_status" ADD CONSTRAINT "rmm_device_status_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rmm_device_status" ADD CONSTRAINT "rmm_device_status_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rmm_device_status_client" ON "rmm_device_status" USING btree ("org_id","client_id");