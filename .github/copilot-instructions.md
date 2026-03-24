# Transform Package CLI

## Architecture
- **packages/gitlab/transform/**: Business logic - pipeline transformation, critical path, job impacts, timeline layout, aggregation, type detection
- **packages/gitlab/app/**: React UI - visualization, formatting, pixel positioning only

## CLI Commands

Base: `npx tsx packages/gitlab/transform/src/cli.ts <command> [options]` or `npm run transform -- <command> [options]`

### Commands

1. **pipeline** - Transform single pipeline, get full analysis
   ```bash
   npx tsx packages/gitlab/transform/src/cli.ts pipeline -f <file> -i <iid> --pretty
   ```
   Output: jobs, dependencies, hierarchy, critical path, job impacts, timeline layout, stats

2. **aggregate** - Multi-pipeline job impact analysis
   ```bash
   npx tsx packages/gitlab/transform/src/cli.ts aggregate -f <file> --limit 50 --pretty
   ```
   Options: `--limit <n>` (analyze first N pipelines)
   Output: summary stats, sorted jobs by total impact, per-job metrics

3. **types** - Pipeline type distribution (MR, Merge Train, Main, RC, Release)
   ```bash
   npx tsx packages/gitlab/transform/src/cli.ts types -f <file> --pretty
   ```
   Output: type counts, list with detected types

4. **critical-path** - Show critical path jobs for pipeline
   ```bash
   npx tsx packages/gitlab/transform/src/cli.ts critical-path -f <file> -i <iid> --pretty
   ```
   Output: ordered jobs on critical path, timing, dependency types

5. **job-impacts** - Top impactful jobs for pipeline
   ```bash
   npx tsx packages/gitlab/transform/src/cli.ts job-impacts -f <file> -i <iid> --top 10 --pretty
   ```
   Options: `--top <n>` (default: 10)
   Output: top N jobs by impact, percentages, status, duration

6. **timeline** - Timeline layout structure
   ```bash
   npx tsx packages/gitlab/transform/src/cli.ts timeline -f <file> -i <iid> --pretty
   ```
   Output: pipeline hierarchy, stages (sorted), position percentages (startPercent, widthPercent, etc)

## Data Locations
- Current: `packages/gitlab/app/public/data/pipelines.json`
- Pre-merge: `packages/gitlab/app/public/data-pre-merge/pipelines.json`
- Old: `packages/gitlab/app/public/old/pipelines.json`

## Tips
- Use `--pretty` for readable output
- Pipe to files: `... > output.json`
- Filter with jq: `... | jq '.jobImpacts[0]'`
- All timestamps in ms (UNIX epoch), durations in seconds
- Use `--limit` for large datasets

## Files
- CLI: `packages/gitlab/transform/src/cli.ts`
- Logic: `packages/gitlab/transform/src/transform.ts`, `aggregation.ts`, `pipelineType.ts`
- Types: `packages/gitlab/transform/src/types.ts`
