import type { GitLabJob, GitLabPipelineFull, JobMetadata, GraphQLResponse } from './types.js';

// Cache for project_id to path_with_namespace lookups
const projectPathCache = new Map<number, string>();

/**
 * Resolve project_id to project path (path_with_namespace)
 */
export async function resolveProjectPath(projectId: number): Promise<string | null> {
  if (projectPathCache.has(projectId)) {
    return projectPathCache.get(projectId)!;
  }

  try {
    // Use glab CLI to fetch project info
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execPromise = promisify(exec);
    
    const { stdout } = await execPromise(`glab api /projects/${projectId}`);
    const project = JSON.parse(stdout);
    const path = project.path_with_namespace;
    projectPathCache.set(projectId, path);
    return path;
  } catch (error) {
    console.warn(
      `⚠️  Could not resolve project path for project_id ${projectId}: ${error instanceof Error ? error.message : error}`
    );
    return null;
  }
}

/**
 * Parse GraphQL response to extract job metadata
 */
export function parseJobDependenciesFromGraphQL(response: GraphQLResponse): Map<number, JobMetadata> {
  const jobMetadataMap = new Map<number, JobMetadata>();

  // Helper function to process stages and extract job info
  const processStages = (stages: any) => {
    if (!stages?.nodes) return;

    stages.nodes.forEach((stage: any) => {
      stage.groups?.nodes?.forEach((group: any) => {
        group.jobs?.nodes?.forEach((job: any) => {
          // Extract numeric ID from GID like "gid://gitlab/Ci::Build/12345"
          const numericId = job.id ? parseInt(job.id.split('/').pop()) : null;
          if (!numericId) return;

          const metadata: JobMetadata = {};

          // Extract scheduling type
          if (job.schedulingType) {
            metadata.schedulingType = job.schedulingType;
          }

          // Extract needs (dependencies)
          const needs =
            job.needs?.nodes?.map((need: any) => need.name)?.filter((name: string) => name) || [];
          if (needs.length > 0) {
            metadata.needs = needs;
          }

          // Extract previous stage jobs (for stage-based scheduling)
          const previousStageJobs =
            job.previousStageJobs?.nodes
              ?.map((prevJob: any) => prevJob.name)
              ?.filter((name: string) => name) || [];
          if (previousStageJobs.length > 0) {
            metadata.previousStageJobs = previousStageJobs;
          }

          // Extract manual job flag
          if (job.manualJob === true) {
            metadata.when = 'manual';
          }

          // Extract retried flag
          if (job.retried === true) {
            metadata.retried = true;
          }

          jobMetadataMap.set(numericId, metadata);
        });
      });
    });
  };

  // Process main pipeline stages
  if (response.data?.project?.pipeline) {
    const pipeline = response.data.project.pipeline;
    processStages(pipeline.stages);

    // Process first level of child pipelines
    if (pipeline.downstream?.nodes) {
      pipeline.downstream.nodes.forEach((childPipeline: any) => {
        processStages(childPipeline.stages);

        // Process second level of child pipelines
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
 * Enrich jobs with GraphQL metadata
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

  // Track enriched jobs
  const enrichedJobs: GitLabJob[] = [];

  // Enrich each job with metadata from GraphQL and remove from jobMap
  jobMetadataMap.forEach((metadata, jobId) => {
    const job = jobMap.get(jobId);
    if (job) {
      if (metadata.schedulingType) {
        job.schedulingType = metadata.schedulingType;
      }
      if (metadata.needs && metadata.needs.length > 0) {
        job.needs = metadata.needs;
      }
      if (metadata.previousStageJobs && metadata.previousStageJobs.length > 0) {
        job.previousStageJobs = metadata.previousStageJobs;
      }
      if (metadata.when) {
        job.when = metadata.when;
      }
      if (metadata.retried) {
        job.retried = metadata.retried;
      }
      // Move job to enriched list and remove from map
      enrichedJobs.push(job);
      jobMap.delete(jobId);
    }
  });

  // Now process leftover jobs in jobMap (these weren't in GraphQL response)
  // These are likely retried jobs that no longer appear in the latest pipeline state
  const leftoverJobs = Array.from(jobMap.values());

  if (leftoverJobs.length > 0) {
    if (!silent) {
      console.log(
        `${indent}  Found ${leftoverJobs.length} jobs not in GraphQL (checking for retries)...`
      );
    }
    leftoverJobs.forEach((leftoverJob) => {
      // Try to find a matching job in enrichedJobs (same stage and name)
      const matchingJob = enrichedJobs.find(
        (enrichedJob) =>
          enrichedJob.stage === leftoverJob.stage && enrichedJob.name === leftoverJob.name
      );

      if (matchingJob) {
        // This leftover job is a retry! Copy metadata from the matching job
        if (!silent) {
          console.log(
            `${indent}    Job ${leftoverJob.id} (${leftoverJob.name}) is a retry of job ${matchingJob.id}`
          );
        }

        if (matchingJob.schedulingType) {
          leftoverJob.schedulingType = matchingJob.schedulingType;
        }
        if (matchingJob.needs) {
          leftoverJob.needs = matchingJob.needs;
        }
        if (matchingJob.previousStageJobs) {
          leftoverJob.previousStageJobs = matchingJob.previousStageJobs;
        }
        if (matchingJob.when) {
          leftoverJob.when = matchingJob.when;
        }

        // Mark this job as retried (it's the old version that was retried)
        leftoverJob.retried = true;
      } else {
        if (!silent) {
          console.log(
            `${indent}    Job ${leftoverJob.id} (${leftoverJob.name}) has no matching job in enriched jobs ⚠️`
          );
        }
      }

      // Add manual fallback for jobs with manual status
      if (!leftoverJob.when && leftoverJob.status === 'manual') {
        leftoverJob.when = 'manual';
      }
    });
  }

  // Also apply manual fallback to enriched jobs
  enrichedJobs.forEach((job) => {
    if (!job.when && job.status === 'manual') {
      job.when = 'manual';
    }
  });

  // Enrich child pipeline trigger_jobs with dependency information from parent jobs
  if (pipeline.child_pipelines && pipeline.child_pipelines.length > 0) {
    for (const childPipeline of pipeline.child_pipelines) {
      if (childPipeline.trigger_job && childPipeline.trigger_job.id) {
        // Try to get metadata from GraphQL for the trigger job (bridge job)
        const triggerMetadata = jobMetadataMap.get(childPipeline.trigger_job.id);
        if (triggerMetadata) {
          // Copy dependency information from GraphQL metadata
          if (triggerMetadata.needs && triggerMetadata.needs.length > 0) {
            childPipeline.trigger_job.needs = triggerMetadata.needs;
          }
          if (
            triggerMetadata.previousStageJobs &&
            triggerMetadata.previousStageJobs.length > 0
          ) {
            childPipeline.trigger_job.previousStageJobs = triggerMetadata.previousStageJobs;
          }
          if (triggerMetadata.schedulingType) {
            childPipeline.trigger_job.schedulingType = triggerMetadata.schedulingType;
          }
          if (!silent) {
            console.log(
              `${indent}  Enriched trigger_job for child pipeline #${childPipeline.id} with metadata for job #${childPipeline.trigger_job.id}`
            );
          }
        } else {
          if (!silent) {
            console.log(
              `${indent}  ⚠️  No metadata found for trigger_job #${childPipeline.trigger_job.id} in child pipeline #${childPipeline.id}`
            );
          }
        }
      }

      // Recursively enrich the child pipeline's own jobs and its nested children
      if (childPipeline.jobs && childPipeline.jobs.length > 0) {
        // Build a jobMap for the child pipeline's jobs
        const childJobMap = new Map<number, GitLabJob>();
        childPipeline.jobs.forEach((job) => childJobMap.set(job.id, job));

        // Pass the parent's jobMetadataMap - it includes all jobs from child pipelines
        await enrichJobsWithMetadata(
          childPipeline,
          childJobMap,
          jobMetadataMap,
          projectPath,
          depth + 1,
          silent
        );
      } else {
        // Even if the child has no jobs, it might have nested child pipelines
        // Recursively enrich those as well
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
