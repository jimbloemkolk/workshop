/**
 * @workshop/fetch-gitlab-failure
 *
 * GitLab failure analysis — fetches failed pipelines, downloads job logs,
 * parses failure reasons, and produces structured JSON for analysis.
 */

export { FailureFetchTask, type FailureTaskOptions } from './task.js';
export { FailureWriter } from './writer.js';
export { parseFailureReasons, extractLogExcerpt } from './logParser.js';
export {
  type FailureFetchResult,
  type FailedJobInfo,
  type ParsedFailure,
  type FailureCategory,
  type FailureFetchMetadata,
} from './types.js';
