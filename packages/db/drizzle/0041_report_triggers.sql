ALTER TABLE "report_schedules" DROP CONSTRAINT "report_schedules_cadence_check";--> statement-breakpoint
ALTER TABLE "report_schedules" ADD COLUMN "send_when" text DEFAULT 'always' NOT NULL;--> statement-breakpoint
ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_send_when_check" CHECK ("report_schedules"."send_when" in ('always','attention','new'));--> statement-breakpoint
ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_cadence_check" CHECK ("report_schedules"."cadence" in ('daily','weekly','monthly','quarterly'));