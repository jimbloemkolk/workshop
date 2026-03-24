import React, { useEffect } from 'react';
import type { GitLabJob } from '../types/gitlab';
import './JobDetail.css';

interface JobDetailProps {
  job: GitLabJob;
  onClose: () => void;
}

const JobDetail: React.FC<JobDetailProps> = ({ job, onClose }) => {
  // Handle escape key to close modal
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const formatDate = (date: string | null) => {
    if (!date) return 'N/A';
    return new Date(date).toLocaleString();
  };

  const formatDuration = (seconds: number | null) => {
    if (seconds === null) return 'N/A';
    
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

  return (
    <div className="job-detail-overlay" onClick={onClose}>
      <div className="job-detail-modal" onClick={(e) => e.stopPropagation()}>
        <div className="job-detail-header">
          <h2>{job.name}</h2>
          <button className="close-button" onClick={onClose}>×</button>
        </div>
        
        <div className="job-detail-content">
          <div className="job-detail-section">
            <h3>Status</h3>
            <div className={`job-status-badge status-${job.status}`}>
              {job.status}
            </div>
          </div>

          <div className="job-detail-section">
            <h3>Stage</h3>
            <p>{job.stage}</p>
          </div>

          <div className="job-detail-section">
            <h3>Duration</h3>
            <p>{formatDuration(job.duration)}</p>
          </div>

          {job.queued_duration && (
            <div className="job-detail-section">
              <h3>Queued Time</h3>
              <p>{formatDuration(job.queued_duration)}</p>
              <p style={{ fontSize: '12px', color: '#6b7280', marginTop: '4px' }}>
                Time spent waiting in queue for a runner
              </p>
            </div>
          )}

          <div className="job-detail-section">
            <h3>Timeline</h3>
            <div className="job-timeline">
              <div className="timeline-item">
                <span className="timeline-label">Created:</span>
                <span className="timeline-value">{formatDate(job.created_at)}</span>
              </div>
              <div className="timeline-item">
                <span className="timeline-label">Started:</span>
                <span className="timeline-value">{formatDate(job.started_at)}</span>
              </div>
              <div className="timeline-item">
                <span className="timeline-label">Finished:</span>
                <span className="timeline-value">{formatDate(job.finished_at)}</span>
              </div>
            </div>
          </div>

          {job.user && (
            <div className="job-detail-section">
              <h3>Triggered By</h3>
              <div className="user-info">
                {job.user.avatar_url && (
                  <img src={job.user.avatar_url} alt={job.user.name} className="user-avatar" />
                )}
                <div>
                  <div>{job.user.name}</div>
                  <div className="user-username">@{job.user.username}</div>
                </div>
              </div>
            </div>
          )}

          {job.runner && (
            <div className="job-detail-section">
              <h3>Runner</h3>
              <p>{job.runner.description}</p>
              <p className="runner-status">
                Status: {job.runner.active ? 'Active' : 'Inactive'}
              </p>
            </div>
          )}

          {job.allow_failure && (
            <div className="job-detail-section">
              <div className="info-badge">
                ⚠️ This job is allowed to fail
              </div>
            </div>
          )}

          <div className="job-detail-section">
            <a 
              href={job.web_url} 
              target="_blank" 
              rel="noopener noreferrer"
              className="gitlab-link-button"
            >
              View in GitLab →
            </a>
          </div>
        </div>
      </div>
    </div>
  );
};

export default React.memo(JobDetail);
