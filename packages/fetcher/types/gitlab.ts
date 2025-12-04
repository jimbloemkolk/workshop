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
  when?: string; // manual, on_success, on_failure, always, delayed
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

export interface JobWithPipeline {
  job: GitLabJob;
  pipelineId: string | number;
  pipeline: GitLabPipeline;
}

export interface TransformedPipeline {
  earliestTime: number;
  latestTime: number;
  totalDuration: number;
  allJobsWithPipeline: JobWithPipeline[];
}

export interface Metadata {
  project: string;
  fetched_at: string;
  days_back: number;
  date_threshold: string;
  pipeline_count: number;
}
