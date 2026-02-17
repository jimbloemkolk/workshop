/**
 * Log parser — extracts failure reasons from GitLab job logs.
 *
 * Applies regex patterns in priority order against the raw log text.
 * Returns an array of ParsedFailure objects, one per matched pattern.
 * If no patterns match, returns a single 'unknown' failure.
 */

import type { ParsedFailure, FailureCategory } from './types.js';

// ─── Pattern Definitions ─────────────────────────────────────────────────────

interface FailurePattern {
  category: FailureCategory;
  pattern: RegExp;
  label: string;
}

/**
 * Patterns are applied in order. First match wins for categorization,
 * but all matches are collected for the failures array.
 */
const FAILURE_PATTERNS: FailurePattern[] = [
  // Specific script failures modes
  {
    category: 'user_failure',
    pattern: /Error: Affected item .* does not have a changeset!/i,
    label: 'missing_changeset',
  },
  /**
   * Failed:    web-customer-happiness#test:e2e
   *  ERROR  run failed: command  exited (1)
   */
  {
    category: 'user_failure',
    pattern: /\s*Failed:\s+.+\n\s*Error\s*run\s+failed:\s+command\s+exited\s+\(\d+\)/i,
    label: 'turbo_task_failed',
  },

  {
    category: 'user_failure',
    pattern: /\d+ checks? failed, indicating possible issues with the project\./i,
    label: 'expo_doctor',
  },
  {
    category: 'user_failure',
    pattern: /ERR_PNPM_OUTDATED_LOCKFILE.+Cannot install with "frozen-lockfile"/i,
    label: 'outdated_lockfile',
  },
  {
    category: 'user_failure',
    pattern: /ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY.+Broken lockfile/i,
    label: 'broken_lockfile',
  },
    {
    category: 'user_failure',
    pattern: /Syncpack validation failed!/i,
    label: 'syncpack_validation',
  },

  {
    category: 'internal_failure',
    pattern: /Error: Timed out waiting for: tcp:65535/i,
    label: 'turbo_cache_proxy_error',
  },

  // Specific failure modes indicating kubernetes related issues
  {
    category: 'system_failure',
    pattern: /pod ".*" status is "(?:failed|error|unknown|crashloopbackoff)"/i,
    label: 'pod_status_failure',
  },
  {
    category: 'system_failure',
    pattern: /runner .* (?:connection refused|unavailable|unreachable)/i,
    label: 'runner_connectivity',
  },
  {
    category: 'system_failure',
    pattern: /Event retrieved from the cluster: Failed to create pod/i,
    label: 'pod_creation_failure',
  },
  {
    category: 'system_failure',
    pattern: /ERROR: Job failed: prepare environment: waiting for pod running: pulling image/i,
    label: 'image_pull_failure',
  },
  {
    category: 'system_failure',
    pattern: /ERROR: Job failed: prepare environment: waiting for pod running: pulling image/i,
    label: 'image_pull_failure',
  },

  // Git system errors
  {
    category: 'system_failure',
    pattern: /fatal: unable to access .*: Could not resolve host: gitlab.anwbonline.nl/i,
    label: 'git_fetch_failure',
  },

  // Most likely nexus problems
  {
    category: 'system_failure',
    pattern: /ERR_PNPM_FETCH_401.*GET.*Unauthorized - 401/i,
    label: 'nexus_auth_error',
  },
  {
    category: 'system_failure',
    pattern: /EAI_AGAIN.*request to .* failed, reason: getaddrinfo EAI_AGAIN/i,
    label: 'nexus_dns_error',
  },
  
  // This is most likely a system failure as well, but we cannot really know 100% for sure
  {
    category: 'timeout',
    pattern: /ERROR: Job failed: execution took longer than \S* seconds/i,
    label: 'job_execution_timeout',
  },

  // Generic failure mode that indicates kubernetes related issues
  {
    category: 'system_failure',
    pattern: /ERROR: Job failed \(system failure\):.*/i,
    label: 'system_failure_generic',
  },

  {
    category: 'timeout',
    pattern: /ERROR: Job failed.*timeout/i,
    label: 'job_timeout',
  },
  {
    category: 'timeout',
    pattern: /job execution timeout/i,
    label: 'execution_timeout',
  },
  {
    category: 'timeout',
    pattern: /stuck or timeout/i,
    label: 'stuck_or_timeout',
  },

  // ── Infrastructure ───────────────────────────────────────────────────────
  {
    category: 'infrastructure',
    pattern: /docker.*pull.*(?:error|fail|denied)/i,
    label: 'docker_pull_error',
  },
  {
    category: 'infrastructure',
    pattern: /Cannot connect to the Docker daemon/i,
    label: 'docker_daemon_error',
  },
  {
    category: 'infrastructure',
    pattern: /no space left on device/i,
    label: 'disk_space',
  },
  {
    category: 'infrastructure',
    pattern: /TLS handshake timeout/i,
    label: 'tls_timeout',
  },
  {
    category: 'infrastructure',
    pattern: /failed to dial.*connection refused/i,
    label: 'connection_refused',
  },

  // ── Script / test failures ───────────────────────────────────────────────
  {
    category: 'script_failure',
    pattern: /ERROR: Job failed: exit code (\d+)/i,
    label: 'exit_code',
  },
  {
    category: 'script_failure',
    pattern: /exit status \d+/i,
    label: 'exit_status',
  },
  {
    category: 'script_failure',
    pattern: /.*(FAILED|FAIL:).*/i,
    label: 'generic_failure',
  }
];

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Parse failure reasons from a raw job log.
 *
 * Returns all matched failures. If none match:
 * - Empty logs (or only whitespace) → system_failure: no_job_logs
 * - Logs with content but no pattern match → unknown: no_match
 */
export function parseFailureReasons(log: string): ParsedFailure[] {
  const lines = log.split('\n');
  const failures: ParsedFailure[] = [];
  const seenCategories = new Set<string>();
  const matchedLines = new Set<number>(); // Track lines already matched by higher-priority patterns

  for (const fp of FAILURE_PATTERNS) {
    // Check if pattern contains newline (multi-line pattern)
    const isMultiLine = fp.pattern.source.includes('\\n');
    
    if (isMultiLine) {
      // For multi-line patterns, test against chunks of consecutive lines
      // We'll test up to 5 lines at a time to handle most multi-line patterns
      for (let i = 0; i < lines.length; i++) {
        // Skip if this line was already matched by a higher-priority pattern
        if (matchedLines.has(i)) continue;
        
        const chunk = lines.slice(i, Math.min(i + 5, lines.length)).join('\n');
        const match = fp.pattern.exec(chunk);
        if (match) {
          // Deduplicate: only keep the first match per pattern label
          const key = `${fp.label}:${match[0]}`;
          if (!seenCategories.has(key)) {
            seenCategories.add(key);
            failures.push({
              category: fp.category,
              pattern: fp.label,
              matchedText: match[0].trim().slice(0, 500),
              lineNumber: i + 1,
            });
            
            // Mark all lines in this multi-line match as matched
            const newlineCount = (match[0].match(/\n/g) || []).length;
            for (let j = 0; j <= newlineCount; j++) {
              matchedLines.add(i + j);
            }
          }
        }
      }
    } else {
      // Single-line pattern: test each line individually
      for (let i = 0; i < lines.length; i++) {
        // Skip if this line was already matched by a higher-priority pattern
        if (matchedLines.has(i)) continue;
        
        const match = fp.pattern.exec(lines[i]);
        if (match) {
          // Deduplicate: only keep the first match per pattern label
          const key = `${fp.label}:${match[0]}`;
          if (!seenCategories.has(key)) {
            seenCategories.add(key);
            failures.push({
              category: fp.category,
              pattern: fp.label,
              matchedText: match[0].trim().slice(0, 500),
              lineNumber: i + 1,
            });
            matchedLines.add(i);
          }
        }
      }
    }
  }

  if (failures.length === 0) {
    // Check if log is empty or only whitespace
    if (log.trim().length === 0) {
      failures.push({
        category: 'system_failure',
        pattern: 'no_job_logs',
        matchedText: '',
      });
    } else {
      failures.push({
        category: 'unknown',
        pattern: 'no_match',
        matchedText: '',
      });
    }
  }

  return failures;
}

/**
 * Extract a log excerpt around matched failures, or the last ~100 lines
 * as fallback context.
 *
 * Captures ±5 lines around each match, plus the last 100 lines.
 * Deduplicates overlapping ranges.
 */
export function extractLogExcerpt(log: string, failures: ParsedFailure[]): string {
  const lines = log.split('\n');

  // Collect line ranges to include
  const ranges: Array<[number, number]> = [];

  // ±5 lines around each match
  for (const f of failures) {
    if (f.lineNumber != null) {
      const start = Math.max(0, f.lineNumber - 1 - 5);
      const end = Math.min(lines.length - 1, f.lineNumber - 1 + 5);
      ranges.push([start, end]);
    }
  }

  // Last ~100 lines
  const tailStart = Math.max(0, lines.length - 100);
  ranges.push([tailStart, lines.length - 1]);

  if (ranges.length === 0) {
    return lines.slice(-100).join('\n');
  }

  // Merge overlapping ranges
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [ranges[0]];
  for (let i = 1; i < ranges.length; i++) {
    const last = merged[merged.length - 1];
    if (ranges[i][0] <= last[1] + 1) {
      last[1] = Math.max(last[1], ranges[i][1]);
    } else {
      merged.push(ranges[i]);
    }
  }

  // Build excerpt with separators between non-contiguous ranges
  const parts: string[] = [];
  for (const [start, end] of merged) {
    if (parts.length > 0) {
      parts.push('... (lines omitted) ...');
    }
    parts.push(lines.slice(start, end + 1).join('\n'));
  }

  // Cap at ~10K chars to keep JSON manageable
  const excerpt = parts.join('\n');
  if (excerpt.length > 10_000) {
    return excerpt.slice(-10_000);
  }
  return excerpt;
}
