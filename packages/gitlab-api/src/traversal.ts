/**
 * Pipeline traversal utilities.
 *
 * Generic helpers for recursively walking a pipeline tree (parent → children)
 * and collecting jobs. Usable by any fetcher that needs to inspect jobs
 * across a full pipeline hierarchy.
 */

import type { Transport } from './transport.js';
import type { ApiCache } from '@workshop/fetcher-core';
import type { GitLabPipelineBasic, GitLabJob } from './types.js';
import {
  fetchPipelineJobs,
  fetchDownstreamPipelines,
  type ApiCallOptions,
} from './api.js';

// ─── Types ───────────────────────────────────────────────────────────────────

/** A job paired with the pipeline it belongs to */
export interface JobWithPipelineContext {
  job: GitLabJob;
  pipeline: GitLabPipelineBasic;
  /** 0 = root pipeline, 1 = first-level child, etc. */
  depth: number;
}

export interface TraversalCallbacks {
  /** Called when starting to process a pipeline. Return false to skip it. */
  onPipeline?: (pipeline: GitLabPipelineBasic, depth: number) => boolean | void;
  /** Filter which jobs to collect. If omitted, all jobs are collected. */
  filterJob?: (job: GitLabJob, pipeline: GitLabPipelineBasic) => boolean;
  /** Called for progress reporting */
  onProgress?: (message: string) => void;
}

export interface TraversalOptions {
  /** Max recursion depth for child pipelines (default: 3) */
  maxDepth?: number;
  /** API call options (caching, etc.) */
  apiOptions?: ApiCallOptions;
  /** Callbacks for filtering and progress */
  callbacks?: TraversalCallbacks;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Recursively collect jobs from a pipeline and all its downstream children.
 *
 * Walks the pipeline tree via the bridges endpoint. For each pipeline,
 * fetches jobs and applies the optional filter. Returns a flat array of
 * all matching jobs with their pipeline context.
 */
export async function collectJobsFromPipelineTree(
  transport: Transport,
  cache: ApiCache,
  cacheNamespace: string,
  projectPath: string,
  pipeline: GitLabPipelineBasic,
  options?: TraversalOptions,
): Promise<JobWithPipelineContext[]> {
  const maxDepth = options?.maxDepth ?? 3;
  const apiOpts = options?.apiOptions;
  const callbacks = options?.callbacks;

  const results: JobWithPipelineContext[] = [];

  async function traverse(
    p: GitLabPipelineBasic,
    depth: number,
  ): Promise<void> {
    if (depth > maxDepth) return;

    // Let caller skip pipelines
    if (callbacks?.onPipeline) {
      const shouldProcess = callbacks.onPipeline(p, depth);
      if (shouldProcess === false) return;
    }

    // Fetch jobs for this pipeline
    try {
      const { data: jobs } = await fetchPipelineJobs(
        transport, cache, cacheNamespace, projectPath, p.id, apiOpts,
      );

      for (const job of jobs) {
        const include = callbacks?.filterJob ? callbacks.filterJob(job, p) : true;
        if (include) {
          results.push({ job, pipeline: p, depth });
        }
      }
    } catch (err) {
      callbacks?.onProgress?.(
        `Warning: could not fetch jobs for pipeline #${p.id}: ${err}`,
      );
    }

    // Recurse into child pipelines
    try {
      const children = await fetchDownstreamPipelines(
        transport, cache, cacheNamespace, projectPath, p.id, apiOpts,
      );

      if (children.length > 0) {
        callbacks?.onProgress?.(
          `Pipeline #${p.iid}: found ${children.length} child pipeline(s) at depth ${depth + 1}`,
        );

        for (const child of children) {
          await traverse(child, depth + 1);
        }
      }
    } catch {
      // Bridges endpoint can fail for some pipelines — swallow
    }
  }

  await traverse(pipeline, 0);
  return results;
}
