/**
 * @gitlab-analysis/fetcher-core
 * 
 * Generic fetch orchestration framework with Ink TUI.
 */

// Core types
export {
  type FetchTask,
  type TaskContext,
  type Writer,
  type WriteOptions,
  type RunOptions,
  type LogMessage,
  type TaskStats,
} from './types.js';

// Runner
export { runFetchTask } from './runner.js';

// Writers
export { JsonFileWriter, type JsonFileWriterOptions } from './writers/jsonFileWriter.js';
export { StdoutWriter } from './writers/stdoutWriter.js';

// Cache
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
} from './cache.js';

// Metrics
export {
  apiMetrics,
  ApiMetricsTracker,
  type ApiCallMetrics,
  type ApiMetricsSummary,
} from './apiMetrics.js';

// UI (for advanced use — most consumers just use runFetchTask)
export { GenericFetchApp } from './ui/GenericFetchApp.js';
export { GenericFetchUI } from './ui/GenericFetchUI.js';
