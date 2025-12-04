import React from 'react';
import { Box, Text, Newline } from 'ink';
import type { ApiMetricsSummary } from '../apiMetrics.js';

export interface FetchStats {
  totalPipelines: number;
  processedPipelines: number;
  failedPipelines: number;
  cachedPipelines: number;
  cachedPipelineDetails: number;
  cachedJobs: number;
  cachedGraphQL: number;
  existingPipelines: number;
  currentPipeline?: string;
  phase: 'fetching-list' | 'processing' | 'complete' | 'error';
  apiMetrics?: ApiMetricsSummary;
}

export interface LogMessage {
  type: 'info' | 'warning' | 'error' | 'success';
  message: string;
  timestamp: Date;
}

interface FetchUIProps {
  stats: FetchStats;
  logs: LogMessage[];
  projectPath: string;
  daysBack?: number;
}

export const FetchUI: React.FC<FetchUIProps> = ({ stats, logs, projectPath, daysBack }) => {

  const progress = stats.totalPipelines > 0 
    ? Math.round((stats.processedPipelines / stats.totalPipelines) * 100) 
    : 0;

  const progressBar = (percent: number, width: number = 30) => {
    const filled = Math.round((percent / 100) * width);
    const empty = width - filled;
    return '█'.repeat(filled) + '░'.repeat(empty);
  };

  const getPhaseEmoji = () => {
    switch (stats.phase) {
      case 'fetching-list': return '🔍';
      case 'processing': return '⚙️';
      case 'complete': return '✅';
      case 'error': return '❌';
    }
  };

  const getPhaseText = () => {
    switch (stats.phase) {
      case 'fetching-list': return 'Fetching pipeline list';
      case 'processing': return 'Processing pipelines';
      case 'complete': return 'Complete';
      case 'error': return 'Error';
    }
  };

  // Only show last 10 warnings/errors
  const recentLogs = logs.slice(-10);

  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  };

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Box borderStyle="round" borderColor="cyan" padding={1} marginBottom={1}>
        <Box flexDirection="column" width="100%">
          <Text bold color="cyan">
            GitLab Pipeline Fetcher
          </Text>
          <Text dimColor>
            Project: {projectPath}
            {daysBack && ` • Last ${daysBack} days`}
          </Text>
        </Box>
      </Box>

      {/* Status Bar */}
      <Box borderStyle="round" padding={1} marginBottom={1}>
        <Box flexDirection="column" width="100%">
          <Box marginBottom={1}>
            <Text>
              {getPhaseEmoji()} <Text bold>{getPhaseText()}</Text>
            </Text>
          </Box>
          
          {stats.totalPipelines > 0 && (
            <>
              <Box marginBottom={1}>
                <Text>
                  Progress: {progressBar(progress)} {progress}% ({stats.processedPipelines}/{stats.totalPipelines})
                </Text>
              </Box>
              
              {stats.currentPipeline && (
                <Box>
                  <Text dimColor>Current: {stats.currentPipeline}</Text>
                </Box>
              )}
            </>
          )}
        </Box>
      </Box>

      {/* Stats and API Performance side by side */}
      <Box marginBottom={1}>
        {/* Stats */}
        <Box borderStyle="round" padding={1} marginRight={1} flexGrow={1}>
          <Box flexDirection="column" width="100%">
            <Text bold underline>Statistics</Text>
            <Newline />
            <Box>
              <Box width={20}>
                <Text>New Pipelines:</Text>
              </Box>
              <Text color="cyan">{stats.processedPipelines}</Text>
            </Box>
            <Box>
              <Box width={20}>
                <Text>Existing:</Text>
              </Box>
              <Text color="blue">{stats.existingPipelines}</Text>
            </Box>
            <Box>
              <Box width={20}>
                <Text>Failed:</Text>
              </Box>
              <Text color="red">{stats.failedPipelines}</Text>
            </Box>
            <Box>
              <Box width={20}>
                <Text>Cache Hits:</Text>
              </Box>
              <Text color="green">
                {stats.cachedPipelines}/{stats.processedPipelines}
                {stats.processedPipelines > 0 && ` (${Math.round((stats.cachedPipelines / stats.processedPipelines) * 100)}%)`}
              </Text>
            </Box>
            <Box marginLeft={2}>
              <Box width={18}>
                <Text dimColor>• Pipelines:</Text>
              </Box>
              <Text color="green">{stats.cachedPipelineDetails}</Text>
            </Box>
            <Box marginLeft={2}>
              <Box width={18}>
                <Text dimColor>• Jobs:</Text>
              </Box>
              <Text color="green">{stats.cachedJobs}</Text>
            </Box>
            <Box marginLeft={2}>
              <Box width={18}>
                <Text dimColor>• GraphQL:</Text>
              </Box>
              <Text color="green">{stats.cachedGraphQL}</Text>
            </Box>
          </Box>
        </Box>

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
                <Text>{formatDuration(stats.apiMetrics.minDuration)} / {formatDuration(stats.apiMetrics.maxDuration)}</Text>
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
              {Object.entries(stats.apiMetrics.byEndpoint).map(([endpoint, metrics]) => (
                <Box key={endpoint} marginLeft={2}>
                  <Box width={18}>
                    <Text dimColor>• {endpoint}:</Text>
                  </Box>
                  <Text>
                    {metrics.count} calls, avg {formatDuration(metrics.avgDuration)}
                  </Text>
                </Box>
              ))}
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
