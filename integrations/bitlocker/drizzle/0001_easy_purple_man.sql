CREATE TABLE `agent_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`received_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `reports_agent` ON `agent_reports` (`agent_id`);--> statement-breakpoint
CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`tenant` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`public_key` text NOT NULL,
	`private_key` text NOT NULL,
	`machine_id` text,
	`revoked` integer DEFAULT 0 NOT NULL,
	`last_seen` text,
	`collected_at` text,
	`snapshot` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agents_owner` ON `agents` (`owner`);--> statement-breakpoint
CREATE INDEX `agents_token` ON `agents` (`token_hash`);--> statement-breakpoint
ALTER TABLE `devices` ADD `agent_id` text;--> statement-breakpoint
ALTER TABLE `devices` ADD `volume_id` text;--> statement-breakpoint
ALTER TABLE `devices` ADD `protection` text;--> statement-breakpoint
ALTER TABLE `devices` ADD `collected_at` text;