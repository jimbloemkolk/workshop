import type { GitLabPipelineBasic, GitLabJob, GraphQLResponse } from './types.js';
import {
  fetchPipelineBasic,
  fetchPipelineJobs,
  fetchJobDependenciesGraphQL,
} from './gitlabClient.js';
import {
  getCachedPipelineBasic,
  cachePipelineBasic,
  getCachedJobs,
  cacheJobs,
  getCachedGraphQLMetadata,
  cacheGraphQLMetadata,
  isPipelineComplete,
} from './cache.js';

/**
 * Fetch pipeline basic info with caching
 */
export async function fetchPipelineBasicCached(
  projectPath: string,
  pipelineId: number,
  pipelineStatus?: string
): Promise<{ data: GitLabPipelineBasic; fromCache: boolean }> {
  // Check cache if we know the pipeline is complete
  if (pipelineStatus && isPipelineComplete(pipelineStatus)) {
    const cached = getCachedPipelineBasic(pipelineId);
    if (cached) {
      return { data: cached, fromCache: true };
    }
  }

  // Fetch from API
  const data = await fetchPipelineBasic(projectPath, pipelineId);

  // Cache if complete
  if (isPipelineComplete(data.status)) {
    cachePipelineBasic(pipelineId, data.status, data);
  }

  return { data, fromCache: false };
}

/**
 * Fetch pipeline jobs with caching
 */
export async function fetchPipelineJobsCached(
  projectPath: string,
  pipelineId: number,
  pipelineStatus: string
): Promise<{ data: GitLabJob[]; fromCache: boolean }> {
  // Check cache if pipeline is complete
  if (isPipelineComplete(pipelineStatus)) {
    const cached = getCachedJobs(pipelineId);
    if (cached) {
      return { data: cached, fromCache: true };
    }
  }

  // Fetch from API
  const data = await fetchPipelineJobs(projectPath, pipelineId);

  // Cache if complete
  if (isPipelineComplete(pipelineStatus)) {
    cacheJobs(pipelineId, pipelineStatus, data);
  }

  return { data, fromCache: false };
}

/**
 * Fetch GraphQL job dependencies with caching
 */
export async function fetchJobDependenciesGraphQLCached(
  projectPath: string,
  pipelineId: number,
  pipelineStatus: string
): Promise<{ data: GraphQLResponse; fromCache: boolean }> {
  // Check cache if pipeline is complete
  if (isPipelineComplete(pipelineStatus)) {
    const cached = getCachedGraphQLMetadata(pipelineId);
    if (cached) {
      return { data: cached, fromCache: true };
    }
  }

  // Fetch from API
  const data = await fetchJobDependenciesGraphQL(projectPath, pipelineId);

  // Cache if complete
  if (isPipelineComplete(pipelineStatus)) {
    cacheGraphQLMetadata(pipelineId, pipelineStatus, data);
  }

  return { data, fromCache: false };
}
