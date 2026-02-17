/**
 * Pipeline-specific transformation logic.
 * 
 * Parses GraphQL responses into job metadata maps and enriches
 * pipeline jobs with that metadata. This is domain logic specific
 * to the pipeline fetch task.
 */

import type { GitLabJob, GraphQLResponse, JobMetadata } from '@gitlab-analysis/gitlab-api';
import type { GitLabPipelineFull } from './types.js';

/**
 * Parse GraphQL response to extract job metadata.
 */
export function parseJobDependenciesFromGraphQL(response: GraphQLResponse): Map<number, JobMetadata> {
  const jobMetadataMap = new Map<number, JobMetadata>();

  const processStages = (stages: any) => {
    if (!stages?.nodes) return;

    stages.nodes.forEach((stage: any) => {
      stage.groups?.nodes?.forEach((group: any) => {
        group.jobs?.nodes?.forEach((job: any) => {
          const numericId = job.id ? parseInt(job.id.split('/').pop()) : null;
          if (!numericId) return;

          const metadata: JobMetadata = {};

          if (job.schedulingType) {
            metadata.schedulingType = job.schedulingType;
          }

          const needs =
            job.needs?.nodes?.map((need: any) => need.name)?.filter((name: string) => name) || [];
          if (needs.length > 0) {
            metadata.needs = needs;
          }

          const previousStageJobs =
            job.previousStageJobs?.nodes
              ?.map((prevJob: any) => prevJob.name)
              ?.filter((name: string) => name) || [];
          if (previousStageJobs.length > 0) {
            metadata.previousStageJobs = previousStageJobs;
          }

          if (job.manualJob === true) {
            metadata.when = 'manual';
          }

          if (job.retried === true) {
            metadata.retried = true;
          }

          jobMetadataMap.set(numericId, metadata);
        });
      });
    });
  };

  if (response.data?.project?.pipeline) {
    const pipeline = response.data.project.pipeline;
    processStages(pipeline.stages);

    if (pipeline.downstream?.nodes) {
      pipeline.downstream.nodes.forEach((childPipeline: any) => {
        processStages(childPipeline.stages);

        if (childPipeline.downstream?.nodes) {
          childPipeline.downstream.nodes.forEach((grandchildPipeline: any) => {
            processStages(grandchildPipeline.stages);
          });
        }
      });
    }
  }

  return jobMetadataMap;
}

/**
 * Enrich jobs with GraphQL metadata.
 */
export async function enrichJobsWithMetadata(
  pipeline: GitLabPipelineFull,
  jobMap: Map<number, GitLabJob>,
  jobMetadataMap: Map<number, JobMetadata>,
  projectPath: string,
  depth: number = 0,
  silent: boolean = false
): Promise<GitLabPipelineFull> {
  const indent = '  '.repeat(depth);

  if (!silent) {
    console.log(
      `${indent}Enriching jobs for pipeline #${pipeline.id} with GraphQL metadata (${jobMetadataMap.size} entries)...`
    );
  }

  const enrichedJobs: GitLabJob[] = [];

  jobMetadataMap.forEach((metadata, jobId) => {
    const job = jobMap.get(jobId);
    if (job) {
      if (metadata.schedulingType) job.schedulingType = metadata.schedulingType;
      if (metadata.needs && metadata.needs.length > 0) job.needs = metadata.needs;
      if (metadata.previousStageJobs && metadata.previousStageJobs.length > 0) job.previousStageJobs = metadata.previousStageJobs;
      if (metadata.when) job.when = metadata.when;
      if (metadata.retried) job.retried = metadata.retried;
      enrichedJobs.push(job);
      jobMap.delete(jobId);
    }
  });

  // Process leftover jobs (likely retried)
  const leftoverJobs = Array.from(jobMap.values());

  if (leftoverJobs.length > 0) {
    if (!silent) {
      console.log(`${indent}  Found ${leftoverJobs.length} jobs not in GraphQL (checking for retries)...`);
    }
    leftoverJobs.forEach((leftoverJob) => {
      const matchingJob = enrichedJobs.find(
        (enrichedJob) =>
          enrichedJob.stage === leftoverJob.stage && enrichedJob.name === leftoverJob.name
      );

      if (matchingJob) {
        if (!silent) {
          console.log(`${indent}    Job ${leftoverJob.id} (${leftoverJob.name}) is a retry of job ${matchingJob.id}`);
        }
        if (matchingJob.schedulingType) leftoverJob.schedulingType = matchingJob.schedulingType;
        if (matchingJob.needs) leftoverJob.needs = matchingJob.needs;
        if (matchingJob.previousStageJobs) leftoverJob.previousStageJobs = matchingJob.previousStageJobs;
        if (matchingJob.when) leftoverJob.when = matchingJob.when;
        leftoverJob.retried = true;
      } else {
        if (!silent) {
          console.log(`${indent}    Job ${leftoverJob.id} (${leftoverJob.name}) has no matching job in enriched jobs ⚠️`);
        }
      }

      if (!leftoverJob.when && leftoverJob.status === 'manual') {
        leftoverJob.when = 'manual';
      }
    });
  }

  enrichedJobs.forEach((job) => {
    if (!job.when && job.status === 'manual') {
      job.when = 'manual';
    }
  });

  // Enrich child pipeline trigger_jobs
  if (pipeline.child_pipelines && pipeline.child_pipelines.length > 0) {
    for (const childPipeline of pipeline.child_pipelines) {
      if (childPipeline.trigger_job && childPipeline.trigger_job.id) {
        const triggerMetadata = jobMetadataMap.get(childPipeline.trigger_job.id);
        if (triggerMetadata) {
          if (triggerMetadata.needs && triggerMetadata.needs.length > 0) {
            childPipeline.trigger_job.needs = triggerMetadata.needs;
          }
          if (triggerMetadata.previousStageJobs && triggerMetadata.previousStageJobs.length > 0) {
            childPipeline.trigger_job.previousStageJobs = triggerMetadata.previousStageJobs;
          }
          if (triggerMetadata.schedulingType) {
            childPipeline.trigger_job.schedulingType = triggerMetadata.schedulingType;
          }
          if (!silent) {
            console.log(`${indent}  Enriched trigger_job for child pipeline #${childPipeline.id} with metadata for job #${childPipeline.trigger_job.id}`);
          }
        } else {
          if (!silent) {
            console.log(`${indent}  ⚠️  No metadata found for trigger_job #${childPipeline.trigger_job.id} in child pipeline #${childPipeline.id}`);
          }
        }
      }

      if (childPipeline.jobs && childPipeline.jobs.length > 0) {
        const childJobMap = new Map<number, GitLabJob>();
        childPipeline.jobs.forEach((job) => childJobMap.set(job.id, job));

        await enrichJobsWithMetadata(
          childPipeline,
          childJobMap,
          jobMetadataMap,
          projectPath,
          depth + 1,
          silent
        );
      } else {
        await enrichJobsWithMetadata(
          childPipeline,
          new Map(),
          jobMetadataMap,
          projectPath,
          depth + 1,
          silent
        );
      }
    }
  }

  return pipeline;
}
