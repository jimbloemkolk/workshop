import type {
  GitLabPipeline,
  GitLabJob,
  TransformedPipelineData,
  TransformedJob,
  Dependency,
  PipelineNode,
  CriticalPathNode,
  JobImpact,
  TimelinePipeline,
  TimelineStage,
  TimelineJob
} from './types';

// Internal type that matches the app's JobWithPipeline
interface JobWithPipeline {
  job: GitLabJob;
  pipelineId: number | string;
  pipeline: GitLabPipeline;
}

/**
 * Gather all jobs from a pipeline hierarchy (depth-first)
 * Copied from packages/app/src/utils/pipelineTransform.ts
 */
function gatherAllJobsDepthFirst(pipeline: GitLabPipeline): JobWithPipeline[] {
  const jobs: JobWithPipeline[] = [];
  
  // Add jobs from current pipeline
  if (pipeline.jobs && pipeline.jobs.length > 0) {
    pipeline.jobs.forEach(job => {
      jobs.push({ job, pipelineId: pipeline.id, pipeline });
    });
  }
  
  // Add jobs from child pipelines (depth-first)
  if (pipeline.child_pipelines && pipeline.child_pipelines.length > 0) {
    pipeline.child_pipelines.forEach(childPipeline => {
      jobs.push(...gatherAllJobsDepthFirst(childPipeline));
    });
  }
  
  return jobs;
}

/**
 * Get all pipelines in the hierarchy
 * Copied from packages/app/src/utils/pipelineTransform.ts
 */
function getAllPipelines(pipeline: GitLabPipeline): GitLabPipeline[] {
  const result: GitLabPipeline[] = [pipeline];
  if (pipeline.child_pipelines) {
    pipeline.child_pipelines.forEach(child => {
      result.push(...getAllPipelines(child));
    });
  }
  return result;
}

/**
 * Get a label for a pipeline
 * Copied from packages/app/src/utils/pipelineTransform.ts
 */
function getPipelineLabel(pipeline: GitLabPipeline): string {
  if (pipeline.trigger_job?.name) {
    return pipeline.trigger_job.name;
  }
  return `Pipeline #${pipeline.iid}`;
}

/**
 * Convert JobWithPipeline[] to TransformedJob[]
 */
function extractJobs(allJobsWithPipeline: JobWithPipeline[]): TransformedJob[] {
  return allJobsWithPipeline.map(({ job, pipelineId, pipeline }) => ({
    id: job.id,
    name: job.name,
    stage: job.stage,
    status: job.status,
    pipelineId: typeof pipelineId === 'number' ? pipelineId : Number(pipelineId),
    startTime: job.started_at ? new Date(job.started_at).getTime() : null,
    endTime: job.finished_at ? new Date(job.finished_at).getTime() : null,
    duration: job.duration,
    queuedDuration: job.queued_duration || null,
    isManual: job.when === 'manual',
    isRetried: job.retried || false,
    allowFailure: job.allow_failure
  }));
}

/**
 * Build pipeline hierarchy tree
 */
function buildHierarchy(pipeline: GitLabPipeline): PipelineNode[] {
  const nodes: PipelineNode[] = [];

  function traverse(p: GitLabPipeline, parentId: number | null, triggerJobName: string | null) {
    nodes.push({
      id: p.id,
      iid: p.iid,
      parentId,
      triggerJobName,
      jobCount: p.jobs.length,
      status: p.status,
    });

    if (p.child_pipelines) {
      for (const child of p.child_pipelines) {
        const triggerName = child.trigger_job?.name ?? null;
        traverse(child, p.id, triggerName);
      }
    }
  }

  traverse(pipeline, null, null);
  return nodes;
}

/**
 * Calculate time boundaries across all jobs
 * Copied from packages/app/src/utils/pipelineTransform.ts
 */
function calculateTimeBoundaries(
  allJobsWithPipeline: JobWithPipeline[],
  allPipelines: GitLabPipeline[]
): { earliestTime: number; latestTime: number; totalDuration: number } {
  if (allJobsWithPipeline.length === 0) {
    return { earliestTime: 0, latestTime: 0, totalDuration: 0 };
  }

  // Find the earliest start and latest end time from all jobs (parent and children)
  let earliestTime = Infinity;
  let latestTime = -Infinity;

  allJobsWithPipeline.forEach(({ job }) => {
    // Include created_at for pending time calculation
    if (job.created_at) {
      const createdTime = new Date(job.created_at).getTime();
      earliestTime = Math.min(earliestTime, createdTime);
    }
    
    if (job.started_at) {
      const startTime = new Date(job.started_at).getTime();
      earliestTime = Math.min(earliestTime, startTime);
      
      if (job.finished_at) {
        const endTime = new Date(job.finished_at).getTime();
        latestTime = Math.max(latestTime, endTime);
      } else {
        latestTime = Math.max(latestTime, Date.now());
      }
    }
  });

  // Use pipeline times as fallback, checking all pipelines
  if (earliestTime === Infinity) {
    for (const p of allPipelines) {
      if (p.started_at) {
        earliestTime = Math.min(earliestTime, new Date(p.started_at).getTime());
        break;
      }
    }
  }
  if (latestTime === -Infinity) {
    for (const p of allPipelines) {
      if (p.finished_at) {
        latestTime = Math.max(latestTime, new Date(p.finished_at).getTime());
      }
    }
  }

  // If we still don't have times, use created_at
  if (earliestTime === Infinity) {
    for (const p of allPipelines) {
      earliestTime = Math.min(earliestTime, new Date(p.created_at).getTime());
    }
  }
  if (latestTime === -Infinity) {
    latestTime = Date.now();
  }

  const totalDuration = latestTime - earliestTime;

  return { earliestTime, latestTime, totalDuration };
}

/**
 * Find a job by name within a specific pipeline
 * Copied from packages/app/src/utils/criticalPath.ts
 */
function findJobByName(
  jobName: string,
  pipelineId: number | string,
  allJobsWithPipeline: JobWithPipeline[],
  pipelineJobNameToId: Map<number | string, Map<string, number>>
): { job: GitLabJob; pipelineId: number | string } | null {
  const nameToIdMap = pipelineJobNameToId.get(pipelineId);
  if (!nameToIdMap) {
    return null;
  }

  const jobId = nameToIdMap.get(jobName);
  if (!jobId) {
    return null;
  }

  const found = allJobsWithPipeline.find(
    jwp => jwp.job.id === jobId && jwp.pipelineId === pipelineId
  );

  return found ? { job: found.job, pipelineId: found.pipelineId } : null;
}

/**
 * Get effective trigger job dependencies by traversing up the pipeline hierarchy.
 * Copied from packages/app/src/utils/criticalPath.ts
 */
function getEffectiveTriggerDependencies(
  pipeline: GitLabPipeline,
  pipelineId: number | string,
  allJobsWithPipeline: JobWithPipeline[],
  pipelineParentMap: Map<number | string, number | string>,
  allPipelinesMap: Map<number | string, GitLabPipeline>
): Array<{ jobName: string; pipelineId: number | string }> {
  const triggerJob = pipeline.trigger_job;
  if (!triggerJob) {
    return [];
  }

  const parentPipelineId = pipelineParentMap.get(pipelineId);
  if (!parentPipelineId) {
    return [];
  }

  // Collect dependencies from this trigger job
  const triggerDeps: string[] = [];
  
  if (triggerJob.needs && Array.isArray(triggerJob.needs)) {
    triggerDeps.push(...triggerJob.needs);
  }
  if (triggerJob.previousStageJobs && Array.isArray(triggerJob.previousStageJobs)) {
    triggerJob.previousStageJobs.forEach(prevJob => {
      if (!triggerDeps.includes(prevJob)) {
        triggerDeps.push(prevJob);
      }
    });
  }

  // If this trigger job has dependencies, return them (they're in the parent pipeline)
  if (triggerDeps.length > 0) {
    return triggerDeps.map(jobName => ({ jobName, pipelineId: parentPipelineId }));
  }

  // If no dependencies, traverse up to the parent pipeline and check its trigger job
  const parentPipeline = allPipelinesMap.get(parentPipelineId);
  if (parentPipeline) {
    // Recursively get dependencies from the parent pipeline
    return getEffectiveTriggerDependencies(parentPipeline, parentPipelineId, allJobsWithPipeline, pipelineParentMap, allPipelinesMap);
  }

  return [];
}

/**
 * Find all jobs that the given job depends on.
 * Copied from packages/app/src/utils/criticalPath.ts
 */
function findDependencies(
  job: GitLabJob,
  pipelineId: number | string,
  pipeline: GitLabPipeline,
  allJobsWithPipeline: JobWithPipeline[],
  pipelineJobNameToId: Map<number | string, Map<string, number>>,
  pipelineParentMap: Map<number | string, number | string>,
  allPipelinesMap: Map<number | string, GitLabPipeline>
): Array<{ job: GitLabJob; pipelineId: number | string; type: 'needs' | 'stage' | 'trigger' }> {
  const dependencies: Array<{ job: GitLabJob; pipelineId: number | string; type: 'needs' | 'stage' | 'trigger' }> = [];

  // 1. Check explicit needs dependencies (DAG)
  if (job.needs && Array.isArray(job.needs) && job.needs.length > 0) {
    job.needs.forEach(needsJobName => {
      const depJob = findJobByName(needsJobName, pipelineId, allJobsWithPipeline, pipelineJobNameToId);
      if (depJob) {
        dependencies.push({ ...depJob, type: 'needs' });
      }
    });
  }

  // 2. Check previousStageJobs dependencies (stage-based)
  if (job.previousStageJobs && Array.isArray(job.previousStageJobs) && job.previousStageJobs.length > 0) {
    job.previousStageJobs.forEach(prevJobName => {
      const depJob = findJobByName(prevJobName, pipelineId, allJobsWithPipeline, pipelineJobNameToId);
      if (depJob) {
        dependencies.push({ ...depJob, type: 'stage' });
      }
    });
  }

  // 3. Check if this is a child pipeline's early job (trigger_job dependencies)
  if (pipeline.trigger_job) {
    const parentPipelineId = pipelineParentMap.get(pipelineId);
    
    if (parentPipelineId) {
      // Check if current job is one of the earliest starting jobs in this child pipeline
      const pipelineJobs = allJobsWithPipeline
        .filter(jwp => jwp.pipelineId === pipelineId)
        .map(jwp => jwp.job)
        .filter(j => j.started_at);

      if (pipelineJobs.length > 0) {
        const earliestStart = Math.min(
          ...pipelineJobs.map(j => new Date(j.started_at!).getTime())
        );
        const currentStart = job.started_at ? new Date(job.started_at).getTime() : 0;

        // If this job started within 1 second of the earliest, it's an early job
        if (Math.abs(currentStart - earliestStart) < 1000) {
          // Get the effective trigger job dependencies by traversing up the hierarchy
          const triggerDeps = getEffectiveTriggerDependencies(
            pipeline,
            pipelineId,
            allJobsWithPipeline,
            pipelineParentMap,
            allPipelinesMap
          );

          triggerDeps.forEach(depName => {
            const depJob = findJobByName(depName.jobName, depName.pipelineId, allJobsWithPipeline, pipelineJobNameToId);
            if (depJob) {
              dependencies.push({ ...depJob, type: 'trigger' });
            }
          });
        }
      }
    }
  }

  return dependencies;
}

/**
 * Calculate dependencies for all jobs
 * Based on findDependencies from criticalPath.ts
 */
function calculateDependencies(
  allJobsWithPipeline: JobWithPipeline[],
  pipelineJobNameToId: Map<number | string, Map<string, number>>,
  pipelineParentMap: Map<number | string, number | string>,
  allPipelinesMap: Map<number | string, GitLabPipeline>
): Dependency[] {
  const dependencies: Dependency[] = [];
  const addedDeps = new Set<string>();

  allJobsWithPipeline.forEach(({ job, pipelineId, pipeline }) => {
    const deps = findDependencies(
      job,
      pipelineId,
      pipeline,
      allJobsWithPipeline,
      pipelineJobNameToId,
      pipelineParentMap,
      allPipelinesMap
    );

    deps.forEach(dep => {
      const depKey = `${dep.job.id}-${dep.pipelineId}-${job.id}-${pipelineId}-${dep.type}`;
      if (!addedDeps.has(depKey)) {
        dependencies.push({
          from: {
            jobId: dep.job.id,
            jobName: dep.job.name,
            pipelineId: typeof dep.pipelineId === 'number' ? dep.pipelineId : Number(dep.pipelineId)
          },
          to: {
            jobId: job.id,
            jobName: job.name,
            pipelineId: typeof pipelineId === 'number' ? pipelineId : Number(pipelineId)
          },
          type: dep.type
        });
        addedDeps.add(depKey);
      }
    });
  });

  return dependencies;
}

/**
 * Calculate the critical path through a pipeline using backward tracking.
 * Copied from packages/app/src/utils/criticalPath.ts
 */
function calculateCriticalPath(
  allJobsWithPipeline: JobWithPipeline[],
  pipelineJobNameToId: Map<number | string, Map<string, number>>,
  pipelineParentMap: Map<number | string, number | string>,
  allPipelinesMap: Map<number | string, GitLabPipeline>
): CriticalPathNode[] | null {
  // Step 1: Find all jobs that actually executed
  const executedJobs = allJobsWithPipeline
    .filter(({ job }) => job.started_at && job.finished_at)
    .map(({ job, pipelineId, pipeline }) => ({
      job,
      pipelineId,
      pipeline,
      startTime: new Date(job.started_at!).getTime(),
      finishTime: new Date(job.finished_at!).getTime()
    }));

  if (executedJobs.length === 0) {
    return null;
  }

  // Step 2: Find the job that finished last (the bottleneck)
  const sortedByFinish = [...executedJobs].sort((a, b) => b.finishTime - a.finishTime);
  let currentJob = sortedByFinish[0];

  // Step 3: Build the critical path by walking backwards
  const path: CriticalPathNode[] = [];
  const visitedJobs = new Set<string>();

  // Add the last job (bottleneck) - it has no dependencyType since nothing depends on it
  path.push({
    jobId: currentJob.job.id,
    pipelineId: typeof currentJob.pipelineId === 'number' ? currentJob.pipelineId : Number(currentJob.pipelineId),
    startTime: currentJob.startTime,
    endTime: currentJob.finishTime
  });

  visitedJobs.add(`${currentJob.pipelineId}-${currentJob.job.id}`);

  // Walk backwards through dependencies
  while (true) {
    const dependencies = findDependencies(
      currentJob.job,
      currentJob.pipelineId,
      currentJob.pipeline,
      allJobsWithPipeline,
      pipelineJobNameToId,
      pipelineParentMap,
      allPipelinesMap
    );

    if (dependencies.length === 0) {
      break;
    }

    // Pick the dependency that finished last
    const executedDeps = dependencies
      .map(dep => {
        const depJobData = executedJobs.find(
          ej => ej.job.id === dep.job.id && ej.pipelineId === dep.pipelineId
        );
        return depJobData ? { ...dep, ...depJobData } : null;
      })
      .filter((dep): dep is NonNullable<typeof dep> => dep !== null);

    if (executedDeps.length === 0) {
      break;
    }

    const lastFinishedDep = executedDeps.sort((a, b) => b.finishTime - a.finishTime)[0];

    // Check for cycles
    const depKey = `${lastFinishedDep.pipelineId}-${lastFinishedDep.job.id}`;
    if (visitedJobs.has(depKey)) {
      break;
    }

    // Update the current job's dependencyType
    if (path.length > 0) {
      path[0].dependencyType = lastFinishedDep.type;
    }

    // Add to path (at the beginning since we're walking backwards)
    path.unshift({
      jobId: lastFinishedDep.job.id,
      pipelineId: typeof lastFinishedDep.pipelineId === 'number' ? lastFinishedDep.pipelineId : Number(lastFinishedDep.pipelineId),
      startTime: lastFinishedDep.startTime,
      endTime: lastFinishedDep.finishTime
    });

    visitedJobs.add(depKey);
    currentJob = lastFinishedDep;
  }

  return path;
}

/**
 * Analyze pipeline critical path and calculate job impacts
 * Copied from packages/app/src/utils/jobImpactAnalysis.ts
 */
function calculateJobImpacts(
  allJobsWithPipeline: JobWithPipeline[],
  pipelineJobNameToId: Map<number | string, Map<string, number>>,
  pipelineParentMap: Map<number | string, number | string>,
  allPipelinesMap: Map<number | string, GitLabPipeline>,
  originalCriticalPath: CriticalPathNode[] | null
): JobImpact[] {
  if (!originalCriticalPath) {
    return [];
  }

  // Filter to only jobs that actually ran
  const executedJobs = allJobsWithPipeline
    .filter(jwp => jwp.job.started_at && jwp.job.finished_at && jwp.job.duration);

  if (executedJobs.length === 0) {
    return [];
  }

  const originalDuration = (originalCriticalPath[originalCriticalPath.length - 1].endTime - originalCriticalPath[0].startTime) / 1000;

  // For each job, calculate impact by removing it and recalculating critical path
  const jobImpacts: JobImpact[] = executedJobs.map(({ job, pipelineId }) => {
    const removedJobName = job.name;
    const removedJobNeeds = job.needs || [];
    const removedJobPreviousStageJobs = job.previousStageJobs || [];
    
    // Create modified jobs where dependencies are updated
    const jobsWithUpdatedDeps = allJobsWithPipeline
      .filter(jwp => !(jwp.job.id === job.id && jwp.pipelineId === pipelineId))
      .map(jwp => {
        // Only update jobs in the same pipeline as the removed job
        if (jwp.pipelineId !== pipelineId) {
          return jwp;
        }
        
        const jobNeeds = jwp.job.needs || [];
        const jobPreviousStageJobs = jwp.job.previousStageJobs || [];
        
        // Check if this job depended on the removed job
        const dependedOnRemoved = 
          jobNeeds.includes(removedJobName) || 
          jobPreviousStageJobs.includes(removedJobName);
        
        if (!dependedOnRemoved) {
          return jwp;
        }
        
        // This job depended on the removed job - inherit the removed job's dependencies
        const newNeeds = [...jobNeeds.filter(n => n !== removedJobName)];
        const newPreviousStageJobs = [...jobPreviousStageJobs.filter(n => n !== removedJobName)];
        
        // Add the removed job's dependencies
        removedJobNeeds.forEach(dep => {
          if (!newNeeds.includes(dep)) {
            newNeeds.push(dep);
          }
        });
        
        removedJobPreviousStageJobs.forEach(dep => {
          if (!newPreviousStageJobs.includes(dep) && !newNeeds.includes(dep)) {
            newPreviousStageJobs.push(dep);
          }
        });
        
        // Create a modified job with updated dependencies
        return {
          ...jwp,
          job: {
            ...jwp.job,
            needs: newNeeds.length > 0 ? newNeeds : undefined,
            previousStageJobs: newPreviousStageJobs.length > 0 ? newPreviousStageJobs : undefined
          }
        };
      });

    if (jobsWithUpdatedDeps.length === 0) {
      return {
        jobId: job.id,
        job: job,
        impact: originalDuration,
        percentage: 100
      };
    }

    // Recalculate critical path with updated dependencies
    const newCriticalPath = calculateCriticalPath(
      jobsWithUpdatedDeps,
      pipelineJobNameToId,
      pipelineParentMap,
      allPipelinesMap
    );

    if (!newCriticalPath || newCriticalPath.length === 0) {
      return {
        jobId: job.id,
        job: job,
        impact: originalDuration,
        percentage: 100
      };
    }

    const newDuration = (newCriticalPath[newCriticalPath.length - 1].endTime - newCriticalPath[0].startTime) / 1000;
    const impact = Math.max(0, originalDuration - newDuration);
    const percentage = originalDuration > 0 ? (impact / originalDuration) * 100 : 0;

    return {
      jobId: job.id,
      job: job,
      impact,
      percentage
    };
  });

  return jobImpacts;
}

/**
 * Build timeline layout - group jobs by pipeline and stage, sort stages, calculate positions
 */
function buildTimelineLayout(
  allJobsWithPipeline: JobWithPipeline[],
  rootPipeline: GitLabPipeline,
  earliestTime: number,
  totalDuration: number
): TimelinePipeline[] {
  // Define typical GitLab stage order
  const stageOrder = [
    'preflight',
    '.pre',
    'build',
    'build-images',
    'prepare',
    'fixtures',
    'lint',
    'test',
    'test-frontend',
    'post-test',
    'benchmark',
    'review',
    'dast',
    'deploy',
    'sync',
    'pages',
    'notify',
    '.post'
  ];

  // Group jobs by pipeline first (depth-first), then by stage within each pipeline
  interface PipelineStageGroup {
    pipelineId: number;
    pipeline: GitLabPipeline;
    stages: Map<string, GitLabJob[]>;
    isParent: boolean;
  }
  
  const pipelineGroups: PipelineStageGroup[] = [];
  const pipelineMap = new Map<number, PipelineStageGroup>();
  
  allJobsWithPipeline.forEach(({ job, pipelineId, pipeline: jobPipeline }) => {
    const numericPipelineId = typeof pipelineId === 'number' ? pipelineId : Number(pipelineId);
    
    if (!pipelineMap.has(numericPipelineId)) {
      const group: PipelineStageGroup = {
        pipelineId: numericPipelineId,
        pipeline: jobPipeline,
        stages: new Map(),
        isParent: numericPipelineId === rootPipeline.id
      };
      pipelineMap.set(numericPipelineId, group);
      pipelineGroups.push(group);
    }
    
    const group = pipelineMap.get(numericPipelineId)!;
    if (!group.stages.has(job.stage)) {
      group.stages.set(job.stage, []);
    }
    group.stages.get(job.stage)!.push(job);
  });

  // Build timeline pipelines with sorted stages
  return pipelineGroups.map(pipelineGroup => {
    const sortedStageEntries = Array.from(pipelineGroup.stages.entries()).sort(([stageA], [stageB]) => {
      const indexA = stageOrder.indexOf(stageA);
      const indexB = stageOrder.indexOf(stageB);
      
      if (indexA !== -1 && indexB !== -1) {
        return indexA - indexB;
      }
      if (indexA !== -1) return -1;
      if (indexB !== -1) return 1;
      return stageA.localeCompare(stageB);
    });

    const stages: TimelineStage[] = sortedStageEntries.map(([stageName, jobs]) => {
      // Calculate position percentages for each job
      const jobsWithPositions: TimelineJob[] = jobs.map(job => {
        let pendingStartPercent = 0;
        let pendingWidthPercent = 0;
        let startPercent = 0;
        let widthPercent = 5;

        if (job.started_at) {
          const startTime = new Date(job.started_at).getTime();
          startPercent = ((startTime - earliestTime) / totalDuration) * 100;

          if (job.queued_duration) {
            const pendingDurationMs = job.queued_duration * 1000;
            const pendingStartTime = startTime - pendingDurationMs;
            pendingStartPercent = ((pendingStartTime - earliestTime) / totalDuration) * 100;
            pendingWidthPercent = (pendingDurationMs / totalDuration) * 100;
          }

          if (job.finished_at) {
            const endTime = new Date(job.finished_at).getTime();
            widthPercent = ((endTime - startTime) / totalDuration) * 100;
          } else {
            widthPercent = ((Date.now() - startTime) / totalDuration) * 100;
          }
        } else {
          startPercent = 95;
          widthPercent = 5;
        }

        return {
          ...job,
          pendingStartPercent: Math.max(0, Math.min(100, pendingStartPercent)),
          pendingWidthPercent: Math.max(0, Math.min(100, pendingWidthPercent)),
          startPercent: Math.max(0, Math.min(100, startPercent)),
          widthPercent: Math.max(1, Math.min(100 - startPercent, widthPercent)),
          endPercent: Math.max(0, Math.min(100, startPercent)) + Math.max(1, Math.min(100 - startPercent, widthPercent))
        };
      });

      return {
        name: stageName,
        jobs: jobsWithPositions
      };
    });

    return {
      pipelineId: pipelineGroup.pipelineId,
      pipeline: pipelineGroup.pipeline,
      isParent: pipelineGroup.isParent,
      stages
    };
  });
}

/**
 * Calculate pipeline statistics
 */
function calculateStatistics(
  allJobsWithPipeline: JobWithPipeline[],
  earliestTime: number,
  latestTime: number
) {
  const completedJobs = allJobsWithPipeline.filter(jwp => 
    jwp.job.duration !== null && jwp.job.duration > 0
  );
  
  const totalExecutionTime = completedJobs.reduce((sum, jwp) => sum + (jwp.job.duration || 0), 0);
  const totalWaitingTime = completedJobs.reduce((sum, jwp) => sum + (jwp.job.queued_duration || 0), 0);
  const wallClockTime = (latestTime - earliestTime) / 1000; // Convert to seconds

  const successCount = allJobsWithPipeline.filter(jwp => jwp.job.status === 'success').length;
  const failedCount = allJobsWithPipeline.filter(jwp => jwp.job.status === 'failed').length;

  return {
    totalJobs: allJobsWithPipeline.length,
    totalWaitingTime,
    totalExecutionTime,
    avgWaitingTime: completedJobs.length > 0 ? totalWaitingTime / completedJobs.length : 0,
    avgExecutionTime: completedJobs.length > 0 ? totalExecutionTime / completedJobs.length : 0,
    efficiency: wallClockTime > 0 ? (totalExecutionTime / wallClockTime) * 100 : 0,
    parallelizationFactor: wallClockTime > 0 ? totalExecutionTime / wallClockTime : 0,
    successCount,
    failedCount,
  };
}

/**
 * Main entry point - transform a GitLab pipeline into a structured data format
 */
export function transformPipeline(pipeline: GitLabPipeline): TransformedPipelineData {
  // Gather all jobs from the pipeline hierarchy
  const allJobsWithPipeline = gatherAllJobsDepthFirst(pipeline);
  
  // Get all pipelines in the hierarchy
  const allPipelines = getAllPipelines(pipeline);
  
  // Build lookup maps
  const pipelineJobNameToId = new Map<number | string, Map<string, number>>();
  const pipelineParentMap = new Map<number | string, number | string>();
  const allPipelinesMap = new Map<number | string, GitLabPipeline>();
  
  const buildPipelineMaps = (pipe: GitLabPipeline, parentId?: number | string) => {
    allPipelinesMap.set(pipe.id, pipe);
    if (parentId !== undefined) {
      pipelineParentMap.set(pipe.id, parentId);
    }
    
    const nameToIdMap = new Map<string, number>();
    pipe.jobs.forEach(job => {
      nameToIdMap.set(job.name, job.id);
    });
    pipelineJobNameToId.set(pipe.id, nameToIdMap);
    
    if (pipe.child_pipelines && pipe.child_pipelines.length > 0) {
      pipe.child_pipelines.forEach(childPipe => {
        buildPipelineMaps(childPipe, pipe.id);
      });
    }
  };
  
  buildPipelineMaps(pipeline);
  
  // Extract jobs
  const jobs = extractJobs(allJobsWithPipeline);
  
  // Calculate dependencies
  const dependencies = calculateDependencies(
    allJobsWithPipeline,
    pipelineJobNameToId,
    pipelineParentMap,
    allPipelinesMap
  );
  
  // Build hierarchy
  const pipelineHierarchy = buildHierarchy(pipeline);
  
  // Calculate time boundaries
  const { earliestTime, latestTime, totalDuration } = calculateTimeBoundaries(
    allJobsWithPipeline,
    allPipelines
  );
  
  // Calculate critical path
  const criticalPath = calculateCriticalPath(
    allJobsWithPipeline,
    pipelineJobNameToId,
    pipelineParentMap,
    allPipelinesMap
  );
  
  // Calculate job impacts
  const jobImpacts = calculateJobImpacts(
    allJobsWithPipeline,
    pipelineJobNameToId,
    pipelineParentMap,
    allPipelinesMap,
    criticalPath
  );
  
  // Calculate statistics
  const stats = calculateStatistics(
    allJobsWithPipeline,
    earliestTime,
    latestTime
  );

  // Build timeline layout (grouping, ordering, position percentages)
  const timelineLayout = buildTimelineLayout(
    allJobsWithPipeline,
    pipeline,
    earliestTime,
    totalDuration
  );

  return {
    pipelineId: pipeline.id,
    pipelineIid: pipeline.iid,
    status: pipeline.status,
    ref: pipeline.ref,
    webUrl: pipeline.web_url,
    earliestTime,
    latestTime,
    totalDuration,
    jobs,
    dependencies,
    pipelineHierarchy,
    criticalPath,
    jobImpacts,
    timelineLayout,
    stats,
  };
}
