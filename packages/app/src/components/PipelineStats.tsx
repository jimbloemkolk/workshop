import React from 'react';
import type { AggregatedJobAnalysis } from '../../../../packages/transform/src/index';
import { calculateAggregatedSummary } from '../../../../packages/transform/src/index';
import './PipelineStats.css';

interface PipelineStatsProps {
  pipelines: any[];
  aggregatedJobImpact: AggregatedJobAnalysis[];
  onBack: () => void;
  onJobNameClick: (jobName: string) => void;
}

const PipelineStats: React.FC<PipelineStatsProps> = ({ pipelines, aggregatedJobImpact, onBack, onJobNameClick }) => {
  const formatDuration = (seconds: number) => {
    if (seconds < 1) return '< 1s';
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

  const formatPercent = (value: number) => {
    return value.toFixed(1);
  };

  if (pipelines.length === 0 || aggregatedJobImpact.length === 0) {
    return (
      <div className="stats-page">
        <div className="stats-header">
          <button className="back-button" onClick={onBack}>← Back</button>
          <h2>Pipeline Statistics</h2>
        </div>
        <div className="stats-content">
          <p>No pipelines to analyze</p>
        </div>
      </div>
    );
  }

  // Calculate summary statistics from aggregated data using transform package
  const summary = calculateAggregatedSummary(aggregatedJobImpact);

  return (
    <div className="stats-page">
      <div className="stats-header">
        <button className="back-button" onClick={onBack}>← Back</button>
        <h2>Pipeline Statistics</h2>
      </div>

      <div className="stats-content">
        <div className="summary-cards">
          <div className="summary-card">
            <div className="card-label">Pipelines Analyzed</div>
            <div className="card-value">{pipelines.length}</div>
          </div>
          <div className="summary-card">
            <div className="card-label">Total Impact Time</div>
            <div className="card-value">{formatDuration(summary.totalImpactTime)}</div>
          </div>
          <div className="summary-card">
            <div className="card-label">Jobs with Impact</div>
            <div className="card-value">{aggregatedJobImpact.length}</div>
          </div>
          <div className="summary-card">
            <div className="card-label">Avg Impact Per Job</div>
            <div className="card-value">{formatPercent(summary.avgImpactPercent)}%</div>
          </div>
          <div className="summary-card">
            <div className="card-label">Total Occurrences</div>
            <div className="card-value">
              {summary.totalOccurrences}
            </div>
          </div>
        </div>

        <div className="table-section">
          <h3>Job Critical Path Impact Analysis</h3>
          <p className="table-description">
            Sorted by total impact (time a job contributes to critical path). Shows cumulative impact across all pipelines and average impact percentage.
          </p>
          
          <div className="table-wrapper">
            <table className="stats-table">
              <thead>
                <tr>
                  <th className="col-name">Job Name</th>
                  <th className="col-number">Occurrences</th>
                  <th className="col-duration">Avg Duration</th>
                  <th className="col-duration">Total Impact</th>
                  <th className="col-impact">Avg Impact %</th>
                  <th className="col-status">Failed</th>
                  <th className="col-status">Skipped</th>
                </tr>
              </thead>
              <tbody>
                {aggregatedJobImpact.map((job, idx) => (
                  <tr key={idx} className={idx % 2 === 0 ? 'row-even' : 'row-odd'}>
                    <td className="col-name">
                      <span className="job-name-badge">{idx + 1}</span>
                      <span
                        onClick={() => onJobNameClick(job.jobName)}
                        style={{
                          cursor: 'pointer',
                          textDecoration: 'underline',
                          color: '#3b82f6',
                          fontWeight: '500',
                        }}
                        title={`Click to filter pipelines with "${job.jobName}"`}
                      >
                        {job.jobName}
                      </span>
                    </td>
                    <td className="col-number">{job.occurrences}</td>
                    <td className="col-duration">{formatDuration(job.avgDurationPerOccurrence)}</td>
                    <td className="col-duration">
                      <strong>{formatDuration(job.totalImpactSeconds)}</strong>
                    </td>
                    <td className="col-impact">
                      <div className="impact-container">
                        <div className="impact-bar" style={{
                          width: `${Math.min(job.averageImpactPercent, 100)}%`,
                          backgroundColor: job.averageImpactPercent > 50 ? '#ef4444' 
                            : job.averageImpactPercent > 25 ? '#f59e0b'
                            : '#10b981'
                        }} />
                        <span className="impact-value">{formatPercent(job.averageImpactPercent)}%</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="insights">
          <h3>Key Insights</h3>
          <ul>
            {aggregatedJobImpact.length > 0 && (
              <>
                <li>
                  <strong>Most Critical Job:</strong> "{aggregatedJobImpact[0].jobName}" - {formatDuration(aggregatedJobImpact[0].totalImpactSeconds)} impact across {aggregatedJobImpact[0].occurrences} occurrences, averaging {formatPercent(aggregatedJobImpact[0].averageImpactPercent)}% of pipeline time
                </li>
                {aggregatedJobImpact.slice(0, 3).reduce((acc, j) => acc + j.averageImpactPercent, 0) > 50 && (
                  <li>
                    <strong>Top 3 Jobs:</strong> Averaging {formatPercent(aggregatedJobImpact.slice(0, 3).reduce((acc, j) => acc + j.averageImpactPercent, 0) / 3)}% impact combined - focus optimization efforts here
                  </li>
                )}
                <li>
                  <strong>Total Critical Path Impact:</strong> {formatDuration(summary.totalImpactTime)} across all {pipelines.length} pipelines
                </li>
                <li>
                  <strong>Average Impact Per Job Type:</strong> {formatPercent(
                    aggregatedJobImpact.reduce((sum, j) => sum + j.averageImpactPercent, 0) / aggregatedJobImpact.length
                  )}%
                </li>
              </>
            )}
          </ul>
        </div>
      </div>
    </div>
  );
};

export default React.memo(PipelineStats);
