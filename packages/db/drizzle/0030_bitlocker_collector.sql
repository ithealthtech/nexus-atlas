CREATE TABLE "bitlocker_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"hostname" text NOT NULL,
	"os" text DEFAULT '' NOT NULL,
	"serial_number" text DEFAULT '' NOT NULL,
	"asset_id" uuid,
	"volumes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"collected_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"blocked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bitlocker_enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"name" text NOT NULL,
	"scope" text DEFAULT 'client' NOT NULL,
	"token_hash" text NOT NULL,
	"public_key" text NOT NULL,
	"private_key" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bitlocker_enrollments_scope_check" CHECK ("bitlocker_enrollments"."scope" in ('client','device'))
);
--> statement-breakpoint
CREATE TABLE "bitlocker_reports" (
	"enrollment_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bitlocker_reports_enrollment_id_report_id_pk" PRIMARY KEY("enrollment_id","report_id")
);
--> statement-breakpoint
ALTER TABLE "bitlocker_devices" ADD CONSTRAINT "bitlocker_devices_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bitlocker_devices" ADD CONSTRAINT "bitlocker_devices_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bitlocker_devices" ADD CONSTRAINT "bitlocker_devices_enrollment_id_bitlocker_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."bitlocker_enrollments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bitlocker_devices" ADD CONSTRAINT "bitlocker_devices_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bitlocker_enrollments" ADD CONSTRAINT "bitlocker_enrollments_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bitlocker_enrollments" ADD CONSTRAINT "bitlocker_enrollments_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bitlocker_enrollments" ADD CONSTRAINT "bitlocker_enrollments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bitlocker_reports" ADD CONSTRAINT "bitlocker_reports_enrollment_id_bitlocker_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."bitlocker_enrollments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bitlocker_devices_machine" ON "bitlocker_devices" USING btree ("enrollment_id","machine_id");--> statement-breakpoint
CREATE INDEX "bitlocker_devices_client" ON "bitlocker_devices" USING btree ("org_id","client_id");--> statement-breakpoint
CREATE INDEX "bitlocker_devices_asset" ON "bitlocker_devices" USING btree ("asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bitlocker_enrollments_token" ON "bitlocker_enrollments" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "bitlocker_enrollments_client" ON "bitlocker_enrollments" USING btree ("org_id","client_id");