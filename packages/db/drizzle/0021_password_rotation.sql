CREATE TABLE "rotation_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"client_id" uuid,
	"account_type" text NOT NULL,
	"interval_days" integer NOT NULL,
	"complexity" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rotation_policies_type_check" CHECK ("rotation_policies"."account_type" in ('local_admin','ad_service'))
);
--> statement-breakpoint
CREATE TABLE "rotation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"target_id" uuid,
	"password_id" uuid,
	"password_name" text NOT NULL,
	"asset_name" text NOT NULL,
	"status" text DEFAULT 'dispatched' NOT NULL,
	"token_hash" text NOT NULL,
	"complexity" jsonb NOT NULL,
	"candidate" text,
	"error" text DEFAULT '' NOT NULL,
	"started_by" uuid,
	"started_by_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "rotation_runs_status_check" CHECK ("rotation_runs"."status" in ('dispatched','candidate','succeeded','failed','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "rotation_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"password_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"account_type" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_rotated_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rotation_targets_type_check" CHECK ("rotation_targets"."account_type" in ('local_admin','ad_service'))
);
--> statement-breakpoint
ALTER TABLE "rotation_policies" ADD CONSTRAINT "rotation_policies_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_policies" ADD CONSTRAINT "rotation_policies_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_policies" ADD CONSTRAINT "rotation_policies_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_runs" ADD CONSTRAINT "rotation_runs_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_runs" ADD CONSTRAINT "rotation_runs_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_runs" ADD CONSTRAINT "rotation_runs_target_id_rotation_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."rotation_targets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_runs" ADD CONSTRAINT "rotation_runs_password_id_passwords_id_fk" FOREIGN KEY ("password_id") REFERENCES "public"."passwords"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_runs" ADD CONSTRAINT "rotation_runs_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_targets" ADD CONSTRAINT "rotation_targets_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_targets" ADD CONSTRAINT "rotation_targets_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_targets" ADD CONSTRAINT "rotation_targets_password_id_passwords_id_fk" FOREIGN KEY ("password_id") REFERENCES "public"."passwords"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_targets" ADD CONSTRAINT "rotation_targets_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotation_targets" ADD CONSTRAINT "rotation_targets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "rotation_policies_scope" ON "rotation_policies" USING btree ("org_id",coalesce("client_id"::text, ''),"account_type");--> statement-breakpoint
CREATE UNIQUE INDEX "rotation_runs_token" ON "rotation_runs" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "rotation_runs_org" ON "rotation_runs" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "rotation_runs_one_open" ON "rotation_runs" USING btree ("target_id") WHERE "rotation_runs"."status" in ('dispatched','candidate');--> statement-breakpoint
CREATE UNIQUE INDEX "rotation_targets_password" ON "rotation_targets" USING btree ("password_id");--> statement-breakpoint
CREATE INDEX "rotation_targets_client" ON "rotation_targets" USING btree ("org_id","client_id");