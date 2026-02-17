/**
 * Types for the job-logs fetch task.
 */

import type { GitLabJob, GitLabPipelineBasic } from '@gitlab-analysis/gitlab-api';

/** A job with its log content */
export interface JobWithLog {
  job: GitLabJob;
  pipelineId: number;
  pipelineRef: string;
  log: string;
}

/** The result of a job-logs fetch task */
export interface JobLogsFetchResult {
  jobs: JobWithLog[];
  pipelines_scanned: number;
  total_jobs: number;
  total_logs_fetched: number;
  metadata: {
    project: string;
    fetched_at: string;
    days_back: number;
    job_name_filter?: string;
  };
}
