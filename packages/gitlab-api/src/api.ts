/**
 * GitLab API functions.
 * 
 * Each function takes a Transport, ApiCache, and cacheNamespace, making them
 * fully decoupled from both the transport mechanism and cache storage.
 * 
 * The cacheNamespace is the sanitized hostname of the GitLab instance,
 * ensuring cache data from different instances is never mixed.
 * 
 * Caching policy is controlled by the caller via the `shouldCache` option.
 * By default nothing is cached — callers opt-in to caching.
 */

import type { Transport } from './transport.js';
import type { ApiCache, CacheKey } from '@workshop/fetcher-core';
import { restCacheKey, graphqlCacheKey } from '@workshop/fetcher-core';
import type {
  GitLabPipelineBasic,
  GitLabJob,
  GraphQLResponse,
} from './types.js';
import { apiMetrics } from '@workshop/fetcher-core';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Parse JSON with better error messages for HTML responses.
 * Extracts title or H1 from HTML to provide context.
 */
function safeJsonParse<T>(text: string, context: string): T {
  try {
    return JSON.parse(text);
  } catch (error) {
    // Check if response is HTML (common when VPN/auth issues occur)
    if (text.trim().startsWith('<')) {
      // Try to extract title or H1 for a better error message
      const titleMatch = text.match(/<title>([^<]+)<\/title>/i);
      const h1Match = text.match(/<h1[^>]*>([^<]+)<\/h1>/i);
      const message = titleMatch?.[1] || h1Match?.[1] || 'HTML page';
      
      throw new Error(
        `GitLab API returned HTML instead of JSON (${context}).\n` +
        `Page title: "${message.trim()}"\n` +
        `This usually means:\n` +
        `  • VPN connection required\n` +
        `  • Authentication failed (check: glab auth status)\n` +
        `  • Invalid GitLab URL\n` +
        `Preview: ${text.slice(0, 150)}...`
      );
    }
    throw error;
  }
}

// ─── API Options ─────────────────────────────────────────────────────────────

export interface ApiCallOptions {
  /** 
   * Predicate to decide if this response should be cached.
   * Receives the parsed response data. If not provided, the response is NOT cached.
   */
  shouldCache?: (data: any) => boolean;
  /** If true, skip reading from cache (but still write if shouldCache returns true) */
  forceRefresh?: boolean;
}

// ─── Pipeline List ───────────────────────────────────────────────────────────

export async function fetchPipelineList(
  transport: Transport,
  cache: ApiCache,
  cacheNamespace: string,
  projectPath: string,
  createdAfterISO: string,
  options?: ApiCallOptions
): Promise<GitLabPipelineBasic[]> {
  const key = restCacheKey(cacheNamespace, projectPath, 'pipelines', 'list', createdAfterISO);

  // Pipeline lists are typically not cached (always fetch fresh), but respect options
  if (!options?.forceRefresh) {
    const cached = cache.get<GitLabPipelineBasic[]>(key);
    if (cached && !options?.forceRefresh) return cached;
  }

  const startTime = Date.now();
  try {
    const url = `/projects/${encodeURIComponent(projectPath)}/pipelines?created_after=${encodeURIComponent(createdAfterISO)}&per_page=100&page=1`;
    const stdout = await transport.restGetPaginated(url);
    const duration = Date.now() - startTime;
    apiMetrics.recordCall('pipeline-list', duration);

    const pipelines: GitLabPipelineBasic[] = safeJsonParse(stdout, `fetching pipeline list for ${projectPath}`);

    if (options?.shouldCache?.(pipelines)) {
      cache.set(key, pipelines);
    }

    return pipelines;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const stderr = (error as any).stderr || '';

    if (errorMessage.includes('403') || stderr.includes('403')) {
      throw new Error('403 Forbidden: Not authorized to access GitLab API. Please check your authentication with "glab auth status"');
    }

    throw error;
  }
}

// ─── Pipeline Basic Details ──────────────────────────────────────────────────

export async function fetchPipelineBasic(
  transport: Transport,
  cache: ApiCache,
  cacheNamespace: string,
  projectPath: string,
  pipelineId: number,
  options?: ApiCallOptions
): Promise<{ data: GitLabPipelineBasic; fromCache: boolean }> {
  const key = restCacheKey(cacheNamespace, projectPath, 'pipelines', String(pipelineId), 'basic');

  if (!options?.forceRefresh) {
    const cached = cache.get<GitLabPipelineBasic>(key);
    if (cached) return { data: cached, fromCache: true };
  }

  const startTime = Date.now();
  const stdout = await transport.restGet(
    `/projects/${encodeURIComponent(projectPath)}/pipelines/${pipelineId}`
  );
  const duration = Date.now() - startTime;
  apiMetrics.recordCall('pipeline-basic', duration);

  const data: GitLabPipelineBasic = safeJsonParse(stdout, `fetching pipeline #${pipelineId}`);

  if (options?.shouldCache?.(data)) {
    cache.set(key, data, { pipelineStatus: data.status });
  }

  return { data, fromCache: false };
}

// ─── Pipeline Jobs ───────────────────────────────────────────────────────────

export async function fetchPipelineJobs(
  transport: Transport,
  cache: ApiCache,
  cacheNamespace: string,
  projectPath: string,
  pipelineId: number,
  options?: ApiCallOptions
): Promise<{ data: GitLabJob[]; fromCache: boolean }> {
  const key = restCacheKey(cacheNamespace, projectPath, 'pipelines', String(pipelineId), 'jobs');

  if (!options?.forceRefresh) {
    const cached = cache.get<GitLabJob[]>(key);
    if (cached) return { data: cached, fromCache: true };
  }

  const startTime = Date.now();
  const stdout = await transport.restGet(
    `/projects/${encodeURIComponent(projectPath)}/pipelines/${pipelineId}/jobs?include_retried=true&per_page=100`
  );
  const duration = Date.now() - startTime;
  apiMetrics.recordCall('pipeline-jobs', duration);

  const jobs: GitLabJob[] = safeJsonParse(stdout, `fetching jobs for pipeline #${pipelineId}`);

  if (jobs.length >= 100) {
    throw new Error(
      `Pipeline #${pipelineId} has 100+ jobs (pagination detected). Update script to handle job pagination.`
    );
  }

  if (options?.shouldCache?.(jobs)) {
    cache.set(key, jobs);
  }

  return { data: jobs, fromCache: false };
}

// ─── Downstream (Child) Pipelines ────────────────────────────────────────────

export async function fetchDownstreamPipelines(
  transport: Transport,
  cache: ApiCache,
  cacheNamespace: string,
  projectPath: string,
  pipelineId: number,
  options?: ApiCallOptions
): Promise<Array<GitLabPipelineBasic & { trigger_job: any }>> {
  const key = restCacheKey(cacheNamespace, projectPath, 'pipelines', String(pipelineId), 'bridges');

  if (!options?.forceRefresh) {
    const cached = cache.get<Array<GitLabPipelineBasic & { trigger_job: any }>>(key);
    if (cached) return cached;
  }

  try {
    const startTime = Date.now();
    const stdout = await transport.restGet(
      `/projects/${encodeURIComponent(projectPath)}/pipelines/${pipelineId}/bridges`
    );
    const duration = Date.now() - startTime;
    apiMetrics.recordCall('bridges', duration);

    const bridges = safeJsonParse<any[]>(stdout, `fetching bridges for pipeline #${pipelineId}`);

    const result = bridges
      .filter((bridge: any) => bridge.downstream_pipeline)
      .map((bridge: any) => ({
        ...bridge.downstream_pipeline,
        trigger_job: {
          id: bridge.id,
          name: bridge.name,
          stage: bridge.stage,
          status: bridge.status,
          created_at: bridge.created_at,
          started_at: bridge.started_at,
          finished_at: bridge.finished_at,
        },
      }));

    if (options?.shouldCache?.(result)) {
      cache.set(key, result);
    }

    return result;
  } catch {
    return [];
  }
}

// ─── GraphQL Job Dependencies ────────────────────────────────────────────────

export async function fetchJobDependenciesGraphQL(
  transport: Transport,
  cache: ApiCache,
  cacheNamespace: string,
  projectPath: string,
  pipelineId: number,
  options?: ApiCallOptions
): Promise<{ data: GraphQLResponse; fromCache: boolean }> {
  const key = graphqlCacheKey(cacheNamespace, projectPath, 'pipelines', String(pipelineId), 'job-dependencies');

  if (!options?.forceRefresh) {
    const cached = cache.get<GraphQLResponse>(key);
    if (cached) return { data: cached, fromCache: true };
  }

  try {
    const gid = `gid://gitlab/Ci::Pipeline/${pipelineId}`;
    const query = `
      query GetPipelineJobDependencies {
        project(fullPath: "${projectPath}") {
          pipeline(id: "${gid}") {
            stages {
              nodes {
                name
                groups {
                  nodes {
                    name
                    jobs {
                      nodes {
                        id
                        name
                        manualJob
                        retried
                        schedulingType
                        needs {
                          nodes {
                            ... on CiBuildNeed {
                              name
                            }
                          }
                        }
                        previousStageJobs {
                          nodes {
                            name
                            id
                            stage {
                              id
                              name
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
            downstream {
              nodes {
                id
                stages {
                  nodes {
                    name
                    groups {
                      nodes {
                        name
                        jobs {
                          nodes {
                            id
                            name
                            manualJob
                            retried
                            schedulingType
                            needs {
                              nodes {
                                ... on CiBuildNeed {
                                  name
                                }
                              }
                            }
                            previousStageJobs {
                              nodes {
                                name
                                id
                                stage {
                                  id
                                  name
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
                downstream {
                  nodes {
                    id
                    stages {
                      nodes {
                        name
                        groups {
                          nodes {
                            name
                            jobs {
                              nodes {
                                id
                                name
                                manualJob
                                retried
                                schedulingType
                                needs {
                                  nodes {
                                    ... on CiBuildNeed {
                                      name
                                    }
                                  }
                                }
                                previousStageJobs {
                                  nodes {
                                    name
                                    id
                                    stage {
                                      id
                                      name
                                    }
                                  }
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const startTime = Date.now();
    const stdout = await transport.graphql(query);
    const duration = Date.now() - startTime;
    apiMetrics.recordCall('graphql', duration);

    const data: GraphQLResponse = safeJsonParse(stdout, 'GraphQL query');

    if (options?.shouldCache?.(data)) {
      cache.set(key, data);
    }

    return { data, fromCache: false };
  } catch (error) {
    console.warn(
      `⚠️  Could not fetch job dependencies: ${error instanceof Error ? error.message : error}`
    );
    return { data: {}, fromCache: false };
  }
}

// ─── Job Log (for future use) ────────────────────────────────────────────────

export async function fetchJobLog(
  transport: Transport,
  cache: ApiCache,
  cacheNamespace: string,
  projectPath: string,
  jobId: number,
  options?: ApiCallOptions
): Promise<{ data: string; fromCache: boolean }> {
  const key = restCacheKey(cacheNamespace, projectPath, 'jobs', String(jobId), 'log');

  if (!options?.forceRefresh) {
    const cached = cache.get<string>(key);
    if (cached) return { data: cached, fromCache: true };
  }

  const startTime = Date.now();
  const stdout = await transport.restGet(
    `/projects/${encodeURIComponent(projectPath)}/jobs/${jobId}/trace`
  );
  const duration = Date.now() - startTime;
  apiMetrics.recordCall('job-log', duration);

  if (options?.shouldCache?.(stdout)) {
    cache.set(key, stdout);
  }

  return { data: stdout, fromCache: false };
}
