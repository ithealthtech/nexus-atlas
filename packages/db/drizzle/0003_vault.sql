CREATE TABLE "password_access" (
	"password_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "password_access_password_id_user_id_pk" PRIMARY KEY("password_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "password_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"password_id" uuid NOT NULL,
	"secret" text NOT NULL,
	"changed_by" uuid,
	"changed_by_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "passwords" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"kind" text DEFAULT 'login' NOT NULL,
	"name" text NOT NULL,
	"username" text DEFAULT '' NOT NULL,
	"url" text DEFAULT '' NOT NULL,
	"secret" text NOT NULL,
	"notes" text,
	"totp" text,
	"fingerprint" text NOT NULL,
	"strength" integer DEFAULT 0 NOT NULL,
	"rotation_days" integer,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"restricted" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "passwords_kind_check" CHECK ("passwords"."kind" in ('login','bitlocker'))
);
--> statement-breakpoint
CREATE TABLE "share_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"password_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"ciphertext" text NOT NULL,
	"max_views" integer NOT NULL,
	"views" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_by_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vault_audit" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"client_id" uuid,
	"password_id" uuid,
	"password_name" text NOT NULL,
	"actor_id" uuid,
	"actor_name" text NOT NULL,
	"action" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"ip" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vault_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"wrapped_key" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "require_reveal_reason" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "password_access" ADD CONSTRAINT "password_access_password_id_passwords_id_fk" FOREIGN KEY ("password_id") REFERENCES "public"."passwords"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_access" ADD CONSTRAINT "password_access_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_history" ADD CONSTRAINT "password_history_password_id_passwords_id_fk" FOREIGN KEY ("password_id") REFERENCES "public"."passwords"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_history" ADD CONSTRAINT "password_history_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passwords" ADD CONSTRAINT "passwords_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passwords" ADD CONSTRAINT "passwords_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passwords" ADD CONSTRAINT "passwords_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passwords" ADD CONSTRAINT "passwords_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_password_id_passwords_id_fk" FOREIGN KEY ("password_id") REFERENCES "public"."passwords"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_audit" ADD CONSTRAINT "vault_audit_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_audit" ADD CONSTRAINT "vault_audit_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_audit" ADD CONSTRAINT "vault_audit_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_keys" ADD CONSTRAINT "vault_keys_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "password_history_item" ON "password_history" USING btree ("password_id","created_at");--> statement-breakpoint
CREATE INDEX "passwords_client" ON "passwords" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "passwords_fingerprint" ON "passwords" USING btree ("org_id","fingerprint");--> statement-breakpoint
CREATE INDEX "passwords_name_trgm" ON "passwords" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "share_links_token" ON "share_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "share_links_item" ON "share_links" USING btree ("password_id");--> statement-breakpoint
CREATE INDEX "vault_audit_item" ON "vault_audit" USING btree ("password_id","created_at");--> statement-breakpoint
CREATE INDEX "vault_audit_org" ON "vault_audit" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "vault_keys_org" ON "vault_keys" USING btree ("org_id");