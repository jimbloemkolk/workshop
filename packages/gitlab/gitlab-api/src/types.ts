/**
 * GitLab API response types.
 * 
 * These represent the raw shapes returned by the GitLab REST and GraphQL APIs.
 * They are intentionally close to the API response format, not domain-specific.
 */

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

/** Metadata extracted from GraphQL for a single job */
export interface JobMetadata {
  schedulingType?: 'dag' | 'stage';
  needs?: string[];
  previousStageJobs?: string[];
  when?: string;
  retried?: boolean;
}
