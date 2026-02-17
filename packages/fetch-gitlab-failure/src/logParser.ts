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
  // ── System failures ──────────────────────────────────────────────────────
  {
    category: 'system_failure',
    pattern: /ERROR: Job failed \(system failure\):.*/i,
    label: 'system_failure_generic',
  },
  {
    category: 'system_failure',
    pattern: /pod .* status (?:failed|error|unknown|crashloopbackoff)/i,
    label: 'pod_status_failure',
  },
  {
    category: 'system_failure',
    pattern: /runner .* (?:connection refused|unavailable|unreachable)/i,
    label: 'runner_connectivity',
  },
  {
    category: 'system_failure',
    pattern: /failed to create pod/i,
    label: 'pod_creation_failure',
  },

  // ── Timeout ──────────────────────────────────────────────────────────────
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
    pattern: /(?:OOM|out of memory|killed process|oom-kill)/i,
    label: 'out_of_memory',
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
    pattern: /FAILED|FAIL:/i,
    label: 'test_failed',
  },
  {
    category: 'script_failure',
    pattern: /AssertionError|assert(?:ion)? failed/i,
    label: 'assertion_error',
  },
  {
    category: 'script_failure',
    pattern: /expected .* but got/i,
    label: 'expectation_mismatch',
  },
  {
    category: 'script_failure',
    pattern: /(?:build|compile|compilation) (?:failed|error)/i,
    label: 'build_failure',
  },
];

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Parse failure reasons from a raw job log.
 *
 * Returns all matched failures. If none match, returns a single 'unknown'
 * failure with context from the last 100 lines.
 */
export function parseFailureReasons(log: string): ParsedFailure[] {
  const lines = log.split('\n');
  const failures: ParsedFailure[] = [];
  const seenCategories = new Set<string>();

  for (const fp of FAILURE_PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
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
        }
      }
    }
  }

  if (failures.length === 0) {
    failures.push({
      category: 'unknown',
      pattern: 'no_match',
      matchedText: '(no known failure pattern matched)',
    });
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
