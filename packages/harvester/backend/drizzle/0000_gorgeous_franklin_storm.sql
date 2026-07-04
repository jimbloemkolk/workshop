CREATE TABLE `harvests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`agent_session_id` text,
	`model` text NOT NULL,
	`fixture` integer DEFAULT false NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`started_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE TABLE `insights` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`harvest_id` integer,
	`origin` text NOT NULL,
	`marker_id` integer,
	`title` text NOT NULL,
	`start_word` integer NOT NULL,
	`end_word` integer NOT NULL,
	`quote` text NOT NULL,
	`insight` text NOT NULL,
	`anchored` integer DEFAULT true NOT NULL,
	`status` text DEFAULT 'proposed' NOT NULL,
	`created_at` integer NOT NULL,
	`exported_path` text
);
--> statement-breakpoint
CREATE TABLE `markers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`start_s` real NOT NULL,
	`end_s` real,
	`flag` text DEFAULT 'ok' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `participants` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `recording_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`gap_before_s` real DEFAULT 0 NOT NULL,
	`first_segment` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`language` text DEFAULT 'nl' NOT NULL,
	`created_at` integer NOT NULL,
	`duration_s` real,
	`error` text,
	`exported_at` integer
);
--> statement-breakpoint
CREATE TABLE `speakers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`label` text NOT NULL,
	`participant_id` integer,
	`sample_start_s` real,
	`sample_end_s` real,
	`sample_text` text
);
--> statement-breakpoint
CREATE TABLE `supporting_quotes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`insight_id` integer NOT NULL,
	`start_word` integer NOT NULL,
	`end_word` integer NOT NULL,
	`quote` text NOT NULL,
	`why` text,
	`anchored` integer DEFAULT true NOT NULL
);
