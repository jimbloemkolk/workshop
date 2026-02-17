/**
 * Pipeline-specific types for the fetch-pipelines entry point.
 */

import type {
  GitLabPipelineBasic,
  GitLabJob,
  TriggerJob,
  JobMetadata,
} from '@gitlab-analysis/gitlab-api';

/**
 * A fully-fetched pipeline with jobs, child pipelines, and enriched metadata.
 */
export interface GitLabPipelineFull extends GitLabPipelineBasic {
  jobs: GitLabJob[];
  child_pipelines?: GitLabPipelineFull[];
  trigger_job?: TriggerJob;
  fetched_at: string;
}

export interface FailedPipeline {
  pipelineId: number;
  pipelineIid: number;
  pipelineRef: string;
  error: string;
}

/**
 * The result of a pipeline fetch task.
 */
export interface PipelineFetchResult {
  pipelines: GitLabPipelineFull[];
  failed: FailedPipeline[];
  metadata: PipelineMetadata;
}

export interface PipelineMetadata {
  dataset_name: string;
  project: string;
  fetched_at: string;
  days_back: number;
  date_threshold: string;
  pipeline_count: number;
  new_pipelines: number;
  existing_pipelines: number;
  failed_pipelines: number;
  cached_pipelines: number;
  failed_pipeline_details: FailedPipeline[];
}

export interface CacheStats {
  pipeline: boolean;
  jobs: boolean;
  graphql: boolean;
}

export { type JobMetadata };
