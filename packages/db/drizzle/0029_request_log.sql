CREATE TABLE "request_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"service" text NOT NULL,
	"method" text NOT NULL,
	"url" text NOT NULL,
	"status" integer NOT NULL,
	"duration_ms" integer NOT NULL,
	"actor" text DEFAULT '' NOT NULL,
	"error" text DEFAULT '' NOT NULL,
	"request_headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"request_body" text DEFAULT '' NOT NULL,
	"response_headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"response_body" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "request_log" ADD CONSTRAINT "request_log_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "request_log_org" ON "request_log" USING btree ("org_id","id");