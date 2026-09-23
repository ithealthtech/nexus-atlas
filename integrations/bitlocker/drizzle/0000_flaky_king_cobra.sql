CREATE TABLE `audit` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`action` text NOT NULL,
	`detail` text NOT NULL,
	`time` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_owner_time` ON `audit` (`owner`,`time`);--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`tenant` text NOT NULL,
	`name` text NOT NULL,
	`user` text NOT NULL,
	`key_id` text NOT NULL,
	`cipher` text NOT NULL,
	`updated` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `devices_owner_tenant` ON `devices` (`owner`,`tenant`);--> statement-breakpoint
CREATE TABLE `shares` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`device_id` text NOT NULL,
	`name` text NOT NULL,
	`recipient` text NOT NULL,
	`cipher` text NOT NULL,
	`expires` integer NOT NULL,
	`used` integer DEFAULT 0 NOT NULL,
	`revoked` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `shares_owner` ON `shares` (`owner`);