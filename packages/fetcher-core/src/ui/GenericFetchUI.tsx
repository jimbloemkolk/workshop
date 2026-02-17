/**
 * Generic fetch TUI — presentational component.
 * 
 * Renders a progress display with arbitrary stat labels driven by
 * the `details` map. This makes it reusable across different fetch tasks
 * without any domain-specific knowledge.
 */

import React from 'react';
import { Box, Text, Newline } from 'ink';
import type { ApiMetricsSummary } from '../apiMetrics.js';
import type { LogMessage, TaskStats } from '../types.js';

interface GenericFetchUIProps {
  /** Task name shown in the header */
  title: string;
  /** Subtitle (e.g., project path, date range) */
  subtitle?: string;
  /** Current task stats */
  stats: TaskStats;
  /** Log messages */
  logs: LogMessage[];
}

export const GenericFetchUI: React.FC<GenericFetchUIProps> = ({ title, subtitle, stats, logs }) => {
  const progress = stats.total > 0
    ? Math.round((stats.current / stats.total) * 100)
    : 0;

  const progressBar = (percent: number, width: number = 30) => {
    const filled = Math.round((percent / 100) * width);
    const empty = width - filled;
    return '█'.repeat(filled) + '░'.repeat(empty);
  };

  const getPhaseEmoji = () => {
    const phase = stats.phase.toLowerCase();
    if (phase === 'complete' || phase === 'done') return '✅';
    if (phase === 'error') return '❌';
    if (phase.includes('fetch') || phase.includes('list')) return '🔍';
    return '⚙️';
  };

  // Only show last 10 warnings/errors
  const recentLogs = logs.slice(-10);

  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  };

  // Convert details map to sorted entries for display
  const detailEntries = Array.from(stats.details.entries());

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Box borderStyle="round" borderColor="cyan" padding={1} marginBottom={1}>
        <Box flexDirection="column" width="100%">
          <Text bold color="cyan">{title}</Text>
          {subtitle && <Text dimColor>{subtitle}</Text>}
        </Box>
      </Box>

      {/* Status Bar */}
      <Box borderStyle="round" padding={1} marginBottom={1}>
        <Box flexDirection="column" width="100%">
          <Box marginBottom={1}>
            <Text>
              {getPhaseEmoji()} <Text bold>{stats.phase}</Text>
            </Text>
          </Box>

          {stats.total > 0 && (
            <>
              <Box marginBottom={1}>
                <Text>
                  Progress: {progressBar(progress)} {progress}% ({stats.current}/{stats.total})
                </Text>
              </Box>

              {stats.currentItem && (
                <Box>
                  <Text dimColor>Current: {stats.currentItem}</Text>
                </Box>
              )}
            </>
          )}
        </Box>
      </Box>

      {/* Stats and API Performance side by side */}
      <Box marginBottom={1}>
        {/* Stats */}
        {detailEntries.length > 0 && (
          <Box borderStyle="round" padding={1} marginRight={1} flexGrow={1}>
            <Box flexDirection="column" width="100%">
              <Text bold underline>Statistics</Text>
              <Newline />
              {detailEntries.map(([key, value]) => (
                <Box key={key}>
                  <Box width={22}>
                    <Text>{key}:</Text>
                  </Box>
                  <Text color="cyan">{value}</Text>
                </Box>
              ))}
            </Box>
          </Box>
        )}

        {/* API Performance Metrics */}
        {stats.apiMetrics && stats.apiMetrics.totalCalls > 0 && (
          <Box borderStyle="round" borderColor="magenta" padding={1} flexGrow={1}>
            <Box flexDirection="column" width="100%">
              <Text bold underline color="magenta">API Performance</Text>
              <Newline />
              <Box>
                <Box width={20}>
                  <Text>Total Calls:</Text>
                </Box>
                <Text color="cyan">{stats.apiMetrics.totalCalls}</Text>
              </Box>
              <Box>
                <Box width={20}>
                  <Text>Avg Response:</Text>
                </Box>
                <Text color="green">{formatDuration(stats.apiMetrics.avgDuration)}</Text>
              </Box>
              <Box>
                <Box width={20}>
                  <Text>Min / Max:</Text>
                </Box>
                <Text>
                  {formatDuration(stats.apiMetrics.minDuration)} / {formatDuration(stats.apiMetrics.maxDuration)}
                </Text>
              </Box>
              <Box>
                <Box width={20}>
                  <Text>P50 / P95 / P99:</Text>
                </Box>
                <Text color="yellow">
                  {formatDuration(stats.apiMetrics.p50)} / {formatDuration(stats.apiMetrics.p95)} / {formatDuration(stats.apiMetrics.p99)}
                </Text>
              </Box>
              <Newline />
              <Text dimColor underline>By Endpoint:</Text>
              {renderEndpoints(stats.apiMetrics)}
            </Box>
          </Box>
        )}
      </Box>

      {/* Warnings/Errors */}
      {recentLogs.length > 0 && (
        <Box borderStyle="round" borderColor="yellow" padding={1}>
          <Box flexDirection="column" width="100%">
            <Text bold underline color="yellow">Recent Warnings/Errors</Text>
            <Newline />
            {recentLogs.map((log, idx) => (
              <Box key={idx}>
                <Text color={log.type === 'error' ? 'red' : 'yellow'}>
                  {log.type === 'error' ? '❌' : '⚠️'} {log.message}
                </Text>
              </Box>
            ))}
          </Box>
        </Box>
      )}
    </Box>
  );
};

function renderEndpoints(apiMetrics: ApiMetricsSummary) {
  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  };

  return Object.entries(apiMetrics.byEndpoint).map(([endpoint, metrics]) => (
    <Box key={endpoint} marginLeft={2}>
      <Box width={18}>
        <Text dimColor>• {endpoint}:</Text>
      </Box>
      <Text>
        {metrics.count} calls, avg {formatDuration(metrics.avgDuration)}
      </Text>
    </Box>
  ));
}
