import React, { useState, useEffect } from 'react';
import { FetchUI, type FetchStats, type LogMessage } from './FetchUI.js';

interface FetchAppProps {
  projectPath: string;
  daysBack: number;
  onComplete: () => void;
  fetchFn: (uiContext: any) => Promise<void>;
}

export const FetchApp: React.FC<FetchAppProps> = ({ 
  projectPath, 
  daysBack, 
  onComplete,
  fetchFn 
}) => {
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

  const updateStats = (updates: Partial<FetchStats>) => {
    setStats(prev => ({ ...prev, ...updates }));
  };

  const addLog = (type: LogMessage['type'], message: string) => {
    setLogs(prev => [...prev, { type, message, timestamp: new Date() }]);
  };

  const incrementStat = (key: keyof Omit<FetchStats, 'phase' | 'currentPipeline' | 'totalPipelines'>) => {
    setStats(prev => ({ ...prev, [key]: prev[key] + 1 }));
  };

  const incrementCacheStat = (key: keyof Pick<FetchStats, 'cachedPipelines' | 'cachedPipelineDetails' | 'cachedJobs' | 'cachedGraphQL'>, amount: number) => {
    setStats(prev => ({ ...prev, [key]: prev[key] + amount }));
  };

  useEffect(() => {
    const uiContext = {
      updateStats,
      addLog,
      incrementStat,
      incrementCacheStat,
      stats,
    };

    fetchFn(uiContext)
      .then(onComplete)
      .catch((error) => {
        const errorMessage = error.message || String(error);
        addLog('error', errorMessage);
        updateStats({ phase: 'error' });
        
        // Exit after showing error for a moment, then rethrow
        setTimeout(() => {
          throw error;
        }, 2000);
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return <FetchUI stats={stats} logs={logs} projectPath={projectPath} daysBack={daysBack} />;
};
