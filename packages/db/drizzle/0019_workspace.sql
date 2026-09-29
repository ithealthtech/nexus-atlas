CREATE TABLE "favorites" (
	"user_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "favorites_user_id_entity_type_entity_id_pk" PRIMARY KEY("user_id","entity_type","entity_id"),
	CONSTRAINT "favorites_entity_type_check" CHECK ("favorites"."entity_type" in ('client','document','asset'))
);
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "notes_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "notes_updated_by" uuid;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "notes_updated_by_name" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "notes_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "hours" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "maintenance_window" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "workspace" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_notes_updated_by_users_id_fk" FOREIGN KEY ("notes_updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Quick notes written before notes were versioned become version 1, so their history starts with them.
INSERT INTO "revisions" ("org_id", "entity_type", "entity_id", "version", "snapshot", "author_name", "created_at")
SELECT "org_id", 'client_notes', "id", 1, jsonb_build_object('notes', "notes"), 'Before version history', "updated_at"
FROM "clients" WHERE "notes" <> '';--> statement-breakpoint
UPDATE "clients" SET "notes_version" = 1 WHERE "notes" <> '';
