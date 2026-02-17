#!/usr/bin/env node

/**
 * Entry point for fetching GitLab pipeline failure data.
 *
 * This is a pure composition layer: it parses CLI args, creates the
 * transport/cache/task/writer instances, and hands off to the runner.
 *
 * Usage: npx tsx fetch-gitlab-failure.ts <project-path> [days] [options]
 *
 * Options:
 *   --stdout               Output to stdout instead of files
 *   --debug                Show detailed debug output (no TUI)
 *   --output-dir <dir>     Custom output directory
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { GlabTransport, ApiCache, getGitlabHostname, sanitizeHostname } from '@gitlab-analysis/gitlab-api';
import { runFetchTask } from '@gitlab-analysis/fetcher-core';

import { FailureFetchTask } from './src/task.js';
import { FailureWriter } from './src/writer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── CLI Argument Parsing ────────────────────────────────────────────────────

interface CliOptions {
  projectPath: string;
  daysBack: number;
  outputToStdout: boolean;
  debug: boolean;
  outputDir?: string;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: npx tsx fetch-gitlab-failure.ts <project-path> [days] [--stdout] [--debug] [--output-dir <dir>]');
    process.exit(1);
  }

  const projectPath = args[0];
  let daysBack = 7;
  let outputToStdout = false;
  let debug = false;
  let outputDir: string | undefined;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--stdout') {
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

  return { projectPath, daysBack, outputToStdout, debug, outputDir };
}

// ─── Composition ─────────────────────────────────────────────────────────────

async function main() {
  const options = parseArgs();

  // Shared infrastructure — same transport and cache as other fetchers
  const transport = new GlabTransport();
  const cache = new ApiCache();

  // Determine cache namespace from GitLab hostname
  const hostname = await getGitlabHostname();
  const cacheNamespace = sanitizeHostname(hostname);

  // Output directory: local to this package — data/{host}-{project}-failures/
  const sanitizedProject = options.projectPath.replace(/\//g, '-');
  const defaultOutputDir = join(
    __dirname, 'data',
    `${cacheNamespace}-${sanitizedProject}-failures`,
  );
  const outputDir = options.outputDir ?? defaultOutputDir;

  const task = new FailureFetchTask({
    projectPath: options.projectPath,
    daysBack: options.daysBack,
    transport,
    cache,
    cacheNamespace,
  });

  const writer = new FailureWriter();

  await runFetchTask(task, writer, {
    stdout: options.outputToStdout,
    debug: options.debug,
    subtitle: `Project: ${options.projectPath} • Last ${options.daysBack} days`,
    outputDir,
  });
}

main().catch((error) => {
  const errorMessage = error.message || String(error);

  if (errorMessage.includes('403 Forbidden')) {
    console.error('\n❌ Error: Not authorized to access GitLab API');
    console.error('\nPlease authenticate with glab:');
    console.error('  glab auth login');
  } else {
    console.error('\n❌ Error:', errorMessage);
  }
  process.exit(1);
});
