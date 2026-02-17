#!/usr/bin/env node

/**
 * Entry point for fetching GitLab pipeline data.
 * 
 * This is a pure composition layer: it parses CLI args, creates the
 * transport/cache/task/writer instances, and hands off to the runner.
 * 
 * Usage: npx tsx fetch-pipelines.ts <project-path> [days] [options]
 * 
 * Options:
 *   --pipeline-id <id>    Fetch only a single pipeline by ID
 *   --stdout              Output to stdout instead of files
 *   --rebuild             Rebuild from scratch (ignores existing data, uses cache)
 *   --debug               Show detailed debug output (no TUI)
 *   --dataset-name <name> Custom name for the dataset
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { GlabTransport, ApiCache, getGitlabHostname, sanitizeHostname } from '@gitlab-analysis/gitlab-api';
import { runFetchTask } from '@gitlab-analysis/fetcher-core';

import { PipelineFetchTask } from './src/task.js';
import { PipelineWriter } from './src/writer.js';
import { SinglePipelineFetchTask } from './src/singlePipelineTask.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── CLI Argument Parsing ────────────────────────────────────────────────────

interface CliOptions {
  projectPath: string;
  daysBack: number;
  singlePipelineId?: number;
  outputToStdout: boolean;
  rebuild: boolean;
  debug: boolean;
  datasetName: string;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: npx tsx fetch-pipelines.ts <project-path> [days] [--pipeline-id <id>] [--stdout] [--rebuild] [--debug] [--dataset-name <name>]');
    process.exit(1);
  }

  const projectPath = args[0];
  let daysBack = 30;
  let singlePipelineId: number | undefined;
  let outputToStdout = false;
  let rebuild = false;
  let debug = false;
  let datasetName: string | undefined;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--pipeline-id' && i + 1 < args.length) {
      singlePipelineId = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--stdout') {
      outputToStdout = true;
    } else if (args[i] === '--rebuild') {
      rebuild = true;
    } else if (args[i] === '--debug') {
      debug = true;
    } else if (args[i] === '--dataset-name' && i + 1 < args.length) {
      datasetName = args[i + 1];
      i++;
    } else if (!args[i].startsWith('--') && !isNaN(parseInt(args[i], 10))) {
      daysBack = parseInt(args[i], 10);
    }
  }

  if (!datasetName) {
    const pathParts = projectPath.split('/');
    datasetName = pathParts[pathParts.length - 1];
  }

  return { projectPath, daysBack, singlePipelineId, outputToStdout, rebuild, debug, datasetName: datasetName! };
}

// ─── Composition ─────────────────────────────────────────────────────────────

async function main() {
  const options = parseArgs();

  // Shared infrastructure
  const transport = new GlabTransport();
  const cache = new ApiCache();

  // Determine cache namespace from GitLab hostname
  const hostname = await getGitlabHostname();
  const cacheNamespace = sanitizeHostname(hostname);

  // Output directory: app/public/datasets/{datasetName}
  const dataDir = join(__dirname, '..', 'app', 'public', 'datasets', options.datasetName);

  if (options.singlePipelineId) {
    // Single pipeline mode
    const task = new SinglePipelineFetchTask({
      projectPath: options.projectPath,
      pipelineId: options.singlePipelineId,
      transport,
      cache,
      cacheNamespace,
    });

    const writer = new PipelineWriter();

    await runFetchTask(task, writer, {
      stdout: options.outputToStdout,
      debug: true, // Single pipeline always uses debug mode (no TUI)
      outputDir: dataDir,
    });
  } else {
    // Multi-pipeline mode
    const task = new PipelineFetchTask({
      projectPath: options.projectPath,
      daysBack: options.daysBack,
      datasetName: options.datasetName,
      dataDir,
      rebuild: options.rebuild,
      transport,
      cache,
      cacheNamespace,
    });

    const writer = new PipelineWriter();

    await runFetchTask(task, writer, {
      stdout: options.outputToStdout,
      debug: options.debug,
      subtitle: `Project: ${options.projectPath} • Last ${options.daysBack} days`,
      outputDir: dataDir,
    });
  }
}

main().catch((error) => {
  const errorMessage = error.message || String(error);

  if (errorMessage.includes('403 Forbidden')) {
    console.error('\n❌ Error: Not authorized to access GitLab API');
    console.error('\nPlease authenticate with glab:');
    console.error('  glab auth login');
  } else {
    console.error('\n❌ Error:', errorMessage);
    console.error('\nMake sure you have glab CLI installed and configured:');
    console.error('  brew install glab');
    console.error('  glab auth login');
  }

  process.exit(1);
});
