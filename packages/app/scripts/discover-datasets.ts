#!/usr/bin/env node

/**
 * Script to discover all available datasets at build time
 * Reads all dataset directories and generates a datasets.json file
 */

import { readdirSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface DatasetInfo {
  name: string;
  displayName: string;
  project: string;
  fetched_at: string;
  days_back: number;
  pipeline_count: number;
  path: string;
}

function discoverDatasets(datasetsDir: string): DatasetInfo[] {
  if (!existsSync(datasetsDir)) {
    console.warn(`⚠️  Datasets directory not found: ${datasetsDir}`);
    return [];
  }

  const datasets: DatasetInfo[] = [];
  const entries = readdirSync(datasetsDir);

  for (const entry of entries) {
    const datasetPath = join(datasetsDir, entry);
    const stat = statSync(datasetPath);
    
    if (!stat.isDirectory()) continue;

    const metadataPath = join(datasetPath, 'metadata.json');
    const pipelinesPath = join(datasetPath, 'pipelines.json');

    // Check if both required files exist
    if (!existsSync(metadataPath) || !existsSync(pipelinesPath)) {
      console.warn(`⚠️  Skipping incomplete dataset: ${entry}`);
      continue;
    }

    try {
      const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
      
      // Extract display name from project path (last segment)
      const displayName = metadata.dataset_name || entry;
      
      datasets.push({
        name: entry,
        displayName,
        project: metadata.project,
        fetched_at: metadata.fetched_at,
        days_back: metadata.days_back,
        pipeline_count: metadata.pipeline_count,
        path: `/datasets/${entry}`,
      });

      console.log(`✓ Discovered dataset: ${displayName} (${metadata.pipeline_count} pipelines)`);
    } catch (error) {
      console.warn(`⚠️  Failed to read metadata for ${entry}:`, error);
    }
  }

  return datasets;
}

// Main execution
const publicDir = join(__dirname, '..', 'public');
const datasetsDir = join(publicDir, 'datasets');
const outputPath = join(publicDir, 'datasets.json');

console.log('🔍 Discovering datasets...\n');
const datasets = discoverDatasets(datasetsDir);

// Write the datasets index
writeFileSync(outputPath, JSON.stringify(datasets, null, 2));
console.log(`\n✅ Wrote ${datasets.length} dataset(s) to ${outputPath}`);

// Exit with error if no datasets found
if (datasets.length === 0) {
  console.error('\n❌ No datasets found! Please run fetch-pipelines.ts first.');
  process.exit(1);
}
