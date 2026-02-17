#!/usr/bin/env node

/**
 * Entry point for fetching GitLab job logs.
 * 
 * This is a pure composition layer: it parses CLI args, creates the
 * transport/cache/task/writer instances, and hands off to the runner.
 * 
 * Usage: npx tsx fetch-job-logs.ts <project-path> [days] [options]
 * 
 * Options:
 *   --job-name <pattern>   Only fetch logs for jobs matching this name
 *   --stdout               Output to stdout instead of files
 *   --debug                Show detailed debug output (no TUI)
 *   --output-dir <dir>     Custom output directory
 */

import { GlabTransport, ApiCache, getGitlabHostname, sanitizeHostname } from '@gitlab-analysis/gitlab-api';
import { runFetchTask } from '@gitlab-analysis/fetcher-core';

import { JobLogsFetchTask } from './src/task.js';
import { JobLogsWriter } from './src/writer.js';

// ─── CLI Argument Parsing ────────────────────────────────────────────────────

interface CliOptions {
  projectPath: string;
  daysBack: number;
  jobNameFilter?: string;
  outputToStdout: boolean;
  debug: boolean;
  outputDir?: string;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: npx tsx fetch-job-logs.ts <project-path> [days] [--job-name <pattern>] [--stdout] [--debug] [--output-dir <dir>]');
    process.exit(1);
  }

  const projectPath = args[0];
  let daysBack = 30;
  let jobNameFilter: string | undefined;
  let outputToStdout = false;
  let debug = false;
  let outputDir: string | undefined;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--job-name' && i + 1 < args.length) {
      jobNameFilter = args[i + 1];
      i++;
    } else if (args[i] === '--stdout') {
      outputToStdout = true;
    } else if (args[i] === '--debug') {
      debug = true;
    } else if (args[i] === '--output-dir' && i + 1 < args.length) {
      outputDir = args[i + 1];
      i++;
    } else if (!args[i].startsWith('--') && !isNaN(parseInt(args[i], 10))) {
      daysBack = parseInt(args[i], 10);
    }
  }

  return { projectPath, daysBack, jobNameFilter, outputToStdout, debug, outputDir };
}

// ─── Composition ─────────────────────────────────────────────────────────────

async function main() {
  const options = parseArgs();

  // Shared infrastructure — same transport and cache as fetch-pipelines
  const transport = new GlabTransport();
  const cache = new ApiCache();

  // Determine cache namespace from GitLab hostname
  const hostname = await getGitlabHostname();
  const cacheNamespace = sanitizeHostname(hostname);

  const task = new JobLogsFetchTask({
    projectPath: options.projectPath,
    daysBack: options.daysBack,
    jobNameFilter: options.jobNameFilter,
    transport,
    cache,
    cacheNamespace,
  });

  const writer = new JobLogsWriter();

  await runFetchTask(task, writer, {
    stdout: options.outputToStdout,
    debug: options.debug,
    subtitle: `Project: ${options.projectPath} • Last ${options.daysBack} days`,
    outputDir: options.outputDir,
  });
}

main().catch((error) => {
  console.error('\n❌ Error:', error.message || String(error));
  process.exit(1);
});
