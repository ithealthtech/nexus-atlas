ALTER TABLE "users" ADD COLUMN "saml_subject" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "saml_pending_subject" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "saml_pending_email" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "saml_pending_name" text;--> statement-breakpoint
CREATE UNIQUE INDEX "users_saml_subject" ON "users" USING btree ("saml_subject");