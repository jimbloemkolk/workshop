import type { GitLabPipeline } from './types';

export type PipelineType = 'Merge Request' | 'Merge Train' | 'Main Branch' | 'Release Candidate' | 'Release';

export interface PipelineTypeInfo {
  type: PipelineType;
  label: string;
  color: string;
  bgColor: string;
  description: string;
}

const PIPELINE_TYPE_INFO: Record<PipelineType, PipelineTypeInfo> = {
  'Merge Request': {
    type: 'Merge Request',
    label: 'MR',
    color: '#3b82f6',
    bgColor: '#eff6ff',
    description: 'Merge Request Pipeline'
  },
  'Merge Train': {
    type: 'Merge Train',
    label: 'Train',
    color: '#f59e0b',
    bgColor: '#fffbeb',
    description: 'Merge Train Pipeline'
  },
  'Main Branch': {
    type: 'Main Branch',
    label: 'Main',
    color: '#10b981',
    bgColor: '#f0fdf4',
    description: 'Main Branch Pipeline'
  },
  'Release Candidate': {
    type: 'Release Candidate',
    label: 'RC',
    color: '#8b5cf6',
    bgColor: '#faf5ff',
    description: 'Release Candidate Pipeline'
  },
  Release: {
    type: 'Release',
    label: 'Release',
    color: '#ec4899',
    bgColor: '#fdf2f8',
    description: 'Release Pipeline'
  }
};

export function detectPipelineType(pipeline: GitLabPipeline): PipelineType {
  const { ref, source } = pipeline;

  // Merge request pipelines - check source first
  if (source === 'merge_request_event') {
    // Merge train pipelines
    if (ref.includes('/merge-requests/') && ref.endsWith('/train')) {
      return 'Merge Train';
    }
    // Regular merge request pipelines
    return 'Merge Request';
  }

  // Main branch pipelines
  if (ref === 'main' && source === 'push') {
    return 'Main Branch';
  }

  // Release candidate pipelines
  if (ref.includes('-RC') && source === 'push') {
    return 'Release Candidate';
  }

  // Release/tag pipelines (any push that's not main and not a merge request)
  if (source === 'push' && ref !== 'main') {
    return 'Release';
  }

  return 'Main Branch'; // Default fallback
}

export function getPipelineTypeInfo(type: PipelineType): PipelineTypeInfo {
  return PIPELINE_TYPE_INFO[type];
}

export function getPipelineTypeColor(type: PipelineType): string {
  return PIPELINE_TYPE_INFO[type].color;
}

export function getPipelineTypeBgColor(type: PipelineType): string {
  return PIPELINE_TYPE_INFO[type].bgColor;
}

export function countPipelinesByType(pipelines: GitLabPipeline[]): Record<PipelineType, number> {
  const counts: Record<PipelineType, number> = {
    'Merge Request': 0,
    'Merge Train': 0,
    'Main Branch': 0,
    'Release Candidate': 0,
    'Release': 0
  };

  pipelines.forEach(pipeline => {
    const type = detectPipelineType(pipeline);
    counts[type]++;
  });

  return counts;
}
