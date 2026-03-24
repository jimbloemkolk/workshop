import React, { useMemo } from 'react';
import type { GitLabJob, GitLabPipeline, TransformedPipeline } from '../types/gitlab';
import type { TransformedPipelineData } from '../../../transform/src/index';
import './CriticalPathAnalysis.css';

interface CriticalPathAnalysisProps {
  pipeline: GitLabPipeline;
  transformedPipeline: TransformedPipeline;
  transformedData?: TransformedPipelineData | null;
  onJobClick: (job: GitLabJob) => void;
}

const CriticalPathAnalysis: React.FC<CriticalPathAnalysisProps> = ({ pipeline, transformedPipeline, transformedData, onJobClick }) => {
  const analysis = transformedData ? {
      jobImpacts: transformedData.jobImpacts,
      totalDuration: transformedData.totalDuration / 1000 // Convert to seconds
    } : null;

  const formatDuration = (seconds: number) => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (hours > 0) {
      return `${hours}h ${minutes}m ${secs}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${secs}s`;
    } else {
      return `${secs}s`;
    }
  };

  if (!analysis) {
    return (
      <div className="critical-path-analysis">
        <h3>Critical Path Analysis</h3>
        <div className="no-data">No executed jobs found for analysis</div>
      </div>
    );
  }

  // Sort by impact (highest first) and take top 10
  const top10 = analysis.jobImpacts
    .sort((a, b) => b.impact - a.impact)
    .slice(0, 10);

  return (
    <div className="critical-path-analysis">
      <div className="analysis-header">
        <h3>Top 10 Jobs by Pipeline Impact</h3>
        <p className="analysis-description">
          Wall-clock time saved if each job was removed (includes blocking effects & path shifts)
        </p>
      </div>

      <div className="impact-list">
        {top10.map((item, index) => {
          const impactMultiplier = item.job.duration ? item.impact / item.job.duration : 0;
          return (
            <div 
              key={item.job.id} 
              className="impact-item"
              onClick={() => onJobClick(item.job)}
            >
              <div className="impact-rank">#{index + 1}</div>
              <div className="impact-details">
                <div className="impact-job-info">
                  <span className="impact-job-name">{item.job.name}</span>
                  <span className="impact-job-stage">{item.job.stage}</span>
                </div>
                <div className="impact-metrics">
                  <div className="impact-metric">
                    <span className="metric-label">Time Saved:</span>
                    <span className="metric-value impact-time">{formatDuration(item.impact)}</span>
                  </div>
                  <div className="impact-metric">
                    <span className="metric-label">Job Duration:</span>
                    <span className="metric-value">{formatDuration(item.job.duration!)}</span>
                  </div>
                  <div className="impact-metric">
                    <span className="metric-label">Multiplier:</span>
                    <span 
                      className="metric-value impact-percentage"
                      title="How much more time is saved than just the job duration (includes blocking effects)"
                    >
                      {impactMultiplier.toFixed(1)}x
                    </span>
                  </div>
                </div>
              </div>
              <div className="impact-bar-container">
                <div 
                  className="impact-bar"
                  style={{ width: `${Math.min(100, item.percentage * 2)}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>

      <div className="analysis-footer">
        <div className="footer-metric">
          <span className="footer-label">Total Pipeline Duration:</span>
          <span className="footer-value">{formatDuration(analysis.totalDuration)}</span>
        </div>
      </div>
    </div>
  );
};

export default React.memo(CriticalPathAnalysis);
