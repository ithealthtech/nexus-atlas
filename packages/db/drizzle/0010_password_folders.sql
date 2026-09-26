CREATE TABLE "password_folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "passwords" ADD COLUMN "folder_id" uuid;--> statement-breakpoint
ALTER TABLE "password_folders" ADD CONSTRAINT "password_folders_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_folders" ADD CONSTRAINT "password_folders_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "password_folders_name" ON "password_folders" USING btree ("client_id",lower("name"));--> statement-breakpoint
ALTER TABLE "passwords" ADD CONSTRAINT "passwords_folder_id_password_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."password_folders"("id") ON DELETE set null ON UPDATE no action;