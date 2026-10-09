CREATE TABLE "personal_passwords" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text DEFAULT 'login' NOT NULL,
	"name" text NOT NULL,
	"username" text DEFAULT '' NOT NULL,
	"url" text DEFAULT '' NOT NULL,
	"secret" text NOT NULL,
	"notes" text,
	"totp" text,
	"strength" integer,
	"favorite" boolean DEFAULT false NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_passwords_kind_check" CHECK ("personal_passwords"."kind" in ('login','note'))
);
--> statement-breakpoint
ALTER TABLE "personal_passwords" ADD CONSTRAINT "personal_passwords_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_passwords" ADD CONSTRAINT "personal_passwords_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "personal_passwords_user" ON "personal_passwords" USING btree ("user_id");