--> The ocean, in one step (squashed 0002–0006, none of which shipped).
--> Restructures the original harvested `insights` into the two-tier model:
--> snippets are evidence, an insight is the proposed/reviewed unit over a main
--> snippet with supporting snippets (insight_snippets). Each original insight
--> becomes an insight + its main snippet (same id); each supporting_quote
--> becomes a supporting snippet + link. Data preserved; exported_path dropped.
CREATE TABLE `snippets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`start_word` integer NOT NULL,
	`end_word` integer NOT NULL,
	`quote` text NOT NULL,
	`anchored` integer DEFAULT true NOT NULL,
	`spoken_at` integer,
	`status` text DEFAULT 'proposed' NOT NULL,
	`_src_sq` integer
);
--> statement-breakpoint
CREATE TABLE `insight_snippets` (
	`insight_id` integer NOT NULL,
	`snippet_id` integer NOT NULL,
	`why` text
);
--> statement-breakpoint
ALTER TABLE `insights` RENAME TO `_old_insights`;
--> statement-breakpoint
CREATE TABLE `insights` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`harvest_id` integer,
	`origin` text NOT NULL,
	`harvest_span_id` integer,
	`main_snippet_id` integer NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`status` text DEFAULT 'proposed' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `snippets` (`id`, `session_id`, `start_word`, `end_word`, `quote`, `anchored`, `spoken_at`, `status`, `_src_sq`)
	SELECT `id`, `session_id`, `start_word`, `end_word`, `quote`, `anchored`, NULL, `status`, NULL FROM `_old_insights`;
--> statement-breakpoint
INSERT INTO `insights` (`session_id`, `harvest_id`, `origin`, `harvest_span_id`, `main_snippet_id`, `title`, `description`, `status`, `created_at`)
	SELECT `session_id`, `harvest_id`, `origin`, `harvest_span_id`, `id`, `title`, `insight`, `status`, `created_at` FROM `_old_insights`;
--> statement-breakpoint
INSERT INTO `snippets` (`session_id`, `start_word`, `end_word`, `quote`, `anchored`, `spoken_at`, `status`, `_src_sq`)
	SELECT oi.`session_id`, sq.`start_word`, sq.`end_word`, sq.`quote`, sq.`anchored`, NULL, oi.`status`, sq.`id`
	FROM `supporting_quotes` sq JOIN `_old_insights` oi ON oi.`id` = sq.`insight_id`;
--> statement-breakpoint
INSERT INTO `insight_snippets` (`insight_id`, `snippet_id`, `why`)
	SELECT i.`id`, ns.`id`, sq.`why`
	FROM `snippets` ns
	JOIN `supporting_quotes` sq ON sq.`id` = ns.`_src_sq`
	JOIN `insights` i ON i.`main_snippet_id` = sq.`insight_id`;
--> statement-breakpoint
DROP TABLE `supporting_quotes`;
--> statement-breakpoint
DROP TABLE `_old_insights`;
--> statement-breakpoint
CREATE TABLE `snippets_final` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`start_word` integer NOT NULL,
	`end_word` integer NOT NULL,
	`quote` text NOT NULL,
	`anchored` integer DEFAULT true NOT NULL,
	`spoken_at` integer,
	`status` text DEFAULT 'proposed' NOT NULL
);
--> statement-breakpoint
INSERT INTO `snippets_final` (`id`, `session_id`, `start_word`, `end_word`, `quote`, `anchored`, `spoken_at`, `status`)
	SELECT `id`, `session_id`, `start_word`, `end_word`, `quote`, `anchored`, `spoken_at`, `status` FROM `snippets`;
--> statement-breakpoint
DROP TABLE `snippets`;
--> statement-breakpoint
ALTER TABLE `snippets_final` RENAME TO `snippets`;
