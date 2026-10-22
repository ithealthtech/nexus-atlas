CREATE TABLE "teams_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"event_key" text NOT NULL,
	"root_key" text,
	"kind" text NOT NULL,
	"team_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"text" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text DEFAULT '' NOT NULL,
	"conversation_id" text,
	"activity_id" text,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teams_deliveries_status" CHECK ("teams_deliveries"."status" in ('pending','sending','sent','failed','uncertain')),
	CONSTRAINT "teams_deliveries_kind" CHECK ("teams_deliveries"."kind" in ('expiration','review','breach','infection'))
);
--> statement-breakpoint
CREATE TABLE "teams_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"author_id" uuid,
	"team_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"message_id" text NOT NULL,
	"parent_id" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "teams_deliveries" ADD CONSTRAINT "teams_deliveries_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams_deliveries" ADD CONSTRAINT "teams_deliveries_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams_posts" ADD CONSTRAINT "teams_posts_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams_posts" ADD CONSTRAINT "teams_posts_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams_posts" ADD CONSTRAINT "teams_posts_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "teams_deliveries_event" ON "teams_deliveries" USING btree ("org_id","event_key","team_id","channel_id");--> statement-breakpoint
CREATE INDEX "teams_deliveries_due" ON "teams_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "teams_posts_message" ON "teams_posts" USING btree ("org_id","team_id","channel_id","message_id");