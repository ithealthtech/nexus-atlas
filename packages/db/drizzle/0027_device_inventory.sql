ALTER TABLE "rmm_device_status" ADD COLUMN "software" jsonb;--> statement-breakpoint
ALTER TABLE "rmm_device_status" ADD COLUMN "sign_ins" jsonb;--> statement-breakpoint
ALTER TABLE "rmm_device_status" ADD COLUMN "inventory_at" timestamp with time zone;