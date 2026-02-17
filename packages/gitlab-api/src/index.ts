/**
 * @gitlab-analysis/gitlab-api
 * 
 * GitLab API client with transport abstraction and endpoint-based caching.
 */

// Transport
export { type Transport } from './transport.js';
export { GlabTransport } from './glabTransport.js';

// Hostname detection
export { getGitlabHostname } from './hostname.js';

// Cache (re-exported from fetcher-core)
export {
  ApiCache,
  DefaultHasher,
  cacheKey,
  restCacheKey,
  graphqlCacheKey,
  sanitizeHostname,
  type CacheKey,
  type CacheKeyHasher,
  type CacheEntry,
  type CacheOptions,
} from '@gitlab-analysis/fetcher-core';

// API functions
export {
  fetchPipelineList,
  fetchPipelineBasic,
  fetchPipelineJobs,
  fetchDownstreamPipelines,
  fetchJobDependenciesGraphQL,
  fetchJobLog,
  type ApiCallOptions,
} from './api.js';

// Types
export {
  type GitLabPipelineBasic,
  type GitLabJob,
  type TriggerJob,
  type GraphQLResponse,
  type JobMetadata,
} from './types.js';

// Metrics (re-exported from fetcher-core)
export {
  apiMetrics,
  ApiMetricsTracker,
  type ApiCallMetrics,
  type ApiMetricsSummary,
} from '@gitlab-analysis/fetcher-core';
