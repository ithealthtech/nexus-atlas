ALTER TABLE "users" ADD COLUMN "entra_oid" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "entra_pending_oid" text;--> statement-breakpoint
CREATE UNIQUE INDEX "users_entra_oid" ON "users" USING btree ("entra_oid");