--> Swap the insight/snippet entities. The verbatim atom (old `insights`) is now
--> `snippets`; the refined ocean idea (old `snippets`) is now `insights`. Renames
--> only — every row is preserved. A temp name avoids the two tables colliding
--> mid-swap.
ALTER TABLE `insights` RENAME TO `__swap_snippets`;--> statement-breakpoint
ALTER TABLE `snippets` RENAME TO `insights`;--> statement-breakpoint
ALTER TABLE `__swap_snippets` RENAME TO `snippets`;--> statement-breakpoint
ALTER TABLE `snippets` RENAME COLUMN `insight` TO `note`;--> statement-breakpoint
ALTER TABLE `insights` RENAME COLUMN `source_insight_id` TO `source_snippet_id`;--> statement-breakpoint
ALTER TABLE `supporting_quotes` RENAME COLUMN `insight_id` TO `snippet_id`;
