ALTER TABLE "alert_deliveries" ADD COLUMN "acknowledged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD COLUMN "acknowledged_by" text;--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD COLUMN "escalation" boolean DEFAULT false NOT NULL;