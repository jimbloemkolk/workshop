import type { GitLabPipeline, TransformedPipelineData } from './types';
import { transformPipeline } from './transform';

export interface AggregatedJobAnalysis {
  jobName: string;
  totalImpactSeconds: number;
  averageImpactPercent: number;
  occurrences: number;
  avgDurationPerOccurrence: number;
}

/**
 * Analyzes multiple pipelines and aggregates job impact data
 * Returns which jobs have the most impact across all pipelines
 */
export function aggregateJobImpactAnalysis(pipelines: GitLabPipeline[]): AggregatedJobAnalysis[] {
  const jobImpacts = new Map<string, {
    totalImpact: number;
    totalPercent: number;
    occurrences: number;
    totalDuration: number;
  }>();

  pipelines.forEach(pipeline => {
    const transformed = transformPipeline(pipeline);
    
    if (!transformed.jobImpacts || transformed.jobImpacts.length === 0) {
      return;
    }

    transformed.jobImpacts.forEach(impact => {
      const jobName = impact.job.name;
      
      if (!jobImpacts.has(jobName)) {
        jobImpacts.set(jobName, {
          totalImpact: 0,
          totalPercent: 0,
          occurrences: 0,
          totalDuration: 0
        });
      }

      const stat = jobImpacts.get(jobName)!;
      stat.totalImpact += impact.impact;
      stat.totalPercent += impact.percentage;
      stat.occurrences++;
      stat.totalDuration += impact.job.duration || 0;
    });
  });

  // Convert to aggregated results
  const results: AggregatedJobAnalysis[] = Array.from(jobImpacts.entries()).map(([jobName, data]) => ({
    jobName,
    totalImpactSeconds: data.totalImpact,
    averageImpactPercent: data.occurrences > 0 ? data.totalPercent / data.occurrences : 0,
    occurrences: data.occurrences,
    avgDurationPerOccurrence: data.occurrences > 0 ? data.totalDuration / data.occurrences : 0
  }));

  // Sort by total impact
  results.sort((a, b) => b.totalImpactSeconds - a.totalImpactSeconds);

  return results;
}

/**
 * Calculate summary statistics from aggregated job impact data
 */
export function calculateAggregatedSummary(aggregatedJobImpact: AggregatedJobAnalysis[]) {
  const totalImpactTime = aggregatedJobImpact.reduce((sum, j) => sum + j.totalImpactSeconds, 0);
  const avgImpactPercent = aggregatedJobImpact.length > 0
    ? aggregatedJobImpact.reduce((sum, j) => sum + j.averageImpactPercent, 0) / aggregatedJobImpact.length
    : 0;
  const totalOccurrences = aggregatedJobImpact.reduce((sum, j) => sum + j.occurrences, 0);

  return {
    totalImpactTime,
    avgImpactPercent,
    totalOccurrences,
    jobCount: aggregatedJobImpact.length
  };
}

/**
 * Get aggregated statistics from multiple transformed pipelines
 */
export function aggregateStats(transformedData: TransformedPipelineData[]) {
  const totalPipelines = transformedData.length;
  const totalJobs = transformedData.reduce((sum, data) => sum + data.stats.totalJobs, 0);
  const totalExecutionTime = transformedData.reduce((sum, data) => sum + data.stats.totalExecutionTime, 0);
  const totalWaitingTime = transformedData.reduce((sum, data) => sum + data.stats.totalWaitingTime, 0);
  const avgEfficiency = totalPipelines > 0 
    ? transformedData.reduce((sum, data) => sum + data.stats.efficiency, 0) / totalPipelines 
    : 0;
  const avgParallelization = totalPipelines > 0
    ? transformedData.reduce((sum, data) => sum + data.stats.parallelizationFactor, 0) / totalPipelines
    : 0;

  return {
    totalPipelines,
    totalJobs,
    totalExecutionTime,
    totalWaitingTime,
    avgEfficiency,
    avgParallelization
  };
}
