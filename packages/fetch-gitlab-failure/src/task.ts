/**
 * Failure fetch task — implements FetchTask<FailureFetchResult>.
 *
 * Finds failed pipelines from the last N days, fetches their failed jobs
 * (including from downstream/child pipelines), downloads job logs, and
 * parses failure reasons via regex patterns.
 */

import type { Transport, ApiCache } from '@gitlab-analysis/gitlab-api';
import {
  fetchPipelineList,
  fetchJobLog,
  collectJobsFromPipelineTree,
  apiMetrics,
} from '@gitlab-analysis/gitlab-api';
import type { JobWithPipelineContext } from '@gitlab-analysis/gitlab-api';
import type { FetchTask, TaskContext } from '@gitlab-analysis/fetcher-core';
import type { FailureFetchResult, FailedJobInfo } from './types.js';
import { parseFailureReasons, extractLogExcerpt } from './logParser.js';

/** Always cache — failed job logs won't change */
function alwaysCache() {
  return { shouldCache: () => true };
}

export interface FailureTaskOptions {
  projectPath: string;
  daysBack: number;
  transport: Transport;
  cache: ApiCache;
  cacheNamespace: string;
}

export class FailureFetchTask implements FetchTask<FailureFetchResult> {
  name = 'GitLab Failure Analyzer';
  description: string;

  private readonly opts: FailureTaskOptions;

  constructor(opts: FailureTaskOptions) {
    this.opts = opts;
    this.description = `Project: ${opts.projectPath} • Last ${opts.daysBack} days`;
  }

  async run(context: TaskContext): Promise<FailureFetchResult> {
    const { projectPath, daysBack, transport, cache, cacheNamespace } = this.opts;

    cache.ensureDirectory();

    const now = new Date();
    const dateThreshold = new Date();
    dateThreshold.setDate(dateThreshold.getDate() - daysBack);
    const createdAfterISO = dateThreshold.toISOString();

    // ── Phase 1: Fetch pipeline list ───────────────────────────────────────
    context.updatePhase('Fetching pipeline list');
    const allPipelines = await fetchPipelineList(
      transport, cache, cacheNamespace, projectPath, createdAfterISO,
    );
    context.log('info', `Found ${allPipelines.length} total pipelines in last ${daysBack} days`);
    context.setDetail('Total Pipelines', allPipelines.length);

    // ── Phase 2: Walk all pipeline trees and collect jobs ────────────
    // Collect all jobs to get success/failure statistics, then filter for analysis.
    // Jobs can exist in any pipeline (retries, allow_failure, child pipelines)
    // so we traverse each pipeline tree including downstream children.
    context.updatePhase('Scanning pipelines for jobs');
    context.updateProgress(0, allPipelines.length);

    const allJobs: JobWithPipelineContext[] = [];
    const allFailedJobs: JobWithPipelineContext[] = [];
    let pipelinesWithFailedJobs = 0;
    const concurrency = 5;
    let pipelineIndex = 0;

    while (pipelineIndex < allPipelines.length) {
      const batch = allPipelines.slice(pipelineIndex, pipelineIndex + concurrency);

      if (batch.length > 0) {
        context.setCurrentItem(`Pipeline #${batch[0].iid} - ${batch[0].ref}`);
      }

      const results = await Promise.allSettled(
        batch.map(async (pipeline) => {
          return collectJobsFromPipelineTree(
            transport, cache, cacheNamespace, projectPath, pipeline, {
              apiOptions: alwaysCache(),
              callbacks: {
                onProgress: (msg) => context.log('info', msg),
              },
            },
          );
        }),
      );

      for (const result of results) {
        if (result.status === 'fulfilled') {
          const jobs = result.value;
          allJobs.push(...jobs);
          const failedInPipeline = jobs.filter(j => j.job.status === 'failed');
          if (failedInPipeline.length > 0) {
            allFailedJobs.push(...failedInPipeline);
            pipelinesWithFailedJobs++;
          }
        } else if (result.status === 'rejected') {
          context.log('error', `Failed to scan pipeline: ${result.reason}`);
        }
      }

      pipelineIndex += concurrency;
      context.updateProgress(Math.min(pipelineIndex, allPipelines.length), allPipelines.length);
      context.setDetail('Pipelines w/ Failures', pipelinesWithFailedJobs);
      context.setDetail('Total Jobs', allJobs.length);
      context.setDetail('Failed Jobs', allFailedJobs.length);
      context.reportApiMetrics(apiMetrics.getSummary());
    }

    const successfulJobs = allJobs.filter(j => j.job.status === 'success').length;
    context.log('info', `Found ${allJobs.length} total jobs: ${successfulJobs} successful, ${allFailedJobs.length} failed (across ${pipelinesWithFailedJobs}/${allPipelines.length} pipelines)`);
    context.setDetail('Successful Jobs', successfulJobs);
    context.setDetail('Total Jobs', allJobs.length);
    context.setDetail('Failed Jobs', allFailedJobs.length);

    // ── Phase 3: Fetch logs & parse ────────────────────────────────────────
    context.updatePhase('Fetching logs & parsing failures');
    context.updateProgress(0, allFailedJobs.length);

    const failedJobInfos: FailedJobInfo[] = [];
    let jobIndex = 0;

    while (jobIndex < allFailedJobs.length) {
      const batch = allFailedJobs.slice(jobIndex, jobIndex + concurrency);

      if (batch.length > 0) {
        context.setCurrentItem(`Job: ${batch[0].job.name} (#${batch[0].job.id})`);
      }

      const results = await Promise.allSettled(
        batch.map(async ({ job, pipeline }) => {
          let logText = '';
          try {
            const { data } = await fetchJobLog(
              transport, cache, cacheNamespace, projectPath, job.id, alwaysCache(),
            );
            logText = data;
          } catch (err) {
            context.log('warning', `Could not fetch log for job #${job.id} (${job.name}): ${err}`);
          }

          const failures = parseFailureReasons(logText);
          const rawLogExcerpt = logText ? extractLogExcerpt(logText, failures) : '';

          const info: FailedJobInfo = {
            jobId: job.id,
            jobName: job.name,
            stage: job.stage,
            status: job.status,
            allowFailure: job.allow_failure,
            duration: job.duration ?? null,
            queuedDuration: job.queued_duration ?? null,
            startedAt: job.started_at,
            finishedAt: job.finished_at,
            webUrl: job.web_url,
            runner: job.runner ? { id: job.runner.id, description: job.runner.description } : null,
            pipelineId: pipeline.id,
            pipelineIid: pipeline.iid,
            pipelineRef: pipeline.ref,
            pipelineSource: pipeline.source,
            pipelineUrl: pipeline.web_url,
            pipelineCreatedAt: pipeline.created_at,
            failures,
            rawLogExcerpt,
          };

          return info;
        }),
      );

      for (const result of results) {
        if (result.status === 'fulfilled') {
          failedJobInfos.push(result.value);
        } else {
          context.log('error', `Failed to process job: ${result.reason}`);
        }
      }

      jobIndex += concurrency;
      context.updateProgress(Math.min(jobIndex, allFailedJobs.length), allFailedJobs.length);
      context.reportApiMetrics(apiMetrics.getSummary());
    }

    context.setDetail('Parsed Jobs', failedJobInfos.length);
    
    // ── Calculate daily statistics ─────────────────────────────────────────
    const dailyStatsMap = new Map<string, { total: number; successful: number; failed: number }>();
    
    for (const { job, pipeline } of allJobs) {
      const date = pipeline.created_at.slice(0, 10); // YYYY-MM-DD
      if (!dailyStatsMap.has(date)) {
        dailyStatsMap.set(date, { total: 0, successful: 0, failed: 0 });
      }
      const stats = dailyStatsMap.get(date)!;
      stats.total++;
      if (job.status === 'success') {
        stats.successful++;
      } else if (job.status === 'failed') {
        stats.failed++;
      }
    }
    
    const dailyStats = [...dailyStatsMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, stats]) => ({
        date,
        totalJobs: stats.total,
        successfulJobs: stats.successful,
        failedJobs: stats.failed,
      }));

    context.updatePhase('Complete');

    return {
      jobs: failedJobInfos,
      metadata: {
        projectPath,
        daysBack,
        scannedPipelines: allPipelines.length,
        failedPipelines: pipelinesWithFailedJobs,
        failedJobs: failedJobInfos.length,
        successfulJobs,
        totalJobs: allJobs.length,
        dailyStats,
        fetchedAt: now.toISOString(),
        timeRange: {
          from: createdAfterISO,
          to: now.toISOString(),
        },
      },
    };
  }
}
