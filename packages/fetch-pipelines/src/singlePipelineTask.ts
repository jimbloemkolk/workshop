/**
 * Single pipeline fetch task — fetches one pipeline by ID.
 * 
 * Used when --pipeline-id is specified. Simpler than the multi-pipeline
 * task: no list fetching, no merging with existing data, no batching.
 */

import type { Transport, ApiCache, GitLabJob } from '@gitlab-analysis/gitlab-api';
import {
  fetchPipelineBasic,
  fetchPipelineJobs,
  fetchDownstreamPipelines,
  fetchJobDependenciesGraphQL,
} from '@gitlab-analysis/gitlab-api';
import type { FetchTask, TaskContext } from '@gitlab-analysis/fetcher-core';
import type { GitLabPipelineFull, PipelineFetchResult } from './types.js';
import { parseJobDependenciesFromGraphQL, enrichJobsWithMetadata } from './transformer.js';

function isPipelineComplete(status: string): boolean {
  return ['success', 'failed', 'canceled', 'skipped'].includes(status);
}

function cacheIfComplete() {
  return {
    shouldCache: (data: any) => {
      const status = data?.status ?? data?.[0]?.status;
      return status ? isPipelineComplete(status) : false;
    },
  };
}

export interface SinglePipelineTaskOptions {
  projectPath: string;
  pipelineId: number;
  transport: Transport;
  cache: ApiCache;
  cacheNamespace: string;
}

export class SinglePipelineFetchTask implements FetchTask<PipelineFetchResult> {
  name = 'GitLab Pipeline Fetcher (Single)';
  description: string;

  private readonly opts: SinglePipelineTaskOptions;

  constructor(opts: SinglePipelineTaskOptions) {
    this.opts = opts;
    this.description = `Pipeline #${opts.pipelineId}`;
  }

  async run(context: TaskContext): Promise<PipelineFetchResult> {
    const { projectPath, pipelineId, transport, cache, cacheNamespace } = this.opts;

    context.updatePhase(`Fetching pipeline #${pipelineId}`);
    context.updateProgress(0, 1);

    // Fetch pipeline basic info
    const { data: pipeline } = await fetchPipelineBasic(
      transport, cache, cacheNamespace, projectPath, pipelineId, cacheIfComplete()
    );

    // Fetch full details recursively
    const enrichedPipeline = await this.fetchWithDetails(
      transport, cache, cacheNamespace, projectPath, pipeline
    );

    context.updateProgress(1, 1);
    context.updatePhase('Complete');
    context.log('success', `Fetched pipeline #${pipelineId} with ${enrichedPipeline.jobs.length} jobs`);

    return {
      pipelines: [enrichedPipeline],
      failed: [],
      metadata: {
        dataset_name: '',
        project: projectPath,
        fetched_at: new Date().toISOString(),
        days_back: 0,
        date_threshold: '',
        pipeline_count: 1,
        new_pipelines: 1,
        existing_pipelines: 0,
        failed_pipelines: 0,
        cached_pipelines: 0,
        failed_pipeline_details: [],
      },
    };
  }

  private async fetchWithDetails(
    transport: Transport,
    cache: ApiCache,
    cacheNamespace: string,
    projectPath: string,
    pipeline: any,
    depth: number = 0,
    parentJobMetadataMap?: Map<number, any>,
  ): Promise<GitLabPipelineFull> {
    // Jobs
    const { data: jobs } = await fetchPipelineJobs(
      transport, cache, cacheNamespace, projectPath, pipeline.id, cacheIfComplete()
    );

    const jobMap = new Map<number, GitLabJob>();
    jobs.forEach((job) => jobMap.set(job.id, job));

    // GraphQL
    let jobMetadataMap: Map<number, any>;
    if (parentJobMetadataMap) {
      jobMetadataMap = parentJobMetadataMap;
    } else {
      const { data: graphQLResponse } = await fetchJobDependenciesGraphQL(
        transport, cache, cacheNamespace, projectPath, pipeline.id, cacheIfComplete()
      );
      jobMetadataMap = parseJobDependenciesFromGraphQL(graphQLResponse);
    }

    // Children
    const downstreamPipelines = await fetchDownstreamPipelines(
      transport, cache, cacheNamespace, projectPath, pipeline.id, cacheIfComplete()
    );

    const enrichedChildren: GitLabPipelineFull[] = [];
    for (const child of downstreamPipelines) {
      try {
        const enrichedChild = await this.fetchWithDetails(
          transport, cache, cacheNamespace, projectPath, child, depth + 1, jobMetadataMap
        );
        enrichedChildren.push(enrichedChild);
      } catch {
        // Skip failed children
      }
    }

    const enrichedPipeline: GitLabPipelineFull = {
      ...pipeline,
      jobs,
      child_pipelines: enrichedChildren,
      fetched_at: new Date().toISOString(),
    };

    await enrichJobsWithMetadata(enrichedPipeline, jobMap, jobMetadataMap, projectPath, depth, true);

    return enrichedPipeline;
  }
}
