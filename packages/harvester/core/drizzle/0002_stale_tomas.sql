CREATE TABLE `snippets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_insight_id` integer NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`spoken_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
