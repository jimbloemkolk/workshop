/**
 * @gitlab-analysis/fetch-job-logs
 * 
 * Job logs fetching — entry point package.
 */

export { JobLogsFetchTask, type JobLogsTaskOptions } from './task.js';
export { JobLogsWriter } from './writer.js';
export { type JobLogsFetchResult, type JobWithLog } from './types.js';
