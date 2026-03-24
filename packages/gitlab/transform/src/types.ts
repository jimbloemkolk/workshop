// Input types (raw GitLab data)
export interface GitLabJob {
  id: number;
  name: string;
  stage: string;
  status: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  duration: number | null;
  queued_duration?: number | null;
  web_url: string;
  user: {
    id: number;
    name: string;
    username: string;
    avatar_url: string;
  } | null;
  runner: {
    id: number;
    description: string;
    active: boolean;
  } | null;
  allow_failure: boolean;
  needs?: string[];
  schedulingType?: 'dag' | 'stage';
  previousStageJobs?: string[];
  when?: string;
  retried?: boolean;
}

export interface GitLabPipeline {
  id: number;
  iid: number;
  project_id: number;
  status: string;
  ref: string;
  sha: string;
  web_url: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  duration: number | null;
  user: {
    id: number;
    name: string;
    username: string;
    avatar_url: string;
  } | null;
  jobs: GitLabJob[];
  child_pipelines?: GitLabPipeline[];
  trigger_job?: {
    id: number;
    name: string;
    stage: string;
    status: string;
    created_at: string;
    started_at: string | null;
    finished_at: string | null;
    needs?: string[];
    schedulingType?: 'dag' | 'stage';
    previousStageJobs?: string[];
  };
  fetched_at: string;
  error?: string;
  source?: string;
}

// Output types (transformed for frontend consumption)

export interface TransformedJob {
  id: number;
  name: string;
  stage: string;
  status: string;
  pipelineId: number;
  startTime: number | null;
  endTime: number | null;
  duration: number | null;
  queuedDuration: number | null;
  isManual: boolean;
  isRetried: boolean;
  allowFailure: boolean;
}

export interface Dependency {
  from: {
    jobId: number;
    jobName: string;
    pipelineId: number;
  };
  to: {
    jobId: number;
    jobName: string;
    pipelineId: number;
  };
  type: 'needs' | 'stage' | 'trigger';
}

export interface PipelineNode {
  id: number;
  iid: number;
  parentId: number | null;
  triggerJobName: string | null;
  jobCount: number;
  status: string;
}

export interface CriticalPathNode {
  jobId: number;
  pipelineId: number;
  startTime: number;
  endTime: number;
  dependencyType?: 'needs' | 'stage' | 'trigger';
}

export interface JobImpact {
  jobId: number;
  job: GitLabJob;
  impact: number;
  percentage: number;
}

export interface TimelineJob extends GitLabJob {
  pendingStartPercent: number;
  pendingWidthPercent: number;
  startPercent: number;
  widthPercent: number;
  endPercent: number;
}

export interface TimelineStage {
  name: string;
  jobs: TimelineJob[];
}

export interface TimelinePipeline {
  pipelineId: number;
  pipeline: GitLabPipeline;
  isParent: boolean;
  stages: TimelineStage[];
}

export interface TransformedPipelineData {
  // Basic info
  pipelineId: number;
  pipelineIid: number;
  status: string;
  ref: string;
  webUrl: string;
  
  // Time boundaries
  earliestTime: number;
  latestTime: number;
  totalDuration: number;
  
  // Transformed data
  jobs: TransformedJob[];
  dependencies: Dependency[];
  pipelineHierarchy: PipelineNode[];
  
  // Analysis results
  criticalPath: CriticalPathNode[] | null;
  jobImpacts: JobImpact[];
  
  // Timeline layout (grouped and sorted for rendering)
  timelineLayout: TimelinePipeline[];
  
  // Statistics
  stats: {
    totalJobs: number;
    totalWaitingTime: number;
    totalExecutionTime: number;
    avgWaitingTime: number;
    avgExecutionTime: number;
    efficiency: number;
    parallelizationFactor: number;
    successCount: number;
    failedCount: number;
  };
}
