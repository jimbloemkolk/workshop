#!/usr/bin/env node

/**
 * Generate CSV files from a failures.json for Google Sheets analysis.
 *
 * Reads a FailureFetchResult JSON and produces 4 CSV files:
 *   1. failures-by-category-over-time.csv  — daily counts by failure category
 *   2. failures-by-job-name.csv            — per-job failure stats
 *   3. failures-by-runner.csv              — per-runner failure stats
 *   4. failure-details.csv                 — one row per failed job (or per failure pattern)
 *
 * Usage:
 *   npx tsx packages/fetch-gitlab-failure/scripts/generate-csvs.ts [--input <failures.json>] [--output-dir <dir>]
 *
 * Defaults:
 *   --input:      auto-discovers most recent failures.json in datasets
 *   --output-dir: same directory as input
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import type { FailureFetchResult, FailedJobInfo, FailureCategory } from '../src/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ALL_CATEGORIES: FailureCategory[] = [
  'system_failure',
  'script_failure',
  'timeout',
  'infrastructure',
  'unknown',
];

// ─── CLI Parsing ─────────────────────────────────────────────────────────────

interface CsvOptions {
  inputFile: string;
  outputDir: string;
}

function parseArgs(): CsvOptions {
  const args = process.argv.slice(2);
  let inputFile: string | undefined;
  let outputDir: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && i + 1 < args.length) {
      inputFile = args[i + 1];
      i++;
    } else if (args[i] === '--output-dir' && i + 1 < args.length) {
      outputDir = args[i + 1];
      i++;
    }
  }

  if (!inputFile) {
    inputFile = discoverLatestFailuresJson();
    if (!inputFile) {
      console.error('❌ No failures.json found. Specify with --input <path>');
      process.exit(1);
    }
    console.log(`📄 Auto-discovered: ${inputFile}`);
  }

  if (!outputDir) {
    outputDir = dirname(resolve(inputFile));
  }

  return { inputFile: resolve(inputFile), outputDir: resolve(outputDir) };
}

function discoverLatestFailuresJson(): string | undefined {
  const datasetsDir = join(__dirname, '..', 'data');
  if (!existsSync(datasetsDir)) return undefined;

  let latestFile: string | undefined;
  let latestMtime = 0;

  for (const entry of readdirSync(datasetsDir)) {
    const entryPath = join(datasetsDir, entry);
    const failuresPath = join(entryPath, 'failures.json');
    if (existsSync(failuresPath)) {
      const mtime = statSync(failuresPath).mtimeMs;
      if (mtime > latestMtime) {
        latestMtime = mtime;
        latestFile = failuresPath;
      }
    }
  }

  return latestFile;
}

// ─── CSV Helpers ─────────────────────────────────────────────────────────────

/** Escape a value for CSV (wrap in quotes if contains comma, quote, or newline) */
function csvEscape(value: string | number | boolean | null | undefined): string {
  if (value == null) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function csvRow(values: Array<string | number | boolean | null | undefined>): string {
  return values.map(csvEscape).join(',');
}

/** Get the primary (first) failure category for a job */
function primaryCategory(job: FailedJobInfo): FailureCategory {
  return job.failures.length > 0 ? job.failures[0].category : 'unknown';
}

/** Format ISO date to YYYY-MM-DD */
function toDateStr(isoDate: string | null): string {
  if (!isoDate) return '';
  return isoDate.slice(0, 10);
}

// ─── CSV Generators ──────────────────────────────────────────────────────────

/**
 * 1. failures-by-category-over-time.csv
 * Columns: date, system_failure, script_failure, timeout, infrastructure, unknown, total
 */
function generateCategoryOverTime(jobs: FailedJobInfo[]): string {
  // Group by date → category counts
  const dayCounts = new Map<string, Record<FailureCategory, number>>();

  for (const job of jobs) {
    const date = toDateStr(job.pipelineCreatedAt);
    if (!date) continue;

    if (!dayCounts.has(date)) {
      dayCounts.set(date, { system_failure: 0, script_failure: 0, timeout: 0, infrastructure: 0, unknown: 0 });
    }
    const counts = dayCounts.get(date)!;
    const cat = primaryCategory(job);
    counts[cat]++;
  }

  // Sort by date
  const sortedDates = [...dayCounts.keys()].sort();

  const rows = [csvRow(['date', ...ALL_CATEGORIES, 'total'])];
  for (const date of sortedDates) {
    const c = dayCounts.get(date)!;
    const total = ALL_CATEGORIES.reduce((sum, cat) => sum + c[cat], 0);
    rows.push(csvRow([date, ...ALL_CATEGORIES.map((cat) => c[cat]), total]));
  }

  return rows.join('\n');
}

/**
 * 2. failures-by-job-name.csv
 * Columns: job_name, stage, total_failures, system_failure, script_failure, timeout, infrastructure, unknown, avg_duration_s, most_common_error
 */
function generateByJobName(jobs: FailedJobInfo[]): string {
  const jobStats = new Map<string, {
    stage: string;
    counts: Record<FailureCategory, number>;
    total: number;
    durations: number[];
    errorPatterns: Map<string, number>;
  }>();

  for (const job of jobs) {
    if (!jobStats.has(job.jobName)) {
      jobStats.set(job.jobName, {
        stage: job.stage,
        counts: { system_failure: 0, script_failure: 0, timeout: 0, infrastructure: 0, unknown: 0 },
        total: 0,
        durations: [],
        errorPatterns: new Map(),
      });
    }
    const stats = jobStats.get(job.jobName)!;
    stats.total++;
    const cat = primaryCategory(job);
    stats.counts[cat]++;
    if (job.duration != null) stats.durations.push(job.duration);

    // Track most common error pattern
    for (const f of job.failures) {
      const key = `${f.pattern}: ${f.matchedText.slice(0, 100)}`;
      stats.errorPatterns.set(key, (stats.errorPatterns.get(key) ?? 0) + 1);
    }
  }

  // Sort by total failures desc
  const sorted = [...jobStats.entries()].sort((a, b) => b[1].total - a[1].total);

  const rows = [csvRow(['job_name', 'stage', 'total_failures', ...ALL_CATEGORIES, 'avg_duration_s', 'most_common_error'])];
  for (const [name, stats] of sorted) {
    const avgDuration = stats.durations.length > 0
      ? Math.round(stats.durations.reduce((a, b) => a + b, 0) / stats.durations.length)
      : '';

    // Find most common error
    let mostCommon = '';
    let maxCount = 0;
    for (const [pattern, count] of stats.errorPatterns) {
      if (count > maxCount) {
        maxCount = count;
        mostCommon = pattern;
      }
    }

    rows.push(csvRow([
      name,
      stats.stage,
      stats.total,
      ...ALL_CATEGORIES.map((cat) => stats.counts[cat]),
      avgDuration,
      mostCommon,
    ]));
  }

  return rows.join('\n');
}

/**
 * 3. failures-by-runner.csv
 * Columns: runner_id, runner_description, total_failures, system_failure, script_failure, timeout, infrastructure, unknown
 */
function generateByRunner(jobs: FailedJobInfo[]): string {
  const runnerStats = new Map<string, {
    description: string;
    counts: Record<FailureCategory, number>;
    total: number;
  }>();

  for (const job of jobs) {
    const runnerId = job.runner ? String(job.runner.id) : 'unknown';
    const runnerDesc = job.runner?.description ?? 'unknown';

    if (!runnerStats.has(runnerId)) {
      runnerStats.set(runnerId, {
        description: runnerDesc,
        counts: { system_failure: 0, script_failure: 0, timeout: 0, infrastructure: 0, unknown: 0 },
        total: 0,
      });
    }
    const stats = runnerStats.get(runnerId)!;
    stats.total++;
    const cat = primaryCategory(job);
    stats.counts[cat]++;
  }

  // Sort by total failures desc
  const sorted = [...runnerStats.entries()].sort((a, b) => b[1].total - a[1].total);

  const rows = [csvRow(['runner_id', 'runner_description', 'total_failures', ...ALL_CATEGORIES])];
  for (const [runnerId, stats] of sorted) {
    rows.push(csvRow([
      runnerId,
      stats.description,
      stats.total,
      ...ALL_CATEGORIES.map((cat) => stats.counts[cat]),
    ]));
  }

  return rows.join('\n');
}

/**
 * 4. failure-details.csv
 * One row per failed job. If a job has multiple failure patterns, one row per pattern.
 * Columns: date, pipeline_iid, pipeline_ref, pipeline_source, job_name, stage,
 *          allow_failure, duration_s, queued_duration_s, failure_category,
 *          failure_pattern, matched_text, runner_id, runner_description, job_url
 */
function generateDetails(jobs: FailedJobInfo[]): string {
  const header = csvRow([
    'date', 'pipeline_iid', 'pipeline_ref', 'pipeline_source',
    'job_name', 'stage', 'allow_failure', 'duration_s', 'queued_duration_s',
    'failure_category', 'failure_pattern', 'matched_text',
    'runner_id', 'runner_description', 'job_url',
  ]);

  const rows = [header];

  for (const job of jobs) {
    const baseRow = [
      toDateStr(job.pipelineCreatedAt),
      job.pipelineIid,
      job.pipelineRef,
      job.pipelineSource ?? '',
      job.jobName,
      job.stage,
      job.allowFailure,
      job.duration ?? '',
      job.queuedDuration ?? '',
    ];

    if (job.failures.length === 0) {
      rows.push(csvRow([
        ...baseRow,
        'unknown', '', '',
        job.runner?.id ?? '', job.runner?.description ?? '',
        job.webUrl,
      ]));
    } else {
      for (const f of job.failures) {
        rows.push(csvRow([
          ...baseRow,
          f.category, f.pattern, f.matchedText,
          job.runner?.id ?? '', job.runner?.description ?? '',
          job.webUrl,
        ]));
      }
    }
  }

  return rows.join('\n');
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  const options = parseArgs();

  // Read failures.json
  const raw = readFileSync(options.inputFile, 'utf8');
  const data: FailureFetchResult = JSON.parse(raw);

  console.log(`📊 Processing ${data.jobs.length} failed jobs from ${data.metadata.failedPipelines} pipelines`);

  const files: Array<[string, string]> = [
    ['failures-by-category-over-time.csv', generateCategoryOverTime(data.jobs)],
    ['failures-by-job-name.csv', generateByJobName(data.jobs)],
    ['failures-by-runner.csv', generateByRunner(data.jobs)],
    ['failure-details.csv', generateDetails(data.jobs)],
  ];

  for (const [filename, content] of files) {
    const filepath = join(options.outputDir, filename);
    writeFileSync(filepath, content);
    const lineCount = content.split('\n').length - 1; // exclude header
    console.log(`  ✅ ${filename} (${lineCount} data rows)`);
  }

  console.log(`\n📁 Output: ${options.outputDir}`);
}

main();
