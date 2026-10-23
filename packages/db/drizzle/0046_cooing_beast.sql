CREATE TABLE "alert_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"draft_revision" bigint NOT NULL,
	"workspace" jsonb NOT NULL,
	"note" text NOT NULL,
	"published_by" text NOT NULL,
	"publisher_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_versions_positive_version" CHECK ("alert_versions"."version" > 0),
	CONSTRAINT "alert_versions_nonnegative_revision" CHECK ("alert_versions"."draft_revision" >= 0)
);
--> statement-breakpoint
ALTER TABLE "alert_versions" ADD CONSTRAINT "alert_versions_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_versions" ADD CONSTRAINT "alert_versions_publisher_id_users_id_fk" FOREIGN KEY ("publisher_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alert_versions_org_version" ON "alert_versions" USING btree ("org_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "alert_versions_org_revision" ON "alert_versions" USING btree ("org_id","draft_revision");