ALTER TABLE "passwords" ADD COLUMN "breach_count" integer;--> statement-breakpoint
ALTER TABLE "passwords" ADD COLUMN "breach_checked_at" timestamp with time zone;