import { exec } from 'child_process';
import { promisify } from 'util';
import type {
  GitLabPipelineBasic,
  GitLabJob,
  GraphQLResponse,
} from './types.js';
import { apiMetrics } from './apiMetrics.js';

const execPromise = promisify(exec);

/**
 * Fetch pipeline list from GitLab
 */
export async function fetchPipelineList(
  projectPath: string,
  createdAfterISO: string,
  perPage: number = 100,
  page: number = 1
): Promise<GitLabPipelineBasic[]> {
  const startTime = Date.now();
  try {
    const url = `/projects/${encodeURIComponent(projectPath)}/pipelines?created_after=${encodeURIComponent(createdAfterISO)}&per_page=${perPage}&page=${page}`;
    const { stdout } = await execPromise(
      `glab api --paginate ${url}`
    );
    
    // --paginate returns JSON arrays concatenated like: [...][...][...]
    // Split by '][' and add back the brackets
    let jsonStrings: string[];
    if (stdout.includes('][')) {
      const parts = stdout.split('][');
      jsonStrings = parts.map((part: string, idx: number) => {
        if (idx === 0) return part + ']';  // First part: [...]
        if (idx === parts.length - 1) return '[' + part;  // Last part: [...]
        return '[' + part + ']';  // Middle parts: [...]
      });
    } else {
      jsonStrings = [stdout];  // Single page
    }
    
    let allPipelines: GitLabPipelineBasic[] = [];
    
    for (const jsonStr of jsonStrings) {
      const pageResult = JSON.parse(jsonStr);
      if (Array.isArray(pageResult)) {
        allPipelines = allPipelines.concat(pageResult);
      }
    }
      
    const duration = Date.now() - startTime;
    apiMetrics.recordCall('pipeline-list', duration);
    
    return allPipelines;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const stderr = (error as any).stderr || '';
    
    // Check for 403 Forbidden
    if (errorMessage.includes('403') || stderr.includes('403')) {
      throw new Error('403 Forbidden: Not authorized to access GitLab API. Please check your authentication with "glab auth status"');
    }
    
    throw error;
  }
}

/**
 * Fetch single pipeline basic info
 */
export async function fetchPipelineBasic(
  projectPath: string,
  pipelineId: number
): Promise<GitLabPipelineBasic> {
  const startTime = Date.now();
  const { stdout } = await execPromise(
    `glab api /projects/${encodeURIComponent(projectPath)}/pipelines/${pipelineId}`
  );
  const duration = Date.now() - startTime;
  apiMetrics.recordCall('pipeline-basic', duration);
  return JSON.parse(stdout);
}

/**
 * Fetch jobs for a pipeline
 */
export async function fetchPipelineJobs(
  projectPath: string,
  pipelineId: number
): Promise<GitLabJob[]> {
  const startTime = Date.now();
  const { stdout } = await execPromise(
    `glab api /projects/${encodeURIComponent(projectPath)}/pipelines/${pipelineId}/jobs?include_retried=true&per_page=100`
  );
  const duration = Date.now() - startTime;
  apiMetrics.recordCall('pipeline-jobs', duration);
  const jobs = JSON.parse(stdout);

  // Check if there are multiple pages of jobs
  if (jobs.length >= 100) {
    throw new Error(
      `Pipeline #${pipelineId} has 100+ jobs (pagination detected). Update script to handle job pagination.`
    );
  }

  return jobs;
}

/**
 * Fetch downstream (child) pipelines via bridges
 */
export async function fetchDownstreamPipelines(
  projectPath: string,
  pipelineId: number
): Promise<Array<GitLabPipelineBasic & { trigger_job: any }>> {
  try {
    const { stdout } = await execPromise(
      `glab api /projects/${encodeURIComponent(projectPath)}/pipelines/${pipelineId}/bridges`
    );
    const bridges = JSON.parse(stdout);

    // Extract downstream pipelines from bridges and attach trigger job info
    return bridges
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
  } catch (error) {
    return [];
  }
}

/**
 * Fetch raw GraphQL response for job dependencies
 */
export async function fetchJobDependenciesGraphQL(
  projectPath: string,
  pipelineId: number
): Promise<GraphQLResponse> {
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
    const { stdout } = await execPromise(
      `glab api graphql -f query='${query.replace(/'/g, "'\\''")}'`
    );
    const duration = Date.now() - startTime;
    apiMetrics.recordCall('graphql', duration);

    const response: GraphQLResponse = JSON.parse(stdout);
    
    // Return the raw response
    return response;
  } catch (error) {
    console.warn(
      `⚠️  Could not fetch job dependencies: ${error instanceof Error ? error.message : error}`
    );
    return {};
  }
}
