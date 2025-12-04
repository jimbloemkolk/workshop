import React, { useMemo, useState, useRef, useEffect } from 'react';
import type { GitLabPipeline, TransformedPipeline } from '../types/gitlab';
import type { TransformedPipelineData, CriticalPathNode } from '../../../transform/src/index';
import './PipelineTimeline.css';

interface PipelineTimelineProps {
  pipeline: GitLabPipeline;
  transformedPipeline: TransformedPipeline;
  transformedData?: TransformedPipelineData | null;
  onJobClick: (job: any) => void;
}

// Constants for SVG layout
const STAGE_NAME_WIDTH = 120;
const JOB_HEIGHT = 18;
const JOB_VERTICAL_GAP = 4;
const STAGE_VERTICAL_PADDING = 8;
const HEADER_HEIGHT = 100;
const CRITICAL_PATH_HEIGHT = 50;
const CRITICAL_PATH_BAR_HEIGHT = 20;
const CRITICAL_PATH_BOTTOM_MARGIN = 20;
const TIMELINE_RULER_HEIGHT = 40;
const TIMELINE_START_X = STAGE_NAME_WIDTH + 20;
const TIMELINE_END_MARGIN = 40;

const PipelineTimelineSVG: React.FC<PipelineTimelineProps> = ({ pipeline, transformedPipeline, transformedData, onJobClick }) => {
  const [hoveredJob, setHoveredJob] = useState<number | null>(null);
  const [containerWidth, setContainerWidth] = useState<number>(1200);
  const containerRef = useRef<HTMLDivElement>(null);

  // Measure container width and update on resize
  useEffect(() => {
    const updateWidth = () => {
      if (containerRef.current) {
        const width = containerRef.current.offsetWidth;
        setContainerWidth(width);
      }
    };

    // Initial measurement
    updateWidth();

    // Update on window resize
    window.addEventListener('resize', updateWidth);
    
    // Also observe container size changes
    const resizeObserver = new ResizeObserver(updateWidth);
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      window.removeEventListener('resize', updateWidth);
      resizeObserver.disconnect();
    };
  }, []);

  // Calculate timeline layout with all positions
  const timelineLayout = useMemo(() => {
    const { allJobsWithPipeline, earliestTime, latestTime, totalDuration } = transformedPipeline;
    
    if (allJobsWithPipeline.length === 0) {
      return null;
    }

    // Calculate available timeline width based on container
    // Reserve 15% of space at the end for unstarted jobs
    const totalAvailableWidth = Math.max(800, containerWidth - TIMELINE_START_X - TIMELINE_END_MARGIN);
    const timelineWidth = totalAvailableWidth * 0.85; // 85% for timeline
    const unstartedJobsZoneStart = TIMELINE_START_X + timelineWidth;
    const unstartedJobsZoneWidth = totalAvailableWidth * 0.15; // 15% for unstarted jobs

    // Group jobs by pipeline and stage
    interface PipelineStageGroup {
      pipelineId: string | number;
      pipeline: GitLabPipeline;
      stages: Map<string, any[]>;
      isParent: boolean;
      parentPipelineId?: string | number; // Track parent pipeline for child pipelines
    }
    
    const pipelineGroups: PipelineStageGroup[] = [];
    const pipelineMap = new Map<string | number, PipelineStageGroup>();
    
    // Build pipeline hierarchy by traversing the pipeline tree
    const buildPipelineHierarchy = (pipe: GitLabPipeline, parentId?: string | number) => {
      // Process current pipeline's jobs
      const jobs = pipe.jobs || [];
      jobs.forEach(job => {
        if (!pipelineMap.has(pipe.id)) {
          const group: PipelineStageGroup = {
            pipelineId: pipe.id,
            pipeline: pipe,
            stages: new Map(),
            isParent: pipe.id === pipeline.id,
            parentPipelineId: parentId
          };
          pipelineMap.set(pipe.id, group);
          pipelineGroups.push(group);
        }
        
        const group = pipelineMap.get(pipe.id)!;
        if (!group.stages.has(job.stage)) {
          group.stages.set(job.stage, []);
        }
        group.stages.get(job.stage)!.push(job);
      });
      
      // Recursively process child pipelines
      if (pipe.child_pipelines && pipe.child_pipelines.length > 0) {
        pipe.child_pipelines.forEach(childPipe => {
          buildPipelineHierarchy(childPipe, pipe.id);
        });
      }
    };
    
    buildPipelineHierarchy(pipeline);

    // Define typical GitLab stage order
    const stageOrder = [
      'preflight', '.pre', 'build', 'build-images', 'prepare', 'fixtures',
      'lint', 'test', 'test-frontend', 'post-test', 'benchmark', 'review',
      'dast', 'deploy', 'sync', 'pages', 'notify', '.post'
    ];

    // Build layout with absolute positions
    let currentY = HEADER_HEIGHT + CRITICAL_PATH_HEIGHT + CRITICAL_PATH_BOTTOM_MARGIN + TIMELINE_RULER_HEIGHT;
    const jobPositions = new Map<string, { x: number; y: number; width: number; job: any; pipelineId: string | number }>();
    const stagePositions: any[] = [];
    const pipelineLabels: any[] = [];

    pipelineGroups.forEach((pipelineGroup) => {
      // Add pipeline label space if child pipeline
      if (!pipelineGroup.isParent) {
        pipelineLabels.push({
          y: currentY,
          pipeline: pipelineGroup.pipeline,
          pipelineId: pipelineGroup.pipelineId
        });
        currentY += 30;
      }

      const sortedStageEntries = Array.from(pipelineGroup.stages.entries()).sort(([stageA], [stageB]) => {
        const indexA = stageOrder.indexOf(stageA);
        const indexB = stageOrder.indexOf(stageB);
        if (indexA !== -1 && indexB !== -1) return indexA - indexB;
        if (indexA !== -1) return -1;
        if (indexB !== -1) return 1;
        return stageA.localeCompare(stageB);
      });

      sortedStageEntries.forEach(([stageName, jobs]) => {
        const stageStartY = currentY;

        // Calculate job positions within this stage
        const jobsWithPosition = jobs.map(job => {
          let startPercent = 0;
          let widthPercent = 5;
          let x = 0;
          let width = 0;

          if (job.started_at) {
            const startTime = new Date(job.started_at).getTime();
            startPercent = ((startTime - earliestTime) / totalDuration) * 100;

            if (job.finished_at) {
              const endTime = new Date(job.finished_at).getTime();
              widthPercent = ((endTime - startTime) / totalDuration) * 100;
            } else {
              widthPercent = ((Date.now() - startTime) / totalDuration) * 100;
            }

            x = TIMELINE_START_X + (startPercent / 100) * timelineWidth;
            width = Math.max(10, (widthPercent / 100) * timelineWidth);
          } else {
            // Job hasn't started - place in the unstarted jobs zone
            startPercent = 100; // Mark as unstarted for sorting
            widthPercent = 0;
            x = unstartedJobsZoneStart;
            width = Math.max(30, unstartedJobsZoneWidth * 0.8); // Fixed width for unstarted jobs
          }

          return {
            ...job,
            x,
            width,
            startPercent,
            widthPercent,
            endPercent: startPercent + widthPercent,
            row: 0,
            isUnstarted: !job.started_at
          };
        });

        // Assign rows to avoid overlaps
        // Separate started and unstarted jobs for row assignment
        const startedJobs = jobsWithPosition.filter(j => !j.isUnstarted);
        const unstartedJobs = jobsWithPosition.filter(j => j.isUnstarted);
        
        const rows: Array<{ endPercent: number }> = [];
        const unstartedRows: Array<{ index: number }> = [];
        const GAP = 0.2;

        // Sort started jobs by start time
        startedJobs.sort((a, b) => a.startPercent - b.startPercent);

        // Assign rows for started jobs
        startedJobs.forEach(job => {
          let assignedRow = -1;
          for (let i = 0; i < rows.length; i++) {
            if (rows[i].endPercent + GAP <= job.startPercent) {
              assignedRow = i;
              rows[i].endPercent = job.endPercent;
              break;
            }
          }
          if (assignedRow === -1) {
            assignedRow = rows.length;
            rows.push({ endPercent: job.endPercent });
          }
          job.row = assignedRow;
          job.y = currentY + assignedRow * (JOB_HEIGHT + JOB_VERTICAL_GAP) + STAGE_VERTICAL_PADDING;

          // Store job position with unique key (pipelineId-jobId)
          const jobKey = `${pipelineGroup.pipelineId}-${job.id}`;
          jobPositions.set(jobKey, { x: job.x, y: job.y, width: job.width, job, pipelineId: pipelineGroup.pipelineId });
        });

        // Assign rows for unstarted jobs (stack them vertically in the unstarted zone)
        unstartedJobs.forEach((job, index) => {
          job.row = index;
          unstartedRows.push({ index });
          job.y = currentY + index * (JOB_HEIGHT + JOB_VERTICAL_GAP) + STAGE_VERTICAL_PADDING;

          // Store job position with unique key (pipelineId-jobId)
          const jobKey = `${pipelineGroup.pipelineId}-${job.id}`;
          jobPositions.set(jobKey, { x: job.x, y: job.y, width: job.width, job, pipelineId: pipelineGroup.pipelineId });
        });

        // Total rows is the max of started and unstarted
        const totalRows = Math.max(rows.length, unstartedRows.length);
        const stageHeight = totalRows * (JOB_HEIGHT + JOB_VERTICAL_GAP) + STAGE_VERTICAL_PADDING * 2;
        
        stagePositions.push({
          name: stageName,
          y: stageStartY,
          height: stageHeight,
          jobs: jobsWithPosition,
          rowCount: totalRows,
          pipelineId: pipelineGroup.pipelineId,
          isParent: pipelineGroup.isParent
        });

        currentY += stageHeight + 4; // Stage bottom margin
      });

      currentY += 12; // Pipeline bottom margin
    });

    // Build a name-to-ID map per pipeline for resolving job names to IDs
    const pipelineJobNameToId = new Map<string | number, Map<string, number>>();
    jobPositions.forEach((jobData, key) => {
      if (typeof key === 'string' && key.includes('-')) {
        const pipelineId = jobData.pipelineId;
        if (!pipelineJobNameToId.has(pipelineId)) {
          pipelineJobNameToId.set(pipelineId, new Map());
        }
        pipelineJobNameToId.get(pipelineId)!.set(jobData.job.name, jobData.job.id);
      }
    });

    // Build parent pipeline map for critical path calculation
    const pipelineParentMap = new Map<number | string, number | string>();
    const allPipelinesMap = new Map<number | string, GitLabPipeline>();
    
    // Build a complete map of all pipelines (including those with no jobs)
    const buildPipelineMaps = (pipe: GitLabPipeline, parentId?: number | string) => {
      allPipelinesMap.set(pipe.id, pipe);
      if (parentId) {
        pipelineParentMap.set(pipe.id, parentId);
      }
      
      // Recursively process child pipelines
      if (pipe.child_pipelines && pipe.child_pipelines.length > 0) {
        pipe.child_pipelines.forEach(childPipe => {
          buildPipelineMaps(childPipe, pipe.id);
        });
      }
    };
    
    buildPipelineMaps(pipeline);
    
    pipelineGroups.forEach(pg => {
      if (pg.parentPipelineId) {
        pipelineParentMap.set(pg.pipelineId, pg.parentPipelineId);
      }
    });

    // Helper function to get effective trigger dependencies by traversing up the pipeline hierarchy
    const getEffectiveTriggerDeps = (
      pipelineId: number | string,
      triggerJob: { needs?: string[]; previousStageJobs?: string[] }
    ): Array<{ name: string; pipelineId: number | string }> => {
      const deps: Array<{ name: string }> = [];
      
      // Collect dependencies from this trigger job
      if (triggerJob.needs && Array.isArray(triggerJob.needs)) {
        triggerJob.needs.forEach(needsJobName => {
          deps.push({ name: needsJobName });
        });
      }
      
      if (triggerJob.previousStageJobs && Array.isArray(triggerJob.previousStageJobs)) {
        triggerJob.previousStageJobs.forEach(prevJobName => {
          if (!triggerJob.needs?.includes(prevJobName)) {
            deps.push({ name: prevJobName });
          }
        });
      }
      
      // If we have dependencies, return them with the parent pipeline ID
      const parentPipelineId = pipelineParentMap.get(pipelineId);
      if (deps.length > 0 && parentPipelineId) {
        return deps.map(d => ({ name: d.name, pipelineId: parentPipelineId }));
      }
      
      // If no dependencies, traverse up to the parent pipeline
      if (!parentPipelineId) {
        return [];
      }
      
      const parentPipeline = allPipelinesMap.get(parentPipelineId);
      if (!parentPipeline?.trigger_job) {
        return [];
      }
      
      // Recursively get dependencies from the parent
      return getEffectiveTriggerDeps(parentPipelineId, parentPipeline.trigger_job);
    };

    // Calculate dependency lines
    const dependencyLines: Array<{
      x1: number; y1: number; x2: number; y2: number;
      fromJob: string; toJob: string;
      type: 'needs' | 'stage' | 'trigger'; // Track dependency type for different styling
    }> = [];

    jobPositions.forEach((toJobData, toJobKey) => {
      // Only process entries with composite keys (skip any legacy name-based entries)
      if (typeof toJobKey !== 'string' || !toJobKey.includes('-')) return;
      
      const toJob = toJobData.job;
      const toPipelineId = toJobData.pipelineId;
      const nameToIdMap = pipelineJobNameToId.get(toPipelineId);
      
      if (!nameToIdMap) return;
      
      // Handle DAG dependencies (needs)
      if (toJob.needs && Array.isArray(toJob.needs)) {
        toJob.needs.forEach((needsJobName: string) => {
          // Resolve the job name to ID within the same pipeline
          const fromJobId = nameToIdMap.get(needsJobName);
          if (fromJobId) {
            const fromJobKey = `${toPipelineId}-${fromJobId}`;
            const fromJobData = jobPositions.get(fromJobKey);
            if (fromJobData) {
              // Line from right edge of source job to left edge of dependent job
              dependencyLines.push({
                x1: fromJobData.x + fromJobData.width,
                y1: fromJobData.y + JOB_HEIGHT / 2,
                x2: toJobData.x,
                y2: toJobData.y + JOB_HEIGHT / 2,
                fromJob: needsJobName,
                toJob: toJob.name,
                type: 'needs'
              });
            }
          }
        });
      }
      
      // Handle stage dependencies (previousStageJobs)
      if (toJob.previousStageJobs && Array.isArray(toJob.previousStageJobs)) {
        toJob.previousStageJobs.forEach((prevJobName: string) => {
          // Resolve the job name to ID within the same pipeline
          const fromJobId = nameToIdMap.get(prevJobName);
          if (fromJobId) {
            const fromJobKey = `${toPipelineId}-${fromJobId}`;
            const fromJobData = jobPositions.get(fromJobKey);
            if (fromJobData) {
              // Only add if not already covered by needs dependency
              const alreadyHasNeedsDep = toJob.needs?.includes(prevJobName);
              if (!alreadyHasNeedsDep) {
                dependencyLines.push({
                  x1: fromJobData.x + fromJobData.width,
                  y1: fromJobData.y + JOB_HEIGHT / 2,
                  x2: toJobData.x,
                  y2: toJobData.y + JOB_HEIGHT / 2,
                  fromJob: prevJobName,
                  toJob: toJob.name,
                  type: 'stage'
                });
              }
            }
          }
        });
      }
    });

    // Handle cross-pipeline dependencies (from trigger job to child pipeline)
    // For each child pipeline, connect its trigger job's dependencies to the child's first jobs
    pipelineGroups.forEach((pipelineGroup) => {
      if (pipelineGroup.isParent || !pipelineGroup.pipeline.trigger_job || !pipelineGroup.parentPipelineId) return;
      
      const triggerJob = pipelineGroup.pipeline.trigger_job;
      const parentPipelineId = pipelineGroup.parentPipelineId; // Use the actual parent pipeline ID
      
      if (!parentPipelineId) return;
      
      // Find the earliest starting jobs in this child pipeline (jobs with no dependencies or that start immediately)
      const childJobsArray = Array.from(pipelineGroup.stages.values()).flat();
      const childJobsSorted = childJobsArray
        .filter(job => job.started_at)
        .sort((a, b) => new Date(a.started_at!).getTime() - new Date(b.started_at!).getTime());
      
      if (childJobsSorted.length === 0) return;
      
      // Get the earliest start time
      const earliestStartTime = new Date(childJobsSorted[0].started_at!).getTime();
      
      // Find all jobs that start within a small window of the earliest (likely parallel starting jobs)
      const earlyJobs = childJobsSorted.filter(job => {
        const startTime = new Date(job.started_at!).getTime();
        return (startTime - earliestStartTime) < 1000; // Within 1 second
      });
      
      // Get effective trigger dependencies (traverses up through empty parent pipelines if needed)
      const effectiveDeps = getEffectiveTriggerDeps(pipelineGroup.pipelineId, triggerJob);
      
      // Draw dependencies from trigger job deps to early child pipeline jobs
      effectiveDeps.forEach(dep => {
        const depParentNameToIdMap = pipelineJobNameToId.get(dep.pipelineId);
        if (!depParentNameToIdMap) return;
        
        const fromJobId = depParentNameToIdMap.get(dep.name);
        if (!fromJobId) return;
        
        const fromJobKey = `${dep.pipelineId}-${fromJobId}`;
        const fromJobData = jobPositions.get(fromJobKey);
        if (!fromJobData) return;
        
        // Draw to each early-starting job in the child pipeline
        earlyJobs.forEach(toJob => {
          const toJobKey = `${pipelineGroup.pipelineId}-${toJob.id}`;
          const toJobData = jobPositions.get(toJobKey);
          if (toJobData) {
            dependencyLines.push({
              x1: fromJobData.x + fromJobData.width,
              y1: fromJobData.y + JOB_HEIGHT / 2,
              x2: toJobData.x,
              y2: toJobData.y + JOB_HEIGHT / 2,
              fromJob: dep.name,
              toJob: toJob.name,
              type: 'trigger' // Always use 'trigger' type for cross-pipeline dependencies
            });
          }
        });
      });
    });

    // Use pre-calculated critical path from transformedData, or set to null
    let criticalPath: any = null;
    
    // If we have the critical path from transform package, adapt it to match the old format
    if (transformedData?.criticalPath && transformedData.criticalPath.length > 0) {
      // Transform package critical path doesn't include the job object, so we need to add it
      const jobMap = new Map();
      allJobsWithPipeline.forEach(jwp => jobMap.set(jwp.job.id, jwp.job));
      
      const cpArray = transformedData.criticalPath;
      criticalPath = {
        path: cpArray.map((node: CriticalPathNode) => ({
          ...node,
          job: jobMap.get(node.jobId)
        })),
        totalDuration: cpArray[cpArray.length - 1].endTime - cpArray[0].startTime,
        bottleneckJob: {
          ...cpArray[cpArray.length - 1],
          job: jobMap.get(cpArray[cpArray.length - 1].jobId)
        }
      };
    }

    return {
      earliestTime,
      latestTime,
      totalDuration,
      timelineWidth,
      totalAvailableWidth,
      unstartedJobsZoneStart,
      unstartedJobsZoneWidth,
      totalHeight: currentY + 20,
      stagePositions,
      jobPositions,
      dependencyLines,
      pipelineLabels,
      criticalPath
    };
  }, [pipeline, transformedPipeline, containerWidth]);

  const formatDuration = (seconds: number | null) => {
    if (seconds === null) return 'N/A';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${secs}s`;
    return `${secs}s`;
  };

  const formatTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString();
  };

  const getPipelineLabelText = (pipeline: GitLabPipeline) => {
    if (pipeline.trigger_job) {
      return pipeline.trigger_job.name;
    }
    return `Pipeline #${pipeline.id}`;
  };

  // Calculate timeline intervals for ruler
  const calculateTimelineIntervals = (durationMs: number, timelineWidth: number) => {
    const durationMinutes = durationMs / 1000 / 60;
    
    // Determine appropriate interval based on duration
    let intervalMinutes = 1;
    if (durationMinutes > 60) {
      intervalMinutes = 10;
    } else if (durationMinutes > 30) {
      intervalMinutes = 5;
    } else if (durationMinutes > 15) {
      intervalMinutes = 2;
    }
    
    const intervals: Array<{ position: number; label: string; minutes: number }> = [];
    const intervalMs = intervalMinutes * 60 * 1000;
    const numIntervals = Math.ceil(durationMs / intervalMs);
    
    for (let i = 0; i <= numIntervals; i++) {
      const timeMs = i * intervalMs;
      if (timeMs <= durationMs) {
        const position = (timeMs / durationMs) * timelineWidth;
        const totalMinutes = Math.floor(timeMs / 1000 / 60);
        const minutes = totalMinutes % 60;
        const hours = Math.floor(totalMinutes / 60);
        
        let label = '';
        if (hours > 0) {
          label = `${hours}h ${minutes}m`;
        } else {
          label = `${minutes}m`;
        }
        
        intervals.push({ position, label, minutes: totalMinutes });
      }
    }
    
    return intervals;
  };

  const getJobColor = (status: string, isManual: boolean = false) => {
    // All manual jobs (triggered or not) are purple
    if (isManual) {
      return '#8b5cf6';
    }
    
    const colors: Record<string, string> = {
      success: '#10b981',
      failed: '#ef4444',
      running: '#3b82f6',
      pending: '#f59e0b',
      created: '#f59e0b',
      canceled: '#9ca3af',
      cancelled: '#9ca3af',
      skipped: '#06b6d4',  // Cyan for skipped
      manual: '#8b5cf6'    // Purple for manual (fallback, but we check isManual above)
    };
    return colors[status] || '#9ca3af';
  };

  if (!timelineLayout) {
    return (
      <div className="pipeline-timeline">
        <div className="no-jobs">No jobs found in this pipeline</div>
      </div>
    );
  }

  const { allJobsWithPipeline } = transformedPipeline;
  const totalJobDuration = allJobsWithPipeline.reduce((sum, { job }) => sum + (job.duration || 0), 0);
  const totalSpanSeconds = timelineLayout.totalDuration / 1000; // Time from earliest to latest job
  const pipelineDurationSeconds = pipeline.duration || 0; // Pipeline's actual duration field
  const parallelizationFactor = pipelineDurationSeconds > 0 ? totalJobDuration / pipelineDurationSeconds : 0;

  // Check for retried jobs and triggered manual jobs
  const hasRetriedJobs = allJobsWithPipeline.some(({ job }) => job.retried === true);
  const hasTriggeredManualJobs = allJobsWithPipeline.some(({ job }) => 
    job.when === 'manual' && job.started_at !== null // Manual job that was actually triggered (has started)
  );

  const svgWidth = TIMELINE_START_X + timelineLayout.totalAvailableWidth + 20;

  return (
    <div className="pipeline-timeline">
      {/* Header with metrics - keeping as HTML for now */}
      <div className="timeline-header">
        <div className="timeline-info">
          <div className="timeline-label">Duration</div>
          <div className="timeline-time">{formatDuration(pipelineDurationSeconds)}</div>
        </div>
        <div className="timeline-info">
          <div className="timeline-label" style={{ position: 'relative', display: 'inline-block' }}>
            Total Span
            {(hasRetriedJobs || hasTriggeredManualJobs) && (
              <span style={{ 
                position: 'absolute', 
                left: '70px', 
                top: '50%', 
                transform: 'translateY(-50%)',
                display: 'inline-flex', 
                gap: '2px',
                whiteSpace: 'nowrap'
              }}>
                {hasRetriedJobs && (
                  <span 
                    className="tooltip-container"
                    style={{ 
                      fontSize: '14px',
                      cursor: 'help',
                      display: 'inline-block',
                      position: 'relative'
                    }}
                  >
                    🔄
                    <span className="tooltip-text" style={{
                      visibility: 'hidden',
                      backgroundColor: '#1f2937',
                      color: '#fff',
                      textAlign: 'center',
                      borderRadius: '6px',
                      padding: '8px 12px',
                      position: 'absolute',
                      zIndex: 1000,
                      bottom: '125%',
                      left: '50%',
                      transform: 'translateX(-50%)',
                      whiteSpace: 'nowrap',
                      fontSize: '12px',
                      fontWeight: 'normal',
                      boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
                      pointerEvents: 'none',
                      textTransform: 'none'
                    }}>
                      Total span may be larger due to retried jobs
                    </span>
                  </span>
                )}
                {hasTriggeredManualJobs && (
                  <span 
                    className="tooltip-container"
                    style={{ 
                      fontSize: '14px',
                      cursor: 'help',
                      display: 'inline-block',
                      position: 'relative'
                    }}
                  >
                    ⏯️
                    <span className="tooltip-text" style={{
                      visibility: 'hidden',
                      backgroundColor: '#1f2937',
                      color: '#fff',
                      textAlign: 'center',
                      borderRadius: '6px',
                      padding: '8px 12px',
                      position: 'absolute',
                      zIndex: 1000,
                      bottom: '125%',
                      left: '50%',
                      transform: 'translateX(-50%)',
                      whiteSpace: 'nowrap',
                      fontSize: '12px',
                      fontWeight: 'normal',
                      boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
                      pointerEvents: 'none',
                      textTransform: 'none'
                    }}>
                      Total span may be larger due to manually triggered jobs
                    </span>
                  </span>
                )}
              </span>
            )}
          </div>
          <div className="timeline-time">{formatDuration(totalSpanSeconds)}</div>
        </div>
        <div className="timeline-info">
          <div className="timeline-label">Parallelization</div>
          <div className="timeline-time">{parallelizationFactor.toFixed(1)}x</div>
        </div>
        <div className="timeline-info">
          <div className="timeline-label">Jobs</div>
          <div className="timeline-time">{allJobsWithPipeline.length}</div>
        </div>
        <div className="timeline-info">
          <div className="timeline-label">Time Range</div>
          <div className="timeline-time" style={{ fontSize: '0.85em' }}>
            {formatTime(timelineLayout.earliestTime)} - {formatTime(timelineLayout.latestTime)}
          </div>
        </div>
      </div>

      {/* Dependency Legend */}
      <div style={{
        fontSize: '11px',
        color: '#6b7280',
        marginBottom: '8px',
        display: 'flex',
        gap: '16px',
        alignItems: 'center'
      }}>
        <span style={{ fontWeight: '600' }}>Dependencies:</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <svg width="30" height="2" style={{ verticalAlign: 'middle' }}>
            <line x1="0" y1="1" x2="30" y2="1" stroke="#6366f1" strokeWidth="2" opacity="0.6" />
          </svg>
          <span>DAG (needs)</span>
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <svg width="30" height="2" style={{ verticalAlign: 'middle' }}>
            <line x1="0" y1="1" x2="30" y2="1" stroke="#10b981" strokeWidth="1.5" strokeDasharray="4,4" opacity="0.4" />
          </svg>
          <span>Stage (previous stage)</span>
        </span>
      </div>

      {/* SVG Timeline */}
      <div className="timeline-svg-container" ref={containerRef}>
        <svg
          width="100%"
          height={timelineLayout.totalHeight}
          style={{ backgroundColor: '#f9fafb', minWidth: svgWidth }}
        >
          <defs>
            <marker
              id="arrowhead"
              markerWidth="8"
              markerHeight="8"
              refX="8"
              refY="4"
              orient="auto"
            >
              <path d="M0,0 L0,8 L8,4 z" fill="#6366f1" />
            </marker>
          </defs>

          {/* Critical Path Visualization */}
          {timelineLayout.criticalPath && (
            <g className="critical-path">
              {/* Visual separator with gap and distinct background */}
              <rect
                x={TIMELINE_START_X - 5}
                y={HEADER_HEIGHT - 3}
                width={timelineLayout.timelineWidth + 10}
                height={CRITICAL_PATH_HEIGHT + 6}
                fill="#fef3c7"
                stroke="#f59e0b"
                strokeWidth="2"
                rx="6"
              />
              
              {/* Critical path bar background */}
              <rect
                x={TIMELINE_START_X}
                y={HEADER_HEIGHT}
                width={timelineLayout.timelineWidth}
                height={CRITICAL_PATH_HEIGHT}
                fill="#fffbeb"
                stroke="#fbbf24"
                strokeWidth="1.5"
                rx="4"
              />
              
              {/* Label */}
              <text
                x={TIMELINE_START_X + 8}
                y={HEADER_HEIGHT + 18}
                fontSize="11"
                fontWeight="600"
                fill="#92400e"
              >
                CRITICAL PATH
              </text>

              {/* Render critical path segments */}
              {timelineLayout.criticalPath.path.map((node: any, index: number) => {
                const startPercent = ((node.startTime - timelineLayout.earliestTime) / timelineLayout.totalDuration) * 100;
                const widthPercent = ((node.endTime - node.startTime) / timelineLayout.totalDuration) * 100;
                const x = TIMELINE_START_X + (startPercent / 100) * timelineLayout.timelineWidth;
                const width = Math.max(10, (widthPercent / 100) * timelineLayout.timelineWidth);
                const y = HEADER_HEIGHT + CRITICAL_PATH_HEIGHT - CRITICAL_PATH_BAR_HEIGHT - 5;
                const critPath = timelineLayout.criticalPath!; // Non-null assertion since we're inside the if block

                return (
                  <g key={index}>
                    {/* Job segment */}
                    <rect
                      x={x}
                      y={y}
                      width={width}
                      height={CRITICAL_PATH_BAR_HEIGHT}
                      fill={getJobColor(node.job.status, node.job.when === 'manual')}
                      stroke="rgba(0,0,0,0.3)"
                      strokeWidth="1.5"
                      rx="3"
                      style={{ cursor: 'pointer' }}
                      onClick={() => onJobClick(node.job)}
                    >
                      <title>
                        {node.job.name}
                        {node.job.duration ? ` - ${formatDuration(node.job.duration)}` : ''}
                        {index < critPath.path.length - 1 ? ` → ${critPath.path[index + 1].job.name}` : ''}
                      </title>
                    </rect>

                    {/* Job name if space allows */}
                    {width > 40 && (
                      <text
                        x={x + width / 2}
                        y={y + CRITICAL_PATH_BAR_HEIGHT / 2}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fontSize="9"
                        fontWeight="600"
                        fill="white"
                        pointerEvents="none"
                        style={{
                          textShadow: '0 1px 2px rgba(0,0,0,0.4)'
                        }}
                      >
                        {node.job.name.length > 8 ? node.job.name.substring(0, 8) + '...' : node.job.name}
                      </text>
                    )}

                    {/* Dependency arrow to next job */}
                    {index < critPath.path.length - 1 && (() => {
                      const nextNode = critPath.path[index + 1];
                      const nextStartPercent = ((nextNode.startTime - timelineLayout.earliestTime) / timelineLayout.totalDuration) * 100;
                      const nextX = TIMELINE_START_X + (nextStartPercent / 100) * timelineLayout.timelineWidth;
                      const x1 = x + width;
                      const x2 = nextX;
                      const y1 = y + CRITICAL_PATH_BAR_HEIGHT / 2;
                      const y2 = y + CRITICAL_PATH_BAR_HEIGHT / 2;

                      // Determine dependency type
                      const depType = nextNode.dependencyType || 'needs';
                      // Only 'needs' within same pipeline get blue solid, everything else (stage/trigger) gets green dashed
                      const strokeColor = depType === 'needs' ? '#6366f1' : '#10b981';
                      const strokeWidth = depType === 'needs' ? '2' : '1.5';
                      const dashArray = depType === 'needs' ? 'none' : '4,4';
                      const opacity = depType === 'needs' ? '0.6' : '0.4'; // Same as regular view

                      // Show gap indicator if there's waiting time
                      const gap = nextNode.startTime - node.endTime;
                      const hasGap = gap > 1000; // More than 1 second

                      return (
                        <g>
                          {/* Dependency line */}
                          <line
                            x1={x1}
                            y1={y1}
                            x2={x2}
                            y2={y2}
                            stroke={strokeColor}
                            strokeWidth={strokeWidth}
                            strokeDasharray={dashArray}
                            opacity={opacity}
                          >
                            <title>
                              {node.job.name} → {nextNode.job.name} ({depType})
                              {hasGap ? ` - Wait: ${formatDuration(gap / 1000)}` : ''}
                            </title>
                          </line>

                          {/* Gap indicator - shown in tooltip only */}
                        </g>
                      );
                    })()}
                  </g>
                );
              })}
            </g>
          )}

          {/* Timeline Ruler */}
          <g className="timeline-ruler">
            {/* Ruler background */}
            <rect
              x={TIMELINE_START_X}
              y={HEADER_HEIGHT + CRITICAL_PATH_HEIGHT + CRITICAL_PATH_BOTTOM_MARGIN}
              width={timelineLayout.timelineWidth}
              height={TIMELINE_RULER_HEIGHT}
              fill="white"
              stroke="#e5e7eb"
              strokeWidth="1"
            />
            
            {/* Ruler intervals */}
            {calculateTimelineIntervals(timelineLayout.totalDuration, timelineLayout.timelineWidth).map((interval, idx) => (
              <g key={idx}>
                {/* Tick mark */}
                <line
                  x1={TIMELINE_START_X + interval.position}
                  y1={HEADER_HEIGHT + CRITICAL_PATH_HEIGHT + CRITICAL_PATH_BOTTOM_MARGIN}
                  x2={TIMELINE_START_X + interval.position}
                  y2={HEADER_HEIGHT + CRITICAL_PATH_HEIGHT + CRITICAL_PATH_BOTTOM_MARGIN + TIMELINE_RULER_HEIGHT}
                  stroke="#d1d5db"
                  strokeWidth="1"
                />
                
                {/* Vertical grid line */}
                <line
                  x1={TIMELINE_START_X + interval.position}
                  y1={HEADER_HEIGHT + CRITICAL_PATH_HEIGHT + CRITICAL_PATH_BOTTOM_MARGIN + TIMELINE_RULER_HEIGHT}
                  x2={TIMELINE_START_X + interval.position}
                  y2={timelineLayout.totalHeight}
                  stroke="#e5e7eb"
                  strokeWidth="1"
                  opacity="0.5"
                />
                
                {/* Time label */}
                <text
                  x={TIMELINE_START_X + interval.position}
                  y={HEADER_HEIGHT + CRITICAL_PATH_HEIGHT + CRITICAL_PATH_BOTTOM_MARGIN + TIMELINE_RULER_HEIGHT / 2}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize="10"
                  fill="#6b7280"
                  fontWeight="500"
                >
                  {interval.label}
                </text>
              </g>
            ))}
          </g>

          {/* Background for unstarted jobs zone */}
          <rect
            x={timelineLayout.unstartedJobsZoneStart}
            y={HEADER_HEIGHT + CRITICAL_PATH_HEIGHT + CRITICAL_PATH_BOTTOM_MARGIN + TIMELINE_RULER_HEIGHT}
            width={timelineLayout.unstartedJobsZoneWidth}
            height={timelineLayout.totalHeight - HEADER_HEIGHT - CRITICAL_PATH_HEIGHT - TIMELINE_RULER_HEIGHT}
            fill="#f3f4f6"
            opacity="0.5"
          />
          
          {/* Separator line for unstarted zone */}
          <line
            x1={timelineLayout.unstartedJobsZoneStart}
            y1={HEADER_HEIGHT + CRITICAL_PATH_HEIGHT + CRITICAL_PATH_BOTTOM_MARGIN + TIMELINE_RULER_HEIGHT}
            x2={timelineLayout.unstartedJobsZoneStart}
            y2={timelineLayout.totalHeight}
            stroke="#d1d5db"
            strokeWidth="2"
            strokeDasharray="5,5"
          />

          {/* Label for unstarted zone */}
          <text
            x={timelineLayout.unstartedJobsZoneStart + timelineLayout.unstartedJobsZoneWidth / 2}
            y={HEADER_HEIGHT + CRITICAL_PATH_HEIGHT + CRITICAL_PATH_BOTTOM_MARGIN + TIMELINE_RULER_HEIGHT / 2}
            textAnchor="middle"
            fontSize="10"
            fill="#6b7280"
            fontWeight="600"
          >
            Not Started
          </text>

          {/* Pipeline labels (for child pipelines) */}
          {timelineLayout.pipelineLabels.map((label, labelIndex) => (
            <g key={labelIndex} className="pipeline-label-group">
              {/* Background bar */}
              <rect
                x={TIMELINE_START_X}
                y={label.y}
                width={timelineLayout.timelineWidth}
                height={28}
                fill="#f3f4f6"
                stroke="#e5e7eb"
                strokeWidth="1"
                rx="4"
              />
              
              {/* Pipeline name (clickable) */}
              <text
                x={TIMELINE_START_X + 10}
                y={label.y + 14}
                dominantBaseline="middle"
                fontSize="11"
                fontWeight="700"
                fill="#4b5563"
                style={{ cursor: 'pointer', textDecoration: 'underline' }}
                onClick={() => window.open(label.pipeline.web_url, '_blank')}
              >
                {getPipelineLabelText(label.pipeline)}
              </text>
              
              {/* Pipeline ID */}
              <text
                x={TIMELINE_START_X + 10}
                y={label.y + 14}
                dominantBaseline="middle"
                fontSize="9"
                fill="#6b7280"
                dx={getPipelineLabelText(label.pipeline).length * 6 + 10}
              >
                (#{label.pipeline.id})
              </text>
            </g>
          ))}

          {/* Render stages and jobs */}
          {timelineLayout.stagePositions.map((stage, stageIndex) => (
            <g key={stageIndex}>
              {/* Stage background */}
              <rect
                x={TIMELINE_START_X}
                y={stage.y}
                width={timelineLayout.timelineWidth}
                height={stage.height}
                fill="white"
                stroke="#e5e7eb"
                strokeWidth="1"
                rx="4"
              />

              {/* Stage name */}
              <text
                x={STAGE_NAME_WIDTH - 10}
                y={stage.y + stage.height / 2}
                textAnchor="end"
                dominantBaseline="middle"
                fontSize="11"
                fontWeight="600"
                fill="#4b5563"
              >
                {stage.name}
              </text>
              <text
                x={STAGE_NAME_WIDTH - 10}
                y={stage.y + stage.height / 2 + 12}
                textAnchor="end"
                fontSize="9"
                fill="#9ca3af"
              >
                {stage.jobs.length}j
              </text>

              {/* Render jobs */}
              {stage.jobs.map((job: any, jobIndex: number) => (
                <g key={jobIndex}>
                  {/* Job bar */}
                  <rect
                    x={job.x}
                    y={job.y}
                    width={job.width}
                    height={JOB_HEIGHT}
                    fill={getJobColor(job.status, job.when === 'manual')}
                    stroke={hoveredJob === job.id ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.2)'}
                    strokeWidth={hoveredJob === job.id ? '2' : '1'}
                    rx="3"
                    style={{ cursor: 'pointer' }}
                    onMouseEnter={() => setHoveredJob(job.id)}
                    onMouseLeave={() => setHoveredJob(null)}
                    onClick={() => onJobClick(job)}
                  >
                    <title>
                      {job.name} - {job.status}
                      {job.duration ? ` - ${formatDuration(job.duration)}` : ''}
                      {job.when === 'manual' ? ' (Manual)' : ''}
                      {job.retried ? ' (Retried)' : ''}
                    </title>
                  </rect>

                  {/* Retry icon for retried jobs */}
                  {job.retried && (
                    <g transform={`translate(${job.x + job.width - 18}, ${job.y + 3})`}>
                      <circle
                        cx="8"
                        cy="8"
                        r="7"
                        fill="rgba(255, 255, 255, 0.9)"
                        stroke="rgba(0, 0, 0, 0.3)"
                        strokeWidth="0.5"
                      />
                      <path
                        d="M 8 4 A 4 4 0 1 1 4 8 M 8 4 L 8 6 L 10 6"
                        stroke="#f59e0b"
                        strokeWidth="1.5"
                        fill="none"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </g>
                  )}

                  {/* Job name (if space allows) */}
                  {job.width > 50 && (
                    <text
                      x={job.x + 6}
                      y={job.y + JOB_HEIGHT / 2}
                      dominantBaseline="middle"
                      fontSize="10"
                      fontWeight="600"
                      fill="white"
                      pointerEvents="none"
                      style={{
                        textShadow: '0 1px 2px rgba(0,0,0,0.3)'
                      }}
                    >
                      {job.name.length > 20 ? job.name.substring(0, 20) + '...' : job.name}
                    </text>
                  )}
                </g>
              ))}
            </g>
          ))}

          {/* Dependency lines */}
          <g className="dependency-lines">
            {timelineLayout.dependencyLines.map((line, index) => {
              // Only 'needs' within same pipeline get blue solid, everything else (stage/trigger) gets green dashed
              const strokeColor = line.type === 'needs' ? '#6366f1' : '#10b981';
              const strokeWidth = line.type === 'needs' ? '2' : '1.5';
              const opacity = line.type === 'needs' ? '0.6' : '0.4';
              const dashArray = line.type === 'needs' ? 'none' : '4,4';
              
              return (
                <g key={index}>
                  {/* Line path with slight curve */}
                  <path
                    d={`M ${line.x1} ${line.y1} C ${line.x1 + 20} ${line.y1}, ${line.x2 - 20} ${line.y2}, ${line.x2} ${line.y2}`}
                    stroke={strokeColor}
                    strokeWidth={strokeWidth}
                    strokeDasharray={dashArray}
                    fill="none"
                    opacity={opacity}
                  >
                    <title>{line.fromJob} → {line.toJob} ({line.type})</title>
                  </path>
                </g>
              );
            })}
          </g>
        </svg>
      </div>
    </div>
  );
};

export default React.memo(PipelineTimelineSVG);
