/**
 * Types for the GitLab failure analysis fetch task.
 */

// ─── Failure Categories ──────────────────────────────────────────────────────

export type FailureCategory =
  | 'system_failure' // Issues in the GitLab infrastructure, runner connectivity, kubernetes, etc.
  | 'script_failure' // Generic script failures. More specific patterns (e.g., turbo task failures) are in user or internal failure categories.
  | 'user_failure' // E.g., test failures, lint errors, etc. actionable by the user
  | 'internal_failure' // Not necessarily user issues, but issues in the monorepo pipeline setup
  | 'timeout'
  | 'infrastructure'
  | 'unknown';

// ─── Parsed Failure ──────────────────────────────────────────────────────────

/** A single failure reason extracted from a job log */
export interface ParsedFailure {
  /** Which category this failure belongs to */
  category: FailureCategory;
  /** The regex pattern that matched */
  pattern: string;
  /** The actual text that was matched in the log */
  matchedText: string;
  /** Line number in the log where the match was found (1-based) */
  lineNumber?: number;
}

// ─── Failed Job Info ─────────────────────────────────────────────────────────

/** Full info about a single failed job, enriched with pipeline context */
export interface FailedJobInfo {
  jobId: number;
  jobName: string;
  stage: string;
  status: string;
  allowFailure: boolean;
  duration: number | null;
  queuedDuration: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  webUrl: string;
  runner: {
    id: number;
    description: string;
  } | null;

  // Pipeline context
  pipelineId: number;
  pipelineIid: number;
  pipelineRef: string;
  pipelineSource: string | undefined;
  pipelineUrl: string;
  pipelineCreatedAt: string;

  // Failure analysis
  failures: ParsedFailure[];
  /** Log excerpt: ±5 lines around match, or last ~100 lines as fallback */
  rawLogExcerpt: string;
}

// ─── Fetch Result ────────────────────────────────────────────────────────────

/** The complete result of a failure fetch run */
export interface FailureFetchResult {
  jobs: FailedJobInfo[];
  metadata: FailureFetchMetadata;
}

export interface FailureFetchMetadata {
  projectPath: string;
  daysBack: number;
  scannedPipelines: number;
  failedPipelines: number;
  failedJobs: number;
  fetchedAt: string;
  timeRange: {
    from: string;
    to: string;
  };
}
