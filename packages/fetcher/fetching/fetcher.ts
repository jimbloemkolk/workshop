import type {
  GitLabPipelineBasic,
  GitLabPipelineFull,
  GitLabJob,
  FailedPipeline,
} from './types.js';
import { fetchDownstreamPipelines } from './gitlabClient.js';
import {
  fetchPipelineBasicCached,
  fetchPipelineJobsCached,
  fetchJobDependenciesGraphQLCached,
} from './cachedGitlabClient.js';
import { enrichJobsWithMetadata, parseJobDependenciesFromGraphQL } from './transformer.js';

export interface CacheStats {
  pipeline: boolean;
  jobs: boolean;
  graphql: boolean;
}

/**
 * Fetch a single pipeline with all details, using cache when available for raw API data
 */
export async function fetchPipelineWithDetails(
  projectPath: string,
  pipeline: GitLabPipelineBasic,
  index: number,
  total: number,
  depth: number = 0,
  parentJobMetadataMap?: Map<number, any>,
  silent: boolean = false
): Promise<{ pipeline: GitLabPipelineFull; cacheStats: CacheStats }> {
  const indent = '  '.repeat(depth);
  const log = (msg: string) => {
    if (!silent) console.log(msg);
  };
  
  log(
    `${indent}Processing pipeline ${index + 1}/${total}: #${pipeline.id} (${pipeline.status})`
  );

  const cacheStats: CacheStats = {
    pipeline: false,
    jobs: false,
    graphql: false,
  };

  // Fetch full pipeline details (includes duration and other metadata)
  log(`${indent}  Fetching pipeline details for ${pipeline.id}...`);
  let fullPipelineData: any;
  try {
    const { data: apiPipelineData, fromCache: pipelineFromCache } = await fetchPipelineBasicCached(
      projectPath,
      pipeline.id,
      pipeline.status
    );
    if (pipelineFromCache) {
      log(`${indent}  ✓ Using cached pipeline details`);
      cacheStats.pipeline = true;
    }
    log(`${indent}  Got pipeline details (duration: ${apiPipelineData.duration}s)`);
    // Merge API data with our pipeline object, preserving trigger_job
    fullPipelineData = {
      ...apiPipelineData,
      trigger_job: (pipeline as any).trigger_job, // Preserve trigger_job from downstream fetch
    };
  } catch (error) {
    console.warn(
      `${indent}  ⚠️  Could not fetch pipeline details: ${error instanceof Error ? error.message : error}`
    );
    fullPipelineData = pipeline;
  }

  // Fetch jobs - check cache first
  log(`${indent}  Fetching jobs for pipeline ${pipeline.id}...`);
  let jobs: GitLabJob[];
  try {
    const { data, fromCache: jobsFromCache } = await fetchPipelineJobsCached(
      projectPath,
      pipeline.id,
      pipeline.status
    );
    jobs = data;
    
    if (jobsFromCache) {
      log(`${indent}  ✓ Using cached jobs (${jobs.length} jobs)`);
      cacheStats.jobs = true;
    } else {
      log(`${indent}  Found ${jobs.length} jobs`);
    }
  } catch (error) {
    console.error(`${indent}  ❌ Error fetching jobs for pipeline #${pipeline.id}:`);
    console.error(
      `${indent}     Message: ${error instanceof Error ? error.message : error}`
    );
    throw new Error(
      `Failed to fetch jobs for pipeline #${pipeline.id}: ${error instanceof Error ? error.message : error}`
    );
  }

  // Build jobMap
  const jobMap = new Map<number, GitLabJob>();
  jobs.forEach((job) => jobMap.set(job.id, job));

  // Fetch or reuse GraphQL metadata
  let jobMetadataMap: Map<number, any>;
  
  if (parentJobMetadataMap) {
    // Child pipeline: reuse parent's GraphQL metadata (it includes child pipeline jobs)
    log(`${indent}  ✓ Using parent's GraphQL metadata`);
    jobMetadataMap = parentJobMetadataMap;
    cacheStats.graphql = true;
  } else {
    // Root pipeline: fetch GraphQL metadata
    log(`${indent}  Fetching GraphQL data...`);
    
    const { data: graphQLResponse, fromCache: graphQLFromCache } = await fetchJobDependenciesGraphQLCached(
      projectPath,
      pipeline.id,
      pipeline.status
    );
    
    if (graphQLFromCache) {
      log(`${indent}  ✓ Using cached GraphQL response`);
      cacheStats.graphql = true;
    }
    
    // Parse the response (transformation step)
    jobMetadataMap = parseJobDependenciesFromGraphQL(graphQLResponse);
    log(`${indent}  Parsed ${jobMetadataMap.size} job metadata entries`);
  }

  // Fetch downstream (child) pipelines
  log(`${indent}  Checking for child pipelines...`);
  let downstreamPipelines: GitLabPipelineBasic[] = [];
  try {
    downstreamPipelines = await fetchDownstreamPipelines(projectPath, pipeline.id);
  } catch (error) {
    console.warn(
      `${indent}  ⚠️  Error fetching child pipelines: ${error instanceof Error ? error.message : error}`
    );
  }

  let enrichedChildren: GitLabPipelineFull[] = [];
  if (downstreamPipelines.length > 0) {
    log(`${indent}  Found ${downstreamPipelines.length} child pipeline(s)`);

    // Recursively fetch child pipelines, passing the parent's jobMetadataMap
    const childResults = await Promise.allSettled(
      downstreamPipelines.map((childPipeline, idx) =>
        fetchPipelineWithDetails(
          projectPath,
          childPipeline,
          idx,
          downstreamPipelines.length,
          depth + 1,
          jobMetadataMap, // Pass parent's metadata to children
          silent
        )
      )
    );

    childResults.forEach((result, idx) => {
      if (result.status === 'fulfilled') {
        enrichedChildren.push(result.value.pipeline);
      } else {
        console.error(
          `${indent}  ❌ Failed to fetch child pipeline #${downstreamPipelines[idx].id}: ${result.reason?.message || result.reason}`
        );
      }
    });
  }

  // Construct the full pipeline object (before enrichment)
  const enrichedPipeline: GitLabPipelineFull = {
    ...fullPipelineData,
    jobs: jobs,
    child_pipelines: enrichedChildren,
    fetched_at: new Date().toISOString(),
  };

  // Enrich with GraphQL metadata (transformation step - never cached)
  await enrichJobsWithMetadata(enrichedPipeline, jobMap, jobMetadataMap, projectPath, depth, silent);

  return { pipeline: enrichedPipeline, cacheStats };
}

/**
 * Fetch a batch of pipelines concurrently
 */
export async function fetchPipelinesBatch(
  projectPath: string,
  batch: Array<[number, GitLabPipelineBasic]>,
  totalPipelines: number,
  silent: boolean = false
): Promise<{
  successful: GitLabPipelineFull[];
  failed: FailedPipeline[];
  cached: number;
  cachedPipelines: number;
  cachedJobs: number;
  cachedGraphQL: number;
}> {
  const results = await Promise.allSettled(
    batch.map(async ([i, pipeline]) => {
      const result = await fetchPipelineWithDetails(projectPath, pipeline, i, totalPipelines, 0, undefined, silent);
      return result;
    })
  );

  // Separate successful and failed results
  const successful: GitLabPipelineFull[] = [];
  const failed: FailedPipeline[] = [];
  let cachedCount = 0;
  let cachedPipelinesCount = 0;
  let cachedJobsCount = 0;
  let cachedGraphQLCount = 0;

  results.forEach((result, idx) => {
    const [, pipeline] = batch[idx];
    if (result.status === 'fulfilled') {
      successful.push(result.value.pipeline);
      const { cacheStats } = result.value;
      
      // Count as fully cached only if all components are cached
      if (cacheStats.pipeline && cacheStats.jobs && cacheStats.graphql) {
        cachedCount++;
      }
      
      // Track individual cache hits
      if (cacheStats.pipeline) cachedPipelinesCount++;
      if (cacheStats.jobs) cachedJobsCount++;
      if (cacheStats.graphql) cachedGraphQLCount++;
    } else {
      failed.push({
        pipelineId: pipeline.id,
        pipelineIid: pipeline.iid,
        pipelineRef: pipeline.ref,
        error: result.reason?.message || String(result.reason),
      });
      console.error(
        `\n❌ Failed to fetch pipeline #${pipeline.id} (${pipeline.ref}): ${result.reason?.message || result.reason}`
      );
      if (result.reason?.stack) {
        console.error(`   Stack: ${result.reason.stack}`);
      }
    }
  });

  return { 
    successful, 
    failed, 
    cached: cachedCount, 
    cachedPipelines: cachedPipelinesCount,
    cachedJobs: cachedJobsCount, 
    cachedGraphQL: cachedGraphQLCount 
  };
}
