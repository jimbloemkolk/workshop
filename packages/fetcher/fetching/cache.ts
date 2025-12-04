import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import type { CacheEntry, GitLabJob, GraphQLResponse, GitLabPipelineBasic } from './types.js';

const CACHE_DIR = join(process.cwd(), '.cache');
const PIPELINE_CACHE_DIR = join(CACHE_DIR, 'pipeline-details');
const JOB_CACHE_DIR = join(CACHE_DIR, 'jobs');
const GRAPHQL_CACHE_DIR = join(CACHE_DIR, 'graphql');

/**
 * Ensure cache directories exist
 */
export function ensureCacheDirectories(): void {
  [CACHE_DIR, PIPELINE_CACHE_DIR, JOB_CACHE_DIR, GRAPHQL_CACHE_DIR].forEach(dir => {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  });
}

/**
 * Check if a pipeline is complete (will not change)
 */
export function isPipelineComplete(status: string): boolean {
  return ['success', 'failed', 'canceled', 'skipped'].includes(status);
}

/**
 * Cache pipeline basic details (raw API response)
 */
export function cachePipelineBasic(
  pipelineId: number,
  pipelineStatus: string,
  pipeline: GitLabPipelineBasic
): void {
  if (!isPipelineComplete(pipelineStatus)) {
    return; // Only cache completed pipelines
  }

  ensureCacheDirectories();
  const cacheEntry: CacheEntry<GitLabPipelineBasic> = {
    data: pipeline,
    cachedAt: new Date().toISOString(),
    pipelineStatus,
  };

  const cacheFile = join(PIPELINE_CACHE_DIR, `${pipelineId}.json`);
  writeFileSync(cacheFile, JSON.stringify(cacheEntry, null, 2));
}

/**
 * Get cached pipeline basic details
 */
export function getCachedPipelineBasic(pipelineId: number): GitLabPipelineBasic | null {
  const cacheFile = join(PIPELINE_CACHE_DIR, `${pipelineId}.json`);
  
  if (!existsSync(cacheFile)) {
    return null;
  }

  try {
    const content = readFileSync(cacheFile, 'utf8');
    const cacheEntry: CacheEntry<GitLabPipelineBasic> = JSON.parse(content);
    
    // Verify the pipeline is still in a complete state
    if (isPipelineComplete(cacheEntry.pipelineStatus)) {
      return cacheEntry.data;
    }
    
    return null;
  } catch (error) {
    console.warn(`⚠️  Could not read pipeline cache for pipeline ${pipelineId}: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}

/**
 * Cache jobs for a pipeline
 */
export function cacheJobs(pipelineId: number, pipelineStatus: string, jobs: GitLabJob[]): void {
  if (!isPipelineComplete(pipelineStatus)) {
    return; // Only cache jobs for completed pipelines
  }

  ensureCacheDirectories();
  const cacheEntry: CacheEntry<GitLabJob[]> = {
    data: jobs,
    cachedAt: new Date().toISOString(),
    pipelineStatus,
  };

  const cacheFile = join(JOB_CACHE_DIR, `${pipelineId}.json`);
  writeFileSync(cacheFile, JSON.stringify(cacheEntry, null, 2));
}

/**
 * Get cached jobs for a pipeline
 */
export function getCachedJobs(pipelineId: number): GitLabJob[] | null {
  const cacheFile = join(JOB_CACHE_DIR, `${pipelineId}.json`);
  
  if (!existsSync(cacheFile)) {
    return null;
  }

  try {
    const content = readFileSync(cacheFile, 'utf8');
    const cacheEntry: CacheEntry<GitLabJob[]> = JSON.parse(content);
    
    // Verify the pipeline is still in a complete state
    if (isPipelineComplete(cacheEntry.pipelineStatus)) {
      return cacheEntry.data;
    }
    
    return null;
  } catch (error) {
    console.warn(`⚠️  Could not read job cache for pipeline ${pipelineId}: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}

/**
 * Cache GraphQL raw response for a pipeline
 */
export function cacheGraphQLMetadata(
  pipelineId: number,
  pipelineStatus: string,
  response: GraphQLResponse
): void {
  if (!isPipelineComplete(pipelineStatus)) {
    return; // Only cache metadata for completed pipelines
  }

  ensureCacheDirectories();

  const cacheEntry: CacheEntry<GraphQLResponse> = {
    data: response,
    cachedAt: new Date().toISOString(),
    pipelineStatus,
  };

  const cacheFile = join(GRAPHQL_CACHE_DIR, `${pipelineId}.json`);
  writeFileSync(cacheFile, JSON.stringify(cacheEntry, null, 2));
}

/**
 * Get cached GraphQL raw response for a pipeline
 */
export function getCachedGraphQLMetadata(pipelineId: number): GraphQLResponse | null {
  const cacheFile = join(GRAPHQL_CACHE_DIR, `${pipelineId}.json`);
  
  if (!existsSync(cacheFile)) {
    return null;
  }

  try {
    const content = readFileSync(cacheFile, 'utf8');
    const cacheEntry: CacheEntry<GraphQLResponse> = JSON.parse(content);
    
    // Verify the pipeline is still in a complete state
    if (isPipelineComplete(cacheEntry.pipelineStatus)) {
      return cacheEntry.data;
    }
    
    return null;
  } catch (error) {
    console.warn(`⚠️  Could not read GraphQL cache for pipeline ${pipelineId}: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}
