ALTER TABLE "tickets" ADD COLUMN "board" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "origin" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "kind" text DEFAULT '' NOT NULL;