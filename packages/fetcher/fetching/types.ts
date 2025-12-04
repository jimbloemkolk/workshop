export interface FetchOptions {
  projectPath: string;
  daysBack?: number;
  singlePipelineId?: number;
  outputToStdout?: boolean;
  rebuild?: boolean;
  debug?: boolean;
  datasetName?: string;
}

export interface GitLabPipelineBasic {
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
  source?: string;
}

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

export interface TriggerJob {
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
}

export interface GitLabPipelineFull extends GitLabPipelineBasic {
  jobs: GitLabJob[];
  child_pipelines?: GitLabPipelineFull[];
  trigger_job?: TriggerJob;
  fetched_at: string;
}

export interface JobMetadata {
  schedulingType?: 'dag' | 'stage';
  needs?: string[];
  previousStageJobs?: string[];
  when?: string;
  retried?: boolean;
}

export interface GraphQLResponse {
  data?: {
    project?: {
      pipeline?: {
        stages?: any;
        downstream?: any;
      };
    };
  };
}

export interface CacheEntry<T> {
  data: T;
  cachedAt: string;
  pipelineStatus: string;
}

export interface FailedPipeline {
  pipelineId: number;
  pipelineIid: number;
  pipelineRef: string;
  error: string;
}

export interface FetchResult {
  pipelines: GitLabPipelineFull[];
  failed: FailedPipeline[];
  metadata: {
    dataset_name: string;
    project: string;
    fetched_at: string;
    days_back: number;
    date_threshold: string;
    pipeline_count: number;
    new_pipelines: number;
    existing_pipelines: number;
    failed_pipelines: number;
    cached_pipelines: number;
    failed_pipeline_details: FailedPipeline[];
  };
}
