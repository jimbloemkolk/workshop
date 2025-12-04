import { useState, useCallback } from 'react';
import type { FetchStats, LogMessage } from './FetchUI.js';

export const useFetchState = () => {
  const [stats, setStats] = useState<FetchStats>({
    totalPipelines: 0,
    processedPipelines: 0,
    failedPipelines: 0,
    cachedPipelines: 0,
    cachedPipelineDetails: 0,
    cachedJobs: 0,
    cachedGraphQL: 0,
    existingPipelines: 0,
    phase: 'fetching-list',
  });

  const [logs, setLogs] = useState<LogMessage[]>([]);

  const updateStats = useCallback((updates: Partial<FetchStats>) => {
    setStats(prev => ({ ...prev, ...updates }));
  }, []);

  const addLog = useCallback((type: LogMessage['type'], message: string) => {
    setLogs(prev => [...prev, { type, message, timestamp: new Date() }]);
  }, []);

  const incrementStat = useCallback((key: keyof Omit<FetchStats, 'phase' | 'currentPipeline' | 'totalPipelines'>) => {
    setStats(prev => ({ ...prev, [key]: prev[key] + 1 }));
  }, []);

  return {
    stats,
    logs,
    updateStats,
    addLog,
    incrementStat,
  };
};
