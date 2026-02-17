/**
 * Job logs fetch task — skeleton implementation.
 * 
 * TODO: Implement the actual fetching logic. This will:
 * 1. Fetch pipeline list (reuses fetchPipelineList from gitlab-api)
 * 2. For each pipeline, fetch jobs (reuses fetchPipelineJobs from gitlab-api)
 * 3. For matching jobs, fetch logs (uses fetchJobLog from gitlab-api)
 * 4. Produce a JobLogsFetchResult with a different structure than pipeline data
 * 
 * The key point: this reuses the same gitlab-api package and shared cache,
 * so pipeline/job API calls that were already cached by fetch-pipelines
 * will be cache hits here too.
 */

import type { Transport, ApiCache } from '@gitlab-analysis/gitlab-api';
import type { FetchTask, TaskContext } from '@gitlab-analysis/fetcher-core';
import type { JobLogsFetchResult } from './types.js';

export interface JobLogsTaskOptions {
  projectPath: string;
  daysBack: number;
  /** Optional: only fetch logs for jobs matching this name pattern */
  jobNameFilter?: string;
  transport: Transport;
  cache: ApiCache;
  cacheNamespace: string;
}

export class JobLogsFetchTask implements FetchTask<JobLogsFetchResult> {
  name = 'GitLab Job Logs Fetcher';
  description: string;

  private readonly opts: JobLogsTaskOptions;

  constructor(opts: JobLogsTaskOptions) {
    this.opts = opts;
    this.description = `Project: ${opts.projectPath} • Last ${opts.daysBack} days`;
    if (opts.jobNameFilter) {
      this.description += ` • Filter: ${opts.jobNameFilter}`;
    }
  }

  async run(context: TaskContext): Promise<JobLogsFetchResult> {
    context.updatePhase('Not yet implemented');
    context.log('warning', 'Job logs fetching is not yet implemented. This is a skeleton entry point.');
    context.updatePhase('Complete');

    return {
      jobs: [],
      pipelines_scanned: 0,
      total_jobs: 0,
      total_logs_fetched: 0,
      metadata: {
        project: this.opts.projectPath,
        fetched_at: new Date().toISOString(),
        days_back: this.opts.daysBack,
        job_name_filter: this.opts.jobNameFilter,
      },
    };
  }
}
