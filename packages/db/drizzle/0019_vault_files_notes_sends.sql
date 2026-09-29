CREATE TABLE "sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"ciphertext" text,
	"storage_key" text,
	"size" bigint DEFAULT 0 NOT NULL,
	"max_views" integer NOT NULL,
	"views" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_by_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sends_kind_check" CHECK ("sends"."kind" in ('text','file'))
);
--> statement-breakpoint
ALTER TABLE "passwords" DROP CONSTRAINT "passwords_kind_check";--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "sealed_key" text;--> statement-breakpoint
ALTER TABLE "sends" ADD CONSTRAINT "sends_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sends" ADD CONSTRAINT "sends_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sends_token" ON "sends" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sends_creator" ON "sends" USING btree ("org_id","created_by","created_at");--> statement-breakpoint
ALTER TABLE "passwords" ADD CONSTRAINT "passwords_kind_check" CHECK ("passwords"."kind" in ('login','bitlocker','note'));