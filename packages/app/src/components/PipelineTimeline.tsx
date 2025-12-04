import React, { useMemo, useRef, useEffect, useState } from 'react';
import type { GitLabPipeline, TransformedPipeline } from '../types/gitlab';
import type { TransformedPipelineData } from '../../../transform/src/index';
import { getPipelineLabel } from '../../../transform/src/index';
import './PipelineTimeline.css';

interface PipelineTimelineProps {
  pipeline: GitLabPipeline;
  transformedPipeline: TransformedPipeline;
  transformedData?: TransformedPipelineData;
  onJobClick: (job: any) => void;
}

const PipelineTimeline: React.FC<PipelineTimelineProps> = ({ pipeline, transformedPipeline, transformedData, onJobClick }) => {
  const [jobElements, setJobElements] = useState<Map<string, DOMRect>>(new Map());
  const timelineRef = useRef<HTMLDivElement>(null);

  // Calculate timeline bounds and job positions
  const timelineData = useMemo(() => {
    const { earliestTime, latestTime, totalDuration } = transformedPipeline;
    
    // Use pre-calculated timeline layout from transform package if available
    if (transformedData?.timelineLayout) {
      const layoutWithRows = transformedData.timelineLayout.map(pipelineData => {
        const stagesWithRows = pipelineData.stages.map(stage => {
          // Jobs already have position percentages from transform package
          // We only need to assign rows based on visual overlap
          const jobsWithRows = stage.jobs.map(job => ({ ...job, row: 0 }));
          const rows: Array<{ endPercent: number }> = [];
          
          jobsWithRows.sort((a, b) => {
            const aHasStarted = a.started_at ? 0 : 1;
            const bHasStarted = b.started_at ? 0 : 1;
            if (aHasStarted !== bHasStarted) return aHasStarted - bHasStarted;
            return a.startPercent - b.startPercent;
          });

          const GAP = 0.2;

          jobsWithRows.forEach(job => {
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
          });

          return {
            name: stage.name,
            jobs: jobsWithRows,
            rowCount: rows.length
          };
        });

        return {
          pipelineId: pipelineData.pipelineId,
          pipeline: pipelineData.pipeline,
          isParent: pipelineData.isParent,
          stages: stagesWithRows,
          totalJobCount: pipelineData.stages.reduce((sum, s) => sum + s.jobs.length, 0),
          totalRowCount: stagesWithRows.reduce((sum, stage) => sum + stage.rowCount, 0)
        };
      });

      return {
        earliestTime,
        latestTime,
        totalDuration,
        pipelines: layoutWithRows
      };
    }

    // Fallback to old logic if transformedData not available
    const { allJobsWithPipeline } = transformedPipeline;
    
    if (allJobsWithPipeline.length === 0) {
      return null;
    }

    // Group jobs by pipeline first (depth-first), then by stage within each pipeline
    interface PipelineStageGroup {
      pipelineId: string | number;
      pipeline: GitLabPipeline;
      stages: Map<string, any[]>;
      isParent: boolean;
    }
    
    const pipelineGroups: PipelineStageGroup[] = [];
    const pipelineMap = new Map<string | number, PipelineStageGroup>();
    
    allJobsWithPipeline.forEach(({ job, pipelineId, pipeline: jobPipeline }) => {
      if (!pipelineMap.has(pipelineId)) {
        const group: PipelineStageGroup = {
          pipelineId,
          pipeline: jobPipeline,
          stages: new Map(),
          isParent: pipelineId === pipeline.id
        };
        pipelineMap.set(pipelineId, group);
        pipelineGroups.push(group);
      }
      
      const group = pipelineMap.get(pipelineId)!;
      if (!group.stages.has(job.stage)) {
        group.stages.set(job.stage, []);
      }
      group.stages.get(job.stage)!.push(job);
    });

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

    // Build stages with pipeline grouping (depth-first)
    const stages = pipelineGroups.map(pipelineGroup => {
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

      const stageRows = sortedStageEntries.map(([stageName, jobs]) => {
        const jobsWithPosition = jobs.map(job => {
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

        const jobsWithRows = jobsWithPosition.map(job => ({ ...job, row: 0 }));
        const rows: Array<{ endPercent: number }> = [];
        
        jobsWithRows.sort((a, b) => {
          const aHasStarted = a.started_at ? 0 : 1;
          const bHasStarted = b.started_at ? 0 : 1;
          if (aHasStarted !== bHasStarted) return aHasStarted - bHasStarted;
          return a.startPercent - b.startPercent;
        });

        const GAP = 0.2;

        jobsWithRows.forEach(job => {
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
        });

        return {
          name: stageName,
          jobs: jobsWithRows,
          rowCount: rows.length
        };
      });

      return {
        pipelineId: pipelineGroup.pipelineId,
        pipeline: pipelineGroup.pipeline,
        isParent: pipelineGroup.isParent,
        stages: stageRows,
        totalJobCount: Array.from(pipelineGroup.stages.values()).reduce((sum, jobs) => sum + jobs.length, 0),
        totalRowCount: stageRows.reduce((sum, stage) => sum + stage.rowCount, 0)
      };
    });

    const result = {
      earliestTime,
      latestTime,
      totalDuration,
      pipelines: stages
    };
    
    console.log('Pipeline layout:', stages.map(p => ({ 
      pipelineId: p.pipelineId,
      isParent: p.isParent,
      stageCount: p.stages.length,
      totalJobCount: p.totalJobCount,
      totalRowCount: p.totalRowCount
    })));
    
    return result;
  }, [pipeline, transformedPipeline, transformedData]);

  // Update job element positions for dependency lines
  useEffect(() => {
    if (!timelineRef.current) return;
    
    const updatePositions = () => {
      const newPositions = new Map<string, DOMRect>();
      const jobBars = timelineRef.current?.querySelectorAll('.job-bar');
      
      jobBars?.forEach((element) => {
        const jobId = element.getAttribute('data-job-id');
        if (jobId) {
          const rect = element.getBoundingClientRect();
          newPositions.set(jobId, rect);
        }
      });
      
      setJobElements(newPositions);
    };
    
    // Initial update
    updatePositions();
    
    // Update on scroll or resize
    const timeline = timelineRef.current;
    const stagesContainer = timeline.querySelector('.timeline-stages');
    
    if (stagesContainer) {
      stagesContainer.addEventListener('scroll', updatePositions);
    }
    window.addEventListener('resize', updatePositions);
    
    return () => {
      if (stagesContainer) {
        stagesContainer.removeEventListener('scroll', updatePositions);
      }
      window.removeEventListener('resize', updatePositions);
    };
  }, [timelineData]);

  // Calculate dependency lines
  const dependencyLines = useMemo(() => {
    if (!timelineData || jobElements.size === 0) return [];
    
    const lines: Array<{
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      fromJob: string;
      toJob: string;
    }> = [];
    
    const timelineRect = timelineRef.current?.getBoundingClientRect();
    if (!timelineRect) return lines;
    
    // Build a map of job name -> job data with position
    const jobMap = new Map<string, any>();
    timelineData.pipelines.forEach(pipelineData => {
      pipelineData.stages.forEach(stage => {
        stage.jobs.forEach((job: any) => {
          const jobId = `job-${job.id}`;
          const rect = jobElements.get(jobId);
          if (rect) {
            jobMap.set(job.name, {
              job,
              rect,
              x: rect.left + rect.width / 2 - timelineRect.left,
              y: rect.top + rect.height / 2 - timelineRect.top
            });
          }
        });
      });
    });
    
    // Create lines for each dependency
    jobMap.forEach((toJobData) => {
      if (toJobData.job.needs && Array.isArray(toJobData.job.needs)) {
        toJobData.job.needs.forEach((needsJobName: string) => {
          const fromJobData = jobMap.get(needsJobName);
          if (fromJobData) {
            lines.push({
              x1: fromJobData.x,
              y1: fromJobData.y,
              x2: toJobData.x,
              y2: toJobData.y,
              fromJob: needsJobName,
              toJob: toJobData.job.name
            });
          }
        });
      }
    });
    
    return lines;
  }, [timelineData, jobElements]);

  const formatDuration = (seconds: number | null) => {
    if (seconds === null) return 'N/A';
    
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${secs}s`;
    } else {
      return `${secs}s`;
    }
  };

  const formatTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString();
  };

  // Calculate pipeline metrics
  const pipelineMetrics = useMemo(() => {
    const { allJobsWithPipeline } = transformedPipeline;
    
    if (allJobsWithPipeline.length === 0) {
      return null;
    }

    let totalWaitingTime = 0;
    let totalExecutionTime = 0;
    let jobsWithWaiting = 0;
    let jobsWithExecution = 0;
    let successfulJobs = 0;
    let failedJobs = 0;
    let totalJobDuration = 0;

    allJobsWithPipeline.forEach(({ job }) => {
      if (job.queued_duration) {
        totalWaitingTime += job.queued_duration;
        jobsWithWaiting++;
      } else if (job.created_at && job.started_at) {
        const waitTime = (new Date(job.started_at).getTime() - new Date(job.created_at).getTime()) / 1000;
        totalWaitingTime += waitTime;
        jobsWithWaiting++;
      }

      if (job.duration) {
        totalExecutionTime += job.duration;
        jobsWithExecution++;
        totalJobDuration += job.duration;
      }

      if (job.status === 'success') successfulJobs++;
      if (job.status === 'failed') failedJobs++;
    });

    const avgWaitingTime = jobsWithWaiting > 0 ? totalWaitingTime / jobsWithWaiting : 0;
    const avgExecutionTime = jobsWithExecution > 0 ? totalExecutionTime / jobsWithExecution : 0;
    const efficiency = totalExecutionTime > 0 ? (totalExecutionTime / (totalWaitingTime + totalExecutionTime)) * 100 : 0;
    
    const pipelineDurationSeconds = timelineData ? timelineData.totalDuration / 1000 : 1;
    const parallelizationFactor = totalJobDuration / pipelineDurationSeconds;

    const totalStages = timelineData?.pipelines.reduce((sum, p) => sum + p.stages.length, 0) || 0;

    return {
      totalWaitingTime,
      totalExecutionTime,
      avgWaitingTime,
      avgExecutionTime,
      efficiency,
      parallelizationFactor,
      totalJobs: allJobsWithPipeline.length,
      totalStages,
      successfulJobs,
      failedJobs,
      totalJobDuration
    };
  }, [transformedPipeline, timelineData]);

  if (!timelineData) {
    return (
      <div className="pipeline-timeline">
        <div className="no-jobs">No jobs found in this pipeline</div>
      </div>
    );
  }

  return (
    <div className="pipeline-timeline" ref={timelineRef}>
      <div className="timeline-header">
        <div className="timeline-info">
          <div className="timeline-label">Pipeline Duration</div>
          <div className="timeline-time">
            {formatDuration(timelineData.totalDuration / 1000)}
          </div>
        </div>
        
        {pipelineMetrics && (
          <>
            <div className="timeline-info">
              <div className="timeline-label">Total Waiting</div>
              <div className="timeline-time" title={`Average: ${formatDuration(pipelineMetrics.avgWaitingTime)}`}>
                {formatDuration(pipelineMetrics.totalWaitingTime)}
              </div>
            </div>
            
            <div className="timeline-info">
              <div className="timeline-label">Total Execution</div>
              <div className="timeline-time" title={`Average: ${formatDuration(pipelineMetrics.avgExecutionTime)}`}>
                {formatDuration(pipelineMetrics.totalExecutionTime)}
              </div>
            </div>
            
            <div className="timeline-info">
              <div className="timeline-label">Efficiency</div>
              <div className="timeline-time" title="Execution time / (Waiting + Execution)">
                {pipelineMetrics.efficiency.toFixed(1)}%
              </div>
            </div>
            
            <div className="timeline-info">
              <div className="timeline-label">Parallelization</div>
              <div className="timeline-time" title={`${formatDuration(pipelineMetrics.totalJobDuration)} work in ${formatDuration(timelineData.totalDuration / 1000)}`}>
                {pipelineMetrics.parallelizationFactor.toFixed(1)}x
              </div>
            </div>
            
            <div className="timeline-info">
              <div className="timeline-label">Jobs</div>
              <div className="timeline-time" title={`${pipelineMetrics.successfulJobs} succeeded, ${pipelineMetrics.failedJobs} failed`}>
                {pipelineMetrics.totalJobs} / {pipelineMetrics.totalStages} stages
              </div>
            </div>
          </>
        )}

        <div className="timeline-info">
          <div className="timeline-label">Time Range</div>
          <div className="timeline-time" style={{ fontSize: '0.85em' }}>
            {formatTime(timelineData.earliestTime)} - {formatTime(timelineData.latestTime)}
          </div>
        </div>
      </div>

      {/* Dependency lines overlay */}
      {dependencyLines.length > 0 && (
        <svg className="dependency-lines-overlay" style={{ pointerEvents: 'none' }}>
          {dependencyLines.map((line, index) => (
            <g key={index}>
              <line
                x1={line.x1}
                y1={line.y1}
                x2={line.x2}
                y2={line.y2}
                className="dependency-line"
                markerEnd="url(#arrowhead)"
              />
            </g>
          ))}
          <defs>
            <marker
              id="arrowhead"
              markerWidth="10"
              markerHeight="10"
              refX="9"
              refY="3"
              orient="auto"
              markerUnits="strokeWidth"
            >
              <path d="M0,0 L0,6 L9,3 z" fill="#6366f1" />
            </marker>
          </defs>
        </svg>
      )}

      <div className="timeline-stages">
        {timelineData.pipelines.map((pipelineData, pipelineIndex) => (
          <div key={pipelineIndex} className="timeline-pipeline" data-pipeline-type={pipelineData.isParent ? 'parent' : 'child'}>
            {!pipelineData.isParent && (
              <div className="pipeline-label">{getPipelineLabel(pipelineData.pipeline)}</div>
            )}
            <div className="pipeline-stages-container">
              {pipelineData.stages.map((stage, stageIndex) => (
                <div key={stageIndex} className="timeline-stage">
                  <div className="stage-name">
                    <span className="stage-name-text">{stage.name}</span>
                    <span className="stage-job-count">
                      {stage.jobs.length}j
                    </span>
                  </div>
                  <div 
                    className="stage-jobs"
                    style={{
                      height: `${stage.rowCount * 22 + 8}px`,
                      minHeight: `${stage.rowCount * 22 + 8}px`
                    }}
                  >
                    {stage.jobs.map((job: any, jobIndex: number) => (
                      <div key={jobIndex} className="job-wrapper">
                        {job.pendingWidthPercent > 0 && (
                          <div
                            className="job-queue-marker"
                            style={{
                              left: `${job.pendingStartPercent}%`,
                              top: `${job.row * 22 + 7}px`
                            }}
                            title={`Queued: ${job.name}`}
                          />
                        )}
                        {job.pendingWidthPercent > 0 && (
                          <div
                            className="job-pending"
                            style={{
                              left: `${job.pendingStartPercent}%`,
                              width: `${job.pendingWidthPercent}%`,
                              top: `${job.row * 22 + 11}px`
                            }}
                            title={`Pending: ${job.name}`}
                          />
                        )}
                        <div
                          className={`job-bar status-${job.status}`}
                          data-job-id={`job-${job.id}`}
                          style={{
                            left: `${job.startPercent}%`,
                            width: `${job.widthPercent}%`,
                            top: `${job.row * 22 + 4}px`
                          }}
                          onClick={() => onJobClick(job)}
                          title={`${job.name} - ${job.status}${job.duration ? ' - ' + formatDuration(job.duration) : ''}`}
                        >
                          <div className="job-bar-content">
                            <span className="job-name">{job.name}</span>
                            {job.duration && <span className="job-duration">{formatDuration(job.duration)}</span>}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default PipelineTimeline;
