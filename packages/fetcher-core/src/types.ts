/**
 * Core types for the fetch orchestration framework.
 * 
 * These are intentionally generic — no domain-specific fields.
 * Entry points implement FetchTask with their specific result type,
 * and Writer with their specific output format.
 */

import type { ApiMetricsSummary } from './apiMetrics.js';

/**
 * Context provided to a running fetch task for reporting progress.
 * 
 * This is the bridge between the task logic and the TUI — tasks
 * report progress through this interface without knowing about React/Ink.
 */
export interface TaskContext {
  /** Update progress (e.g., 5 of 100 items processed) */
  updateProgress(current: number, total: number): void;

  /** Update the current phase label (e.g., "Fetching list", "Processing") */
  updatePhase(phase: string): void;

  /** Set a named detail to display in the stats panel */
  setDetail(key: string, value: string | number): void;

  /** Increment a numeric detail by an amount (defaults to 1) */
  incrementDetail(key: string, amount?: number): void;

  /** Set the "currently processing" label */
  setCurrentItem(label: string): void;

  /** Add a log message */
  log(type: 'info' | 'warning' | 'error' | 'success', message: string): void;

  /** Report API metrics snapshot */
  reportApiMetrics(metrics: ApiMetricsSummary): void;
}

/**
 * A fetch task that can be run by the framework.
 * 
 * Entry points create a FetchTask implementation that contains all
 * the domain-specific logic: which APIs to call, how to orchestrate
 * them, and what result to produce.
 */
export interface FetchTask<TResult> {
  /** Display name for the task (shown in TUI header) */
  name: string;

  /** Description shown below the name */
  description: string;

  /** Execute the task, reporting progress through the context */
  run(context: TaskContext): Promise<TResult>;
}

/**
 * A writer that persists task results.
 * 
 * Entry points create a Writer implementation that knows how to
 * save their specific result type in their specific format.
 */
export interface Writer<TResult> {
  /** Write the result to the destination */
  write(result: TResult, options: WriteOptions): Promise<void>;
}

export interface WriteOptions {
  /** Output directory for file-based writers */
  outputDir?: string;
  /** Output to stdout instead */
  stdout?: boolean;
  /** Pretty-print JSON output */
  pretty?: boolean;
}

/**
 * Options for running a fetch task.
 */
export interface RunOptions extends WriteOptions {
  /** Use debug mode (no TUI, plain console output) */
  debug?: boolean;
  /** Additional subtitle text (e.g., project path) */
  subtitle?: string;
}

/**
 * Log message displayed in the TUI.
 */
export interface LogMessage {
  type: 'info' | 'warning' | 'error' | 'success';
  message: string;
  timestamp: Date;
}

/**
 * Stats tracked by the TUI, driven by TaskContext calls.
 */
export interface TaskStats {
  /** Current phase label */
  phase: string;
  /** Progress: current item number */
  current: number;
  /** Progress: total items */
  total: number;
  /** Currently processing item label */
  currentItem?: string;
  /** Arbitrary key-value details for the stats panel */
  details: Map<string, string | number>;
  /** Latest API metrics snapshot */
  apiMetrics?: ApiMetricsSummary;
}
