/**
 * Generic fetch TUI — stateful wrapper.
 * 
 * Owns React state for TaskStats and LogMessages. Creates a TaskContext
 * bridge that the fetch task uses to report progress, which in turn
 * drives re-renders of GenericFetchUI.
 */

import React, { useState, useEffect } from 'react';
import type { ApiMetricsSummary } from '../apiMetrics.js';
import { GenericFetchUI } from './GenericFetchUI.js';
import type { TaskContext, TaskStats, LogMessage } from '../types.js';

interface GenericFetchAppProps {
  /** Title shown in the TUI header */
  title: string;
  /** Subtitle shown below the title */
  subtitle?: string;
  /** The function to run — receives a TaskContext to report progress */
  runTask: (context: TaskContext) => Promise<void>;
  /** Called when the task completes */
  onComplete: () => void;
}

export const GenericFetchApp: React.FC<GenericFetchAppProps> = ({
  title,
  subtitle,
  runTask,
  onComplete,
}) => {
  const [stats, setStats] = useState<TaskStats>({
    phase: 'Starting',
    current: 0,
    total: 0,
    details: new Map(),
  });

  const [logs, setLogs] = useState<LogMessage[]>([]);

  useEffect(() => {
    const context: TaskContext = {
      updateProgress(current: number, total: number) {
        setStats(prev => ({ ...prev, current, total }));
      },

      updatePhase(phase: string) {
        setStats(prev => ({ ...prev, phase }));
      },

      setDetail(key: string, value: string | number) {
        setStats(prev => {
          const details = new Map(prev.details);
          details.set(key, value);
          return { ...prev, details };
        });
      },

      incrementDetail(key: string, amount: number = 1) {
        setStats(prev => {
          const details = new Map(prev.details);
          const current = details.get(key);
          const numericCurrent = typeof current === 'number' ? current : 0;
          details.set(key, numericCurrent + amount);
          return { ...prev, details };
        });
      },

      setCurrentItem(label: string) {
        setStats(prev => ({ ...prev, currentItem: label }));
      },

      log(type: LogMessage['type'], message: string) {
        setLogs(prev => [...prev, { type, message, timestamp: new Date() }]);
      },

      reportApiMetrics(metrics: ApiMetricsSummary) {
        setStats(prev => ({ ...prev, apiMetrics: metrics }));
      },
    };

    runTask(context)
      .then(onComplete)
      .catch((error) => {
        const errorMessage = error.message || String(error);
        context.log('error', errorMessage);
        context.updatePhase('Error');

        setTimeout(() => {
          throw error;
        }, 2000);
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return <GenericFetchUI title={title} subtitle={subtitle} stats={stats} logs={logs} />;
};
