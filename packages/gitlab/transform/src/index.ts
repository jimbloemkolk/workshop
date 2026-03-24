export { transformPipeline } from './transform';
export { aggregateJobImpactAnalysis, aggregateStats, calculateAggregatedSummary } from './aggregation';
export type { 
  GitLabJob, 
  GitLabPipeline, 
  TransformedPipelineData, 
  TransformedJob, 
  Dependency, 
  PipelineNode, 
  CriticalPathNode, 
  JobImpact,
  TimelinePipeline,
  TimelineStage,
  TimelineJob
} from './types';
export type { AggregatedJobAnalysis } from './aggregation';
export { 
  detectPipelineType, 
  getPipelineTypeInfo, 
  getPipelineTypeColor, 
  getPipelineTypeBgColor, 
  countPipelinesByType 
} from './pipelineType';
export type { PipelineType, PipelineTypeInfo } from './pipelineType';

// Re-export utility function for getting pipeline labels
export function getPipelineLabel(pipeline: { iid: number; trigger_job?: { name?: string } }): string {
  if (pipeline.trigger_job?.name) {
    return pipeline.trigger_job.name;
  }
  return `Pipeline #${pipeline.iid}`;
}
