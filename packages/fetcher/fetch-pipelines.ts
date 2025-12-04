#!/usr/bin/env node

/**
 * Script to fetch GitLab pipeline data using glab CLI
 * Usage: node fetch-pipelines.ts <project-path> [days] [--pipeline-id <id>] [--stdout]
 * Example: node fetch-pipelines.ts mygroup/myproject 30
 * Example: node fetch-pipelines.ts mygroup/myproject --pipeline-id 1792668 --stdout
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import React from 'react';
import { render } from 'ink';
import type { FetchOptions, FetchResult, GitLabPipelineBasic, GitLabPipelineFull } from './fetching/types.js';
import { fetchPipelineList, fetchPipelineBasic } from './fetching/gitlabClient.js';
import { fetchPipelineWithDetails, fetchPipelinesBatch } from './fetching/fetcher.js';
import { ensureCacheDirectories } from './fetching/cache.js';
import { type FetchStats } from './fetching/ui/FetchUI.js';
import { FetchApp } from './fetching/ui/FetchApp.js';
import { apiMetrics } from './fetching/apiMetrics.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Get the data directory for a specific dataset
 */
function getDataDir(datasetName: string): string {
  // Store in app/public/datasets so the React app can serve them
  return join(__dirname, '..', 'app', 'public', 'datasets', datasetName);
}

/**
 * Parse command line arguments
 */
function parseArgs(): FetchOptions {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: node fetch-pipelines.ts <project-path> [days] [--pipeline-id <id>] [--stdout] [--rebuild] [--debug] [--dataset-name <name>]');
    console.error('  --pipeline-id <id>  Fetch only a single pipeline by ID');
    console.error('  --stdout            Output to stdout instead of files');
    console.error('  --rebuild           Rebuild pipelines from scratch (ignores existing data, but uses cache)');
    console.error('  --debug             Show detailed debug output (no TUI)');
    console.error('  --dataset-name <name>  Custom name for the dataset (defaults to last part of project path)');
    process.exit(1);
  }

  let projectPath = args[0];
  let daysBack = 30;
  let singlePipelineId: number | undefined = undefined;
  let outputToStdout = false;
  let rebuild = false;
  let debug = false;
  let datasetName: string | undefined = undefined;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--pipeline-id' && i + 1 < args.length) {
      singlePipelineId = parseInt(args[i + 1], 10);
      i++; // Skip next arg
    } else if (args[i] === '--stdout') {
      outputToStdout = true;
    } else if (args[i] === '--rebuild') {
      rebuild = true;
    } else if (args[i] === '--debug') {
      debug = true;
    } else if (args[i] === '--dataset-name' && i + 1 < args.length) {
      datasetName = args[i + 1];
      i++; // Skip next arg
    } else if (!args[i].startsWith('--') && !isNaN(parseInt(args[i], 10))) {
      daysBack = parseInt(args[i], 10);
    }
  }

  // Default dataset name to the last part of the project path
  if (!datasetName) {
    const pathParts = projectPath.split('/');
    datasetName = pathParts[pathParts.length - 1];
  }

  return { projectPath, daysBack, singlePipelineId, outputToStdout, rebuild, debug, datasetName };
}

/**
 * Setup logging to respect --stdout flag
 */
function setupLogging(outputToStdout: boolean) {
  if (outputToStdout) {
    // Redirect console.log to stderr when outputting JSON to stdout
    console.log = () => {};
  }
}

/**
 * Load existing pipelines from disk
 */
function loadExistingPipelines(dataDir: string, silent: boolean = false): GitLabPipelineFull[] {
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  const pipelinesFile = join(dataDir, 'pipelines.json');
  if (existsSync(pipelinesFile)) {
    try {
      const content = readFileSync(pipelinesFile, 'utf8');
      const pipelines = JSON.parse(content);
      if (!silent) {
        console.log(`📂 Loaded ${pipelines.length} existing pipelines from disk`);
      }
      return pipelines;
    } catch (error) {
      console.warn(`⚠️  Could not load existing pipelines: ${error instanceof Error ? error.message : error}`);
      return [];
    }
  }
  return [];
}

/**
 * Fetch a single pipeline
 */
async function fetchSinglePipeline(
  projectPath: string,
  pipelineId: number,
  outputToStdout: boolean
): Promise<void> {
  if (!outputToStdout) {
    console.log(`\n🔍 Fetching single pipeline #${pipelineId}...`);
  }

  try {
    // Fetch pipeline basic info
    const pipeline = await fetchPipelineBasic(projectPath, pipelineId);

    // Fetch complete pipeline with jobs and children
    const { pipeline: enrichedPipeline } = await fetchPipelineWithDetails(
      projectPath,
      pipeline,
      0,
      1,
      0
    );

    if (outputToStdout) {
      process.stdout.write(JSON.stringify(enrichedPipeline, null, 2));
    } else {
      console.log(`\n✅ Fetched pipeline #${pipelineId} with ${enrichedPipeline.jobs.length} jobs`);
    }
    process.exit(0);
  } catch (error) {
    console.error(`❌ Error fetching pipeline #${pipelineId}: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

interface UIContext {
  updateStats: (stats: Partial<FetchStats>) => void;
  addLog: (type: 'info' | 'warning' | 'error' | 'success', message: string) => void;
  incrementStat: (key: keyof Omit<FetchStats, 'phase' | 'currentPipeline' | 'totalPipelines'>) => void;
  incrementCacheStat: (key: 'cachedPipelines' | 'cachedPipelineDetails' | 'cachedJobs' | 'cachedGraphQL', amount: number) => void;
}

/**
 * Fetch multiple pipelines
 */
async function fetchMultiplePipelines(
  projectPath: string,
  daysBack: number,
  dataDir: string,
  datasetName: string,
  uiContext?: UIContext,
  rebuild: boolean = false
): Promise<FetchResult> {
  const log = (message: string) => {
    if (!uiContext) console.log(message);
  };

  const logError = (message: string) => {
    if (uiContext) {
      uiContext.addLog('error', message);
    } else {
      console.log(message);
    }
  };

  // Ensure cache directories exist
  ensureCacheDirectories();

  // Load existing pipelines (skip if rebuild flag is set)
  if (uiContext) uiContext.updateStats({ phase: 'fetching-list' });
  const existingPipelines = rebuild ? [] : loadExistingPipelines(dataDir, !!uiContext);
  const existingPipelineIds = new Set(existingPipelines.map((p) => p.id));

  if (uiContext) {
    uiContext.updateStats({ existingPipelines: existingPipelines.length });
  }

  if (rebuild && !uiContext) {
    console.log('🔄 Rebuild mode: ignoring existing pipeline data');
  }

  // Calculate date threshold
  const dateThreshold = new Date();
  dateThreshold.setDate(dateThreshold.getDate() - daysBack);
  const dateThresholdStr = dateThreshold.toISOString().slice(0, 10);
  const updatedAfterISO = dateThreshold.toISOString();

  // Fetch pipelines using created_after to filter at API level
  // glab --paginate will automatically fetch all pages
  log(`\nFetching pipelines created after ${updatedAfterISO}...`);
  const allPipelines = await fetchPipelineList(projectPath, updatedAfterISO, 100, 1);

  log(
    `Found ${allPipelines.length} pipelines from API (already filtered by created_after)`
  );

  // Filter out pipelines we already have
  const filteredPipelines = allPipelines.filter((p) => !existingPipelineIds.has(p.id));
  log(
    `Found ${filteredPipelines.length} new pipelines (${allPipelines.length - filteredPipelines.length} already exist)`
  );

  if (uiContext) {
    uiContext.updateStats({ 
      phase: 'processing',
      totalPipelines: filteredPipelines.length 
    });
  }

  // Fetch detailed information for each pipeline
  const detailedPipelines: GitLabPipelineFull[] = [];
  const failedPipelines: any[] = [];
  const concurrency = 5;

  let index = 0;
  while (index < filteredPipelines.length) {
    const batch = filteredPipelines
      .slice(index, index + concurrency)
      .map((p, i) => [index + i, p] as [number, GitLabPipelineBasic]);
    
    if (uiContext && batch.length > 0) {
      uiContext.updateStats({ 
        currentPipeline: `#${batch[0][1].id} - ${batch[0][1].ref}` 
      });
    }

    const { successful, failed, cached, cachedPipelines, cachedJobs, cachedGraphQL } = await fetchPipelinesBatch(
      projectPath,
      batch,
      filteredPipelines.length,
      !!uiContext // silent when TUI is active
    );
    
    detailedPipelines.push(...successful);
    failedPipelines.push(...failed);
    
    if (uiContext) {
      uiContext.updateStats({
        processedPipelines: detailedPipelines.length,
        failedPipelines: failedPipelines.length,
        apiMetrics: apiMetrics.getSummary(),
      });
      
      // Increment cache stats
      if (cached > 0) uiContext.incrementCacheStat('cachedPipelines', cached);
      if (cachedPipelines > 0) uiContext.incrementCacheStat('cachedPipelineDetails', cachedPipelines);
      if (cachedJobs > 0) uiContext.incrementCacheStat('cachedJobs', cachedJobs);
      if (cachedGraphQL > 0) uiContext.incrementCacheStat('cachedGraphQL', cachedGraphQL);
    }

    // Add errors to logs
    for (const fp of failed) {
      logError(`Pipeline #${fp.pipelineId} (${fp.pipelineRef}): ${fp.error}`);
    }
    
    index += concurrency;
  }

  // Log failed pipelines summary
  if (failedPipelines.length > 0 && !uiContext) {
    console.log(`\n⚠️  Failed to fetch ${failedPipelines.length} pipeline(s):`);
    failedPipelines.forEach((fp) => {
      console.log(`   - Pipeline #${fp.pipelineId} (${fp.pipelineRef}): ${fp.error}`);
    });
  }

  // Merge with existing pipelines
  const allPipelinesData = [...existingPipelines, ...detailedPipelines];
  log(
    `\n📊 Total pipelines: ${allPipelinesData.length} (${existingPipelines.length} existing + ${detailedPipelines.length} new successfully fetched)`
  );

  // Save all pipelines to a single file
  const outputFile = join(dataDir, 'pipelines.json');
  writeFileSync(outputFile, JSON.stringify(allPipelinesData, null, 2));
  log(`✅ Saved ${allPipelinesData.length} pipelines to ${outputFile}`);

  // Create metadata
  const metadata: FetchResult['metadata'] = {
    dataset_name: datasetName,
    project: projectPath,
    fetched_at: new Date().toISOString(),
    days_back: daysBack,
    date_threshold: dateThresholdStr,
    pipeline_count: allPipelinesData.length,
    new_pipelines: detailedPipelines.length,
    existing_pipelines: existingPipelines.length,
    failed_pipelines: failedPipelines.length,
    cached_pipelines: 0, // We'll need to track this properly
    failed_pipeline_details: failedPipelines,
  };

  // Save metadata
  const metadataFile = join(dataDir, 'metadata.json');
  writeFileSync(metadataFile, JSON.stringify(metadata, null, 2));
  log(`✅ Saved metadata to ${metadataFile}`);

  if (uiContext) {
    uiContext.updateStats({ phase: 'complete' });
  }

  return {
    pipelines: allPipelinesData,
    failed: failedPipelines,
    metadata,
  };
}

/**
 * Main entry point
 */
async function main() {
  const options = parseArgs();
  setupLogging(options.outputToStdout || false);

  // Handle single pipeline mode
  if (options.singlePipelineId) {
    await fetchSinglePipeline(
      options.projectPath,
      options.singlePipelineId,
      options.outputToStdout || false
    );
    return;
  }

  const datasetName = options.datasetName!;
  const dataDir = getDataDir(datasetName);

  // Use TUI for multi-pipeline fetching (unless stdout or debug mode)
  if (options.outputToStdout || options.debug) {
    await fetchMultiplePipelines(
      options.projectPath, 
      options.daysBack || 30,
      dataDir,
      datasetName,
      undefined, 
      options.rebuild || false
    );
    console.log('\n🎉 Done!');
  } else {
    // Render the TUI
    const { waitUntilExit } = render(
      React.createElement(FetchApp, {
        projectPath: options.projectPath,
        daysBack: options.daysBack || 30,
        onComplete: () => {
          // Exit after a brief delay to show completion
          setTimeout(() => process.exit(0), 2000);
        },
        fetchFn: async (uiContext: any) => {
          await fetchMultiplePipelines(
            options.projectPath,
            options.daysBack || 30,
            dataDir,
            datasetName,
            uiContext,
            options.rebuild || false
          );
        },
      })
    );

    await waitUntilExit();
  }
}

main().catch((error) => {
  const errorMessage = error.message || String(error);
  
  // Check if it's a 403 error
  if (errorMessage.includes('403 Forbidden')) {
    console.error('\n❌ Error: Not authorized to access GitLab API');
    console.error('\nPlease authenticate with glab:');
    console.error('  glab auth login');
    console.error('\nOr check your authentication status:');
    console.error('  glab auth status');
  } else {
    console.error('\n❌ Error:', errorMessage);
    console.error('\nMake sure you have glab CLI installed and configured:');
    console.error('  brew install glab');
    console.error('  glab auth login');
  }
  
  process.exit(1);
});
