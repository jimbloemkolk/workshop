/**
 * Pipeline fetch task — implements FetchTask<PipelineFetchResult>.
 * 
 * Contains all the pipeline-specific orchestration logic:
 * - Fetching pipeline lists
 * - Loading existing pipelines from disk
 * - Fetching pipeline details, jobs, GraphQL metadata, children (recursively)
 * - Enriching with transformer
 * - Producing the final PipelineFetchResult
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { Transport, GitLabPipelineBasic, GitLabJob, ApiCache } from '@gitlab-analysis/gitlab-api';
import {
  fetchPipelineList,
  fetchPipelineBasic,
  fetchPipelineJobs,
  fetchDownstreamPipelines,
  fetchJobDependenciesGraphQL,
  apiMetrics,
} from '@gitlab-analysis/gitlab-api';
import type { FetchTask, TaskContext } from '@gitlab-analysis/fetcher-core';
import type {
  GitLabPipelineFull,
  PipelineFetchResult,
  FailedPipeline,
  CacheStats,
} from './types.js';
import { parseJobDependenciesFromGraphQL, enrichJobsWithMetadata } from './transformer.js';

/** Check if a pipeline has a terminal status (safe to cache) */
function isPipelineComplete(status: string): boolean {
  return ['success', 'failed', 'canceled', 'skipped'].includes(status);
}

/** ApiCallOptions that caches only completed pipelines */
function cacheIfComplete() {
  return {
    shouldCache: (data: any) => {
      const status = data?.status ?? data?.[0]?.status;
      return status ? isPipelineComplete(status) : false;
    },
  };
}

/** ApiCallOptions that always caches */
function alwaysCache() {
  return { shouldCache: () => true };
}

export interface PipelineTaskOptions {
  projectPath: string;
  daysBack: number;
  datasetName: string;
  dataDir: string;
  rebuild?: boolean;
  transport: Transport;
  cache: ApiCache;
  cacheNamespace: string;
}

export class PipelineFetchTask implements FetchTask<PipelineFetchResult> {
  name: string;
  description: string;

  private readonly opts: PipelineTaskOptions;

  constructor(opts: PipelineTaskOptions) {
    this.opts = opts;
    this.name = 'GitLab Pipeline Fetcher';
    this.description = `Project: ${opts.projectPath} • Last ${opts.daysBack} days`;
  }

  async run(context: TaskContext): Promise<PipelineFetchResult> {
    const { projectPath, daysBack, datasetName, dataDir, rebuild, transport, cache, cacheNamespace } = this.opts;

    cache.ensureDirectory();

    // Phase 1: Load existing pipelines
    context.updatePhase('Loading existing data');
    const existingPipelines = rebuild ? [] : this.loadExistingPipelines(dataDir);
    const existingPipelineIds = new Set(existingPipelines.map((p) => p.id));
    context.setDetail('Existing', existingPipelines.length);

    if (rebuild) {
      context.log('info', 'Rebuild mode: ignoring existing pipeline data');
    }

    // Phase 2: Fetch pipeline list
    context.updatePhase('Fetching pipeline list');
    const dateThreshold = new Date();
    dateThreshold.setDate(dateThreshold.getDate() - daysBack);
    const dateThresholdStr = dateThreshold.toISOString().slice(0, 10);
    const updatedAfterISO = dateThreshold.toISOString();

    const allPipelines = await fetchPipelineList(
      transport, cache, cacheNamespace, projectPath, updatedAfterISO
    );

    // Filter out already-fetched
    const filteredPipelines = allPipelines.filter((p) => !existingPipelineIds.has(p.id));
    context.log('info', `Found ${filteredPipelines.length} new pipelines (${allPipelines.length - filteredPipelines.length} already exist)`);

    // Phase 3: Process pipelines
    context.updatePhase('Processing pipelines');
    context.updateProgress(0, filteredPipelines.length);

    const detailedPipelines: GitLabPipelineFull[] = [];
    const failedPipelines: FailedPipeline[] = [];
    const concurrency = 5;

    let index = 0;
    while (index < filteredPipelines.length) {
      const batch = filteredPipelines
        .slice(index, index + concurrency)
        .map((p, i) => [index + i, p] as [number, GitLabPipelineBasic]);

      if (batch.length > 0) {
        context.setCurrentItem(`#${batch[0][1].id} - ${batch[0][1].ref}`);
      }

      const { successful, failed, cacheStats } = await this.fetchPipelinesBatch(
        batch,
        filteredPipelines.length,
        transport,
        cache,
        cacheNamespace,
      );

      detailedPipelines.push(...successful);
      failedPipelines.push(...failed);

      // Update stats
      context.updateProgress(detailedPipelines.length + failedPipelines.length, filteredPipelines.length);
      context.setDetail('New Pipelines', detailedPipelines.length);
      context.setDetail('Failed', failedPipelines.length);
      context.reportApiMetrics(apiMetrics.getSummary());

      // Track cache hits
      if (cacheStats.cachedPipelines > 0) context.incrementDetail('Cached Pipelines', cacheStats.cachedPipelines);
      if (cacheStats.cachedJobs > 0) context.incrementDetail('Cached Jobs', cacheStats.cachedJobs);
      if (cacheStats.cachedGraphQL > 0) context.incrementDetail('Cached GraphQL', cacheStats.cachedGraphQL);

      for (const fp of failed) {
        context.log('error', `Pipeline #${fp.pipelineId} (${fp.pipelineRef}): ${fp.error}`);
      }

      index += concurrency;
    }

    // Merge with existing
    const allPipelinesData = [...existingPipelines, ...detailedPipelines];
    context.setDetail('Total Pipelines', allPipelinesData.length);

    const metadata = {
      dataset_name: datasetName,
      project: projectPath,
      fetched_at: new Date().toISOString(),
      days_back: daysBack,
      date_threshold: dateThresholdStr,
      pipeline_count: allPipelinesData.length,
      new_pipelines: detailedPipelines.length,
      existing_pipelines: existingPipelines.length,
      failed_pipelines: failedPipelines.length,
      cached_pipelines: 0,
      failed_pipeline_details: failedPipelines,
    };

    context.updatePhase('Complete');

    return {
      pipelines: allPipelinesData,
      failed: failedPipelines,
      metadata,
    };
  }

  // ─── Private helpers ─────────────────────────────────────────────────────

  private loadExistingPipelines(dataDir: string): GitLabPipelineFull[] {
    const pipelinesFile = join(dataDir, 'pipelines.json');
    if (!existsSync(pipelinesFile)) return [];

    try {
      const content = readFileSync(pipelinesFile, 'utf8');
      return JSON.parse(content);
    } catch {
      return [];
    }
  }

  private async fetchPipelineWithDetails(
    transport: Transport,
    cache: ApiCache,
    cacheNamespace: string,
    pipeline: GitLabPipelineBasic,
    index: number,
    total: number,
    depth: number = 0,
    parentJobMetadataMap?: Map<number, any>,
  ): Promise<{ pipeline: GitLabPipelineFull; cacheStats: CacheStats }> {
    const cacheStats: CacheStats = { pipeline: false, jobs: false, graphql: false };
    const { projectPath } = this.opts;

    // Fetch pipeline details
    let fullPipelineData: any;
    try {
      const { data: apiData, fromCache } = await fetchPipelineBasic(
        transport, cache, cacheNamespace, projectPath, pipeline.id, cacheIfComplete()
      );
      if (fromCache) cacheStats.pipeline = true;
      fullPipelineData = {
        ...apiData,
        trigger_job: (pipeline as any).trigger_job,
      };
    } catch {
      fullPipelineData = pipeline;
    }

    // Fetch jobs
    let jobs: GitLabJob[];
    try {
      const { data, fromCache } = await fetchPipelineJobs(
        transport, cache, cacheNamespace, projectPath, pipeline.id, cacheIfComplete()
      );
      jobs = data;
      if (fromCache) cacheStats.jobs = true;
    } catch (error) {
      throw new Error(
        `Failed to fetch jobs for pipeline #${pipeline.id}: ${error instanceof Error ? error.message : error}`
      );
    }

    const jobMap = new Map<number, GitLabJob>();
    jobs.forEach((job) => jobMap.set(job.id, job));

    // Fetch or reuse GraphQL metadata
    let jobMetadataMap: Map<number, any>;
    if (parentJobMetadataMap) {
      jobMetadataMap = parentJobMetadataMap;
      cacheStats.graphql = true;
    } else {
      const { data: graphQLResponse, fromCache } = await fetchJobDependenciesGraphQL(
        transport, cache, cacheNamespace, projectPath, pipeline.id, cacheIfComplete()
      );
      if (fromCache) cacheStats.graphql = true;
      jobMetadataMap = parseJobDependenciesFromGraphQL(graphQLResponse);
    }

    // Fetch child pipelines
    let downstreamPipelines: GitLabPipelineBasic[] = [];
    try {
      downstreamPipelines = await fetchDownstreamPipelines(
        transport, cache, cacheNamespace, projectPath, pipeline.id, cacheIfComplete()
      );
    } catch {
      // Swallow — same as original
    }

    let enrichedChildren: GitLabPipelineFull[] = [];
    if (downstreamPipelines.length > 0) {
      const childResults = await Promise.allSettled(
        downstreamPipelines.map((childPipeline, idx) =>
          this.fetchPipelineWithDetails(
            transport, cache, cacheNamespace, childPipeline, idx, downstreamPipelines.length,
            depth + 1, jobMetadataMap
          )
        )
      );

      childResults.forEach((result) => {
        if (result.status === 'fulfilled') {
          enrichedChildren.push(result.value.pipeline);
        }
      });
    }

    const enrichedPipeline: GitLabPipelineFull = {
      ...fullPipelineData,
      jobs,
      child_pipelines: enrichedChildren,
      fetched_at: new Date().toISOString(),
    };

    await enrichJobsWithMetadata(enrichedPipeline, jobMap, jobMetadataMap, projectPath, depth, true);

    return { pipeline: enrichedPipeline, cacheStats };
  }

  private async fetchPipelinesBatch(
    batch: Array<[number, GitLabPipelineBasic]>,
    totalPipelines: number,
    transport: Transport,
    cache: ApiCache,
    cacheNamespace: string,
  ): Promise<{
    successful: GitLabPipelineFull[];
    failed: FailedPipeline[];
    cacheStats: { cachedPipelines: number; cachedJobs: number; cachedGraphQL: number };
  }> {
    const results = await Promise.allSettled(
      batch.map(async ([i, pipeline]) => {
        return this.fetchPipelineWithDetails(transport, cache, cacheNamespace, pipeline, i, totalPipelines);
      })
    );

    const successful: GitLabPipelineFull[] = [];
    const failed: FailedPipeline[] = [];
    let cachedPipelines = 0;
    let cachedJobs = 0;
    let cachedGraphQL = 0;

    results.forEach((result, idx) => {
      const [, pipeline] = batch[idx];
      if (result.status === 'fulfilled') {
        successful.push(result.value.pipeline);
        const { cacheStats } = result.value;
        if (cacheStats.pipeline) cachedPipelines++;
        if (cacheStats.jobs) cachedJobs++;
        if (cacheStats.graphql) cachedGraphQL++;
      } else {
        failed.push({
          pipelineId: pipeline.id,
          pipelineIid: pipeline.iid,
          pipelineRef: pipeline.ref,
          error: result.reason?.message || String(result.reason),
        });
      }
    });

    return { successful, failed, cacheStats: { cachedPipelines, cachedJobs, cachedGraphQL } };
  }
}
