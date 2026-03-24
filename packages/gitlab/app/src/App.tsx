import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { GitLabPipeline, GitLabJob, JobWithPipeline, TransformedPipeline } from './types/gitlab';
import type { DatasetInfo, LoadedDataset } from './types/dataset';
import { 
  transformPipeline as transformPipelineNew, 
  type TransformedPipelineData,
  detectPipelineType,
  getPipelineTypeInfo,
  countPipelinesByType,
  aggregateJobImpactAnalysis,
  type AggregatedJobAnalysis
} from '@workshop/transform';
import PipelineTimeline from './components/PipelineTimelineSVG';
import JobDetail from './components/JobDetail';
import CriticalPathAnalysis from './components/CriticalPathAnalysis';
import PipelineStats from './components/PipelineStats';
import './App.css';

// Helper function to convert new transform format to old format for components
function adaptTransformedPipeline(newData: TransformedPipelineData, originalPipeline: GitLabPipeline): TransformedPipeline {
  // Recreate JobWithPipeline array from the jobs and original pipeline
  const jobsMap = new Map<number, any>();
  const pipelinesMap = new Map<number, GitLabPipeline>();
  
  // Build pipeline map
  function collectPipelines(p: GitLabPipeline) {
    pipelinesMap.set(p.id, p);
    if (p.child_pipelines) {
      p.child_pipelines.forEach(collectPipelines);
    }
  }
  collectPipelines(originalPipeline);
  
  // Build jobs map
  function collectJobs(p: GitLabPipeline) {
    p.jobs.forEach(job => jobsMap.set(job.id, job));
    if (p.child_pipelines) {
      p.child_pipelines.forEach(collectJobs);
    }
  }
  collectJobs(originalPipeline);
  
  // Create allJobsWithPipeline array
  const allJobsWithPipeline: JobWithPipeline[] = newData.jobs.map(transformedJob => {
    const originalJob = jobsMap.get(transformedJob.id);
    const pipeline = pipelinesMap.get(transformedJob.pipelineId);
    return {
      job: originalJob,
      pipelineId: transformedJob.pipelineId,
      pipeline: pipeline!
    };
  });
  
  return {
    earliestTime: newData.earliestTime,
    latestTime: newData.latestTime,
    totalDuration: newData.totalDuration,
    allJobsWithPipeline
  };
}

type SortField = 'creation' | 'jobs' | 'duration' | 'efficiency' | 'parallelization';
type SortDirection = 'asc' | 'desc';

interface PipelineMetrics {
  jobCount: number;
  duration: number;
  efficiency: number;
  parallelization: number;
  createdAt: number;
}

function App() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [datasets, setDatasets] = useState<DatasetInfo[]>([]);
  const [loadedDatasets, setLoadedDatasets] = useState<Map<string, LoadedDataset>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isEditingPipelineNumber, setIsEditingPipelineNumber] = useState(false);
  const [pipelineNumberInput, setPipelineNumberInput] = useState('');

  // Read state from URL
  const selectedDatasetName = searchParams.get('dataset') || '';
  const selectedTypeFilters = useMemo(() => {
    const types = searchParams.get('types');
    return new Set(types ? types.split(',').filter(Boolean) : []);
  }, [searchParams]);

  const selectedJobNameFilter = searchParams.get('job') || '';
  const sortField = (searchParams.get('sort') as SortField) || 'creation';
  const sortDirection = (searchParams.get('dir') as SortDirection) || 'desc';
  const pipelineId = searchParams.get('pipeline');
  const selectedJobId = searchParams.get('jobId');
  const showStats = searchParams.get('view') === 'stats';

  // Helper to update URL params
  const updateParams = useCallback((updates: Record<string, string | null>) => {
    setSearchParams(prev => {
      const newParams = new URLSearchParams(prev);
      Object.entries(updates).forEach(([key, value]) => {
        if (value === null || value === '') {
          newParams.delete(key);
        } else {
          newParams.set(key, value);
        }
      });
      return newParams;
    }, { replace: true });
  }, [setSearchParams]);

  const setSelectedDataset = (datasetName: string) => {
    updateParams({ 
      dataset: datasetName,
      pipeline: null,
      jobId: null,
      view: null
    });
  };

  const setSelectedTypeFilters = (filters: Set<string>) => {
    updateParams({ types: filters.size > 0 ? Array.from(filters).join(',') : null });
  };

  const setSelectedJobNameFilter = (job: string) => {
    const trimmedJob = job.trim();
    updateParams({ job: trimmedJob || null, pipeline: null, view: null });
  };

  const setSortField = (field: SortField) => {
    updateParams({ sort: field });
  };

  const setSortDirection = (dir: SortDirection) => {
    updateParams({ dir });
  };

  const setCurrentPipeline = useCallback((pipeline: GitLabPipeline) => {
    updateParams({ 
      pipeline: pipeline.iid.toString(),
      jobId: null
    });
  }, [updateParams]);

  const setSelectedJob = useCallback((job: GitLabJob | null) => {
    updateParams({ 
      jobId: job ? job.id.toString() : null
    });
  }, [updateParams]);

  const setShowStats = useCallback((show: boolean) => {
    updateParams({ view: show ? 'stats' : null });
  }, [updateParams]);

  // Load datasets list and dataset data
  useEffect(() => {
    // Load datasets list
    fetch('/datasets.json')
      .then(response => {
        if (!response.ok) {
          throw new Error('Failed to load datasets list. Have you run the discover-datasets script?');
        }
        return response.json();
      })
      .then((datasetsList: DatasetInfo[]) => {
        setDatasets(datasetsList);
        
        // Set default dataset if none selected
        if (!selectedDatasetName && datasetsList.length > 0) {
          setSelectedDataset(datasetsList[0].name);
        }
        
        setLoading(false);
      })
      .catch(err => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  // Load selected dataset's pipelines
  useEffect(() => {
    if (!selectedDatasetName || datasets.length === 0) return;
    
    const datasetInfo = datasets.find(d => d.name === selectedDatasetName);
    if (!datasetInfo) return;
    
    // Check if already loaded
    if (loadedDatasets.has(selectedDatasetName)) return;
    
    // Load dataset
    const loadDataset = async () => {
      try {
        const [metadataRes, pipelinesRes] = await Promise.all([
          fetch(`${datasetInfo.path}/metadata.json`),
          fetch(`${datasetInfo.path}/pipelines.json`)
        ]);
        
        if (!metadataRes.ok || !pipelinesRes.ok) {
          throw new Error(`Failed to load dataset: ${selectedDatasetName}`);
        }
        
        const [metadata, pipelines] = await Promise.all([
          metadataRes.json(),
          pipelinesRes.json()
        ]);
        
        // Filter out running pipelines
        const completedPipelines = pipelines.filter((p: GitLabPipeline) => p.status !== 'running');
        
        setLoadedDatasets(prev => {
          const newMap = new Map(prev);
          newMap.set(selectedDatasetName, {
            info: datasetInfo,
            metadata,
            pipelines: completedPipelines
          });
          return newMap;
        });
      } catch (err) {
        setError(`Failed to load dataset ${selectedDatasetName}: ${err instanceof Error ? err.message : err}`);
      }
    };
    
    loadDataset();
  }, [selectedDatasetName, datasets, loadedDatasets]);

  // Get current dataset's pipelines
  const allPipelines = useMemo(() => {
    const dataset = loadedDatasets.get(selectedDatasetName);
    return dataset?.pipelines || [];
  }, [loadedDatasets, selectedDatasetName]);

  // Cache for pipeline metrics to avoid recalculation
  const metricsCache = useRef<Map<number, PipelineMetrics>>(new Map());

  const countAllJobs = (pipeline: GitLabPipeline): number => {
    let count = pipeline.jobs?.length || 0;
    if (pipeline.child_pipelines) {
      pipeline.child_pipelines.forEach(child => {
        count += countAllJobs(child);
      });
    }
    return count;
  };

  // Memoized helper to calculate pipeline metrics with caching
  const calculatePipelineMetrics = useMemo(() => {
    return (pipeline: GitLabPipeline): PipelineMetrics => {
      // Check cache first
      const cached = metricsCache.current.get(pipeline.id);
      if (cached) {
        return cached;
      }

      // Calculate metrics using transform package
      const transformed = transformPipelineNew(pipeline);
      const { stats } = transformed;
      
      const totalWaitingTime = stats.totalWaitingTime;
      const totalExecutionTime = stats.totalExecutionTime;
      const efficiency = stats.efficiency;
      const pipelineDuration = pipeline.duration || 0;
      const parallelizationFactor = pipelineDuration > 0 ? totalExecutionTime / pipelineDuration : 0;
      
      const metrics: PipelineMetrics = {
        jobCount: countAllJobs(pipeline),
        duration: pipelineDuration,
        efficiency,
        parallelization: parallelizationFactor,
        createdAt: new Date(pipeline.created_at).getTime()
      };

      // Cache the result
      metricsCache.current.set(pipeline.id, metrics);
      return metrics;
    };
  }, []);

  // Get all unique job names from all pipelines
  const allJobNames = useMemo(() => {
    const jobNames = new Set<string>();
    allPipelines.forEach(pipeline => {
      const gatherJobNames = (p: GitLabPipeline) => {
        p.jobs?.forEach(job => jobNames.add(job.name));
        p.child_pipelines?.forEach(child => gatherJobNames(child));
      };
      gatherJobNames(pipeline);
    });
    return Array.from(jobNames).sort();
  }, [allPipelines]);

  // Filter and sort pipelines based on selected types, job name, and sort options
  const pipelines = useMemo(() => {
    let filtered = allPipelines;

    // Filter by type
    if (selectedTypeFilters.size > 0) {
      filtered = filtered.filter(p => {
        const type = detectPipelineType(p);
        return selectedTypeFilters.has(type);
      });
    }

    // Filter by job name
    if (selectedJobNameFilter) {
      filtered = filtered.filter(p => {
        const hasJob = (pipeline: GitLabPipeline): boolean => {
          const hasInJobs = pipeline.jobs?.some(job => job.name === selectedJobNameFilter) || false;
          const hasInChildren = pipeline.child_pipelines?.some(child => hasJob(child)) || false;
          return hasInJobs || hasInChildren;
        };
        return hasJob(p);
      });
    }

    // Sort pipelines
    const sorted = [...filtered].sort((a, b) => {
      const metricsA = calculatePipelineMetrics(a);
      const metricsB = calculatePipelineMetrics(b);
      
      let comparison = 0;
      switch (sortField) {
        case 'creation':
          comparison = metricsA.createdAt - metricsB.createdAt;
          break;
        case 'jobs':
          comparison = metricsA.jobCount - metricsB.jobCount;
          break;
        case 'duration':
          comparison = metricsA.duration - metricsB.duration;
          break;
        case 'efficiency':
          comparison = metricsA.efficiency - metricsB.efficiency;
          break;
        case 'parallelization':
          comparison = metricsA.parallelization - metricsB.parallelization;
          break;
      }
      
      return sortDirection === 'asc' ? comparison : -comparison;
    });

    return sorted;
  }, [allPipelines, selectedTypeFilters, selectedJobNameFilter, sortField, sortDirection]);

  // Derive currentIndex from pipeline ID, or default to 0
  const currentIndex = useMemo(() => {
    if (pipelines.length === 0) return 0;
    if (pipelineId) {
      const index = pipelines.findIndex(p => p.iid.toString() === pipelineId);
      return index !== -1 ? index : 0;
    }
    return 0;
  }, [pipelines, pipelineId]);

  // Set initial pipeline ID when pipelines load or filters change
  useEffect(() => {
    if (pipelines.length === 0) return;
    
    const currentPipelineId = pipelines[currentIndex]?.iid.toString();
    
    // If no pipeline in URL or current one not found, set the first one
    if (!pipelineId || currentPipelineId !== pipelineId) {
      setSearchParams(prev => {
        const newParams = new URLSearchParams(prev);
        if (currentPipelineId) {
          newParams.set('pipeline', currentPipelineId);
        }
        return newParams;
      }, { replace: true });
    }
  }, [pipelines, pipelineId, currentIndex, setSearchParams]);

  // Toggle type filter
  const toggleTypeFilter = (type: string) => {
    const newFilters = new Set(selectedTypeFilters);
    if (newFilters.has(type)) {
      newFilters.delete(type);
    } else {
      newFilters.add(type);
    }
    setSelectedTypeFilters(newFilters);
  };

  const currentPipeline = pipelines[currentIndex];

  // Find selected job from URL
  const selectedJob = useMemo(() => {
    if (!selectedJobId || !currentPipeline) return null;
    const findJob = (pipeline: GitLabPipeline): GitLabJob | null => {
      const job = pipeline.jobs?.find(j => j.id.toString() === selectedJobId);
      if (job) return job;
      if (pipeline.child_pipelines) {
        for (const child of pipeline.child_pipelines) {
          const found = findJob(child);
          if (found) return found;
        }
      }
      return null;
    };
    return findJob(currentPipeline);
  }, [selectedJobId, currentPipeline]);

  // Handle pipeline number input submission
  const handlePipelineNumberSubmit = () => {
    const num = parseInt(pipelineNumberInput, 10);
    if (!isNaN(num) && num >= 1 && num <= pipelines.length) {
      setCurrentPipeline(pipelines[num - 1]);
    }
    setIsEditingPipelineNumber(false);
    setPipelineNumberInput('');
  };

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (selectedJob) return; // Don't navigate when modal is open
      if (isEditingPipelineNumber) return; // Don't navigate when editing pipeline number

      if (event.key === 'ArrowLeft' && currentIndex > 0) {
        setCurrentPipeline(pipelines[currentIndex - 1]);
      } else if (event.key === 'ArrowRight' && currentIndex < pipelines.length - 1) {
        setCurrentPipeline(pipelines[currentIndex + 1]);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [pipelines, selectedJob, currentIndex, isEditingPipelineNumber]);

  // Transform current pipeline data
  const transformedPipelineData = useMemo(() => {
    if (!currentPipeline) return null;
    return transformPipelineNew(currentPipeline);
  }, [currentPipeline]);

  const transformedPipeline = useMemo(() => {
    if (!currentPipeline || !transformedPipelineData) return null;
    return adaptTransformedPipeline(transformedPipelineData, currentPipeline);
  }, [currentPipeline, transformedPipelineData]);

  // Calculate aggregated job impact analysis for all filtered pipelines
  // Only recalculate when showStats is true to avoid expensive computation
  const aggregatedJobImpact = useMemo(() => {
    if (!showStats || pipelines.length === 0) return [];
    return aggregateJobImpactAnalysis(pipelines);
  }, [pipelines, showStats]);

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString();
  };

  if (loading) {
    return (
      <div className="app">
        <div className="loading">
          <div className="spinner"></div>
          <p>Loading pipeline data...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="app">
        <div className="error">
          <h2>⚠️ Error Loading Data</h2>
          <p>{error}</p>
          <p>Please run the fetch script first:</p>
          <code>node fetch-pipelines.js &lt;project-path&gt; [days]</code>
        </div>
      </div>
    );
  }

  if (pipelines.length === 0) {
    return (
      <div className="app">
        <div className="error">
          <h2>No Pipelines Found</h2>
          <p>No pipeline data available.</p>
        </div>
      </div>
    );
  }

  if (showStats) {
    return (
      <PipelineStats
        pipelines={pipelines}
        aggregatedJobImpact={aggregatedJobImpact}
        onBack={() => setShowStats(false)}
        onJobNameClick={(jobName) => {
          // Update all params at once to avoid race condition
          updateParams({ 
            job: jobName.trim() || null, 
            pipeline: null, 
            view: null 
          });
        }}
      />
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1 style={{ fontSize: '18px', display: 'flex', alignItems: 'center', gap: '8px' }}><img src="/image.png" alt="Logo" style={{ height: '32px', width: '32px', objectFit: 'contain' }} /> GitLab Pipeline Visualizer</h1>
        <div style={{ display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap' }}>
          {/* Dataset picker */}
          {datasets.length > 1 && (
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <label style={{ fontSize: '13px', fontWeight: '600', color: '#64748b' }}>
                Dataset:
              </label>
              <select
                value={selectedDatasetName}
                onChange={(e) => setSelectedDataset(e.target.value)}
                style={{
                  padding: '6px 12px',
                  borderRadius: '6px',
                  border: '2px solid #e2e8f0',
                  fontSize: '13px',
                  fontWeight: '500',
                  backgroundColor: '#3b82f6',
                  color: 'white',
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                  outline: 'none',
                  minWidth: '200px',
                }}
                title="Switch between datasets"
              >
                {datasets.map(dataset => (
                  <option key={dataset.name} value={dataset.name}>
                    {dataset.displayName} ({dataset.pipeline_count} pipelines)
                  </option>
                ))}
              </select>
            </div>
          )}
          
          {isEditingPipelineNumber ? (
            <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
              <span style={{ fontSize: '13px', fontWeight: '600', color: '#64748b' }}>
                Go to pipeline:
              </span>
              <input
                type="number"
                min="1"
                max={pipelines.length}
                value={pipelineNumberInput}
                onChange={(e) => setPipelineNumberInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handlePipelineNumberSubmit();
                  } else if (e.key === 'Escape') {
                    setIsEditingPipelineNumber(false);
                    setPipelineNumberInput('');
                  }
                }}
                autoFocus
                style={{
                  width: '80px',
                  padding: '6px 12px',
                  borderRadius: '6px',
                  border: '2px solid #3b82f6',
                  fontSize: '13px',
                  fontWeight: '600',
                  outline: 'none',
                }}
              />
              <span style={{ fontSize: '13px', fontWeight: '600', color: '#64748b' }}>
                of {pipelines.length}
              </span>
              <button
                onClick={handlePipelineNumberSubmit}
                style={{
                  background: '#3b82f6',
                  color: 'white',
                  border: 'none',
                  padding: '6px 12px',
                  borderRadius: '6px',
                  fontSize: '12px',
                  fontWeight: '600',
                  cursor: 'pointer',
                }}
              >
                Go
              </button>
              <button
                onClick={() => {
                  setIsEditingPipelineNumber(false);
                  setPipelineNumberInput('');
                }}
                style={{
                  background: '#64748b',
                  color: 'white',
                  border: 'none',
                  padding: '6px 12px',
                  borderRadius: '6px',
                  fontSize: '12px',
                  fontWeight: '600',
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
            </div>
          ) : (
            <div
              className="pipeline-counter"
              onClick={() => {
                setIsEditingPipelineNumber(true);
                setPipelineNumberInput((currentIndex + 1).toString());
              }}
              style={{ cursor: 'pointer' }}
              title="Click to jump to a specific pipeline"
            >
              Pipeline {currentIndex + 1} of {pipelines.length}
            </div>
          )}
          <button
            onClick={() => setShowStats(true)}
            style={{
              background: '#3b82f6',
              color: 'white',
              border: 'none',
              padding: '8px 16px',
              borderRadius: '6px',
              fontWeight: '600',
              cursor: 'pointer',
              fontSize: '13px',
              transition: 'all 0.2s',
            }}
            onMouseEnter={(e) => e.currentTarget.style.background = '#2563eb'}
            onMouseLeave={(e) => e.currentTarget.style.background = '#3b82f6'}
            title="View aggregated statistics for all pipelines"
          >
            📊 Stats
          </button>
          
          {/* Sort controls */}
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <label style={{ fontSize: '13px', fontWeight: '600', color: '#64748b' }}>
              Sort by:
            </label>
            <select
              value={sortField}
              onChange={(e) => setSortField(e.target.value as SortField)}
              style={{
                padding: '6px 12px',
                borderRadius: '6px',
                border: '2px solid #e2e8f0',
                fontSize: '13px',
                fontWeight: '500',
                backgroundColor: 'white',
                color: '#334155',
                cursor: 'pointer',
                transition: 'all 0.2s',
                outline: 'none',
              }}
            >
              <option value="creation">Creation time</option>
              <option value="jobs">Number of jobs</option>
              <option value="duration">Pipeline duration</option>
              <option value="efficiency">Efficiency</option>
              <option value="parallelization">Parallelization</option>
            </select>
            <button
              onClick={() => setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc')}
              style={{
                background: '#64748b',
                color: 'white',
                border: 'none',
                padding: '6px 12px',
                borderRadius: '6px',
                fontSize: '16px',
                fontWeight: '600',
                cursor: 'pointer',
                transition: 'all 0.2s',
                width: '40px',
                height: '34px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              onMouseEnter={(e) => e.currentTarget.style.background = '#475569'}
              onMouseLeave={(e) => e.currentTarget.style.background = '#64748b'}
              title={sortDirection === 'asc' ? 'Ascending order (click for descending)' : 'Descending order (click for ascending)'}
            >
              {sortDirection === 'asc' ? '↑' : '↓'}
            </button>
          </div>

          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <label style={{ fontSize: '13px', fontWeight: '600', color: '#64748b' }}>
              Filter by job:
            </label>
            <select
              value={selectedJobNameFilter}
              onChange={(e) => setSelectedJobNameFilter(e.target.value)}
              style={{
                padding: '6px 12px',
                borderRadius: '6px',
                border: '2px solid #e2e8f0',
                fontSize: '13px',
                fontWeight: '500',
                backgroundColor: selectedJobNameFilter ? '#3b82f6' : 'white',
                color: selectedJobNameFilter ? 'white' : '#334155',
                cursor: 'pointer',
                transition: 'all 0.2s',
                outline: 'none',
                minWidth: '200px',
              }}
              title="Filter pipelines by job name"
            >
              <option value="">All jobs ({allPipelines.length} pipelines)</option>
              {allJobNames.map(jobName => (
                <option key={jobName} value={jobName}>
                  {jobName}
                </option>
              ))}
            </select>
            {selectedJobNameFilter && (
              <button
                onClick={() => setSelectedJobNameFilter('')}
                style={{
                  background: '#ef4444',
                  color: 'white',
                  border: 'none',
                  padding: '6px 12px',
                  borderRadius: '6px',
                  fontSize: '12px',
                  fontWeight: '600',
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = '#dc2626'}
                onMouseLeave={(e) => e.currentTarget.style.background = '#ef4444'}
                title="Clear job filter"
              >
                ✕
              </button>
            )}
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            {Object.entries(countPipelinesByType(allPipelines)).map(([type, count]) => {
              if (count === 0) return null;
              const typeInfo = getPipelineTypeInfo(type as any);
              const isSelected = selectedTypeFilters.has(type);
              return (
                <button
                  key={type}
                  onClick={() => toggleTypeFilter(type)}
                  style={{
                    backgroundColor: isSelected ? typeInfo.color : typeInfo.bgColor,
                    color: isSelected ? 'white' : typeInfo.color,
                    padding: '4px 10px',
                    borderRadius: '4px',
                    fontSize: '11px',
                    fontWeight: '600',
                    border: `2px solid ${typeInfo.color}`,
                    whiteSpace: 'nowrap',
                    display: 'flex',
                    gap: '4px',
                    alignItems: 'center',
                    cursor: 'pointer',
                    transition: 'all 0.2s ease',
                    boxShadow: isSelected ? `0 0 8px ${typeInfo.color}40` : 'none',
                  }}
                  title={`${count} ${typeInfo.description}${count > 1 ? 's' : ''} - Click to filter`}
                >
                  <span>{typeInfo.label}</span>
                  <span style={{ fontWeight: 'bold' }}>{count}</span>
                </button>
              );
            })}
          </div>
        </div>
      </header>

      <div className="pipeline-info">
        <div className="pipeline-info-section">
          <span className="info-label">Pipeline ID:</span>
          <span className="info-value">#{currentPipeline.iid}</span>
        </div>
        <div className="pipeline-info-section">
          <span className="info-label">Type:</span>
          {(() => {
            const pipelineType = detectPipelineType(currentPipeline);
            const typeInfo = getPipelineTypeInfo(pipelineType);
            return (
              <span
                className="pipeline-type-badge"
                style={{
                  backgroundColor: typeInfo.bgColor,
                  color: typeInfo.color,
                  padding: '4px 12px',
                  borderRadius: '4px',
                  fontSize: '12px',
                  fontWeight: '600',
                  border: `1px solid ${typeInfo.color}`,
                  display: 'inline-block',
                }}
                title={typeInfo.description}
              >
                {typeInfo.label}
              </span>
            );
          })()}
        </div>
        <div className="pipeline-info-section">
          <span className="info-label">Status:</span>
          <span className={`status-badge status-${currentPipeline.status}`}>
            {currentPipeline.status}
          </span>
        </div>
        <div className="pipeline-info-section">
          <span className="info-label">Jobs:</span>
          <span className="info-value">{countAllJobs(currentPipeline)}</span>
        </div>
        <div className="pipeline-info-section">
          <span className="info-label">Branch:</span>
          <span className="info-value">{currentPipeline.ref}</span>
        </div>
        <div className="pipeline-info-section">
          <span className="info-label">Created:</span>
          <span className="info-value">{formatDate(currentPipeline.created_at)}</span>
        </div>
        <div className="pipeline-info-section">
          <a
            href={currentPipeline.web_url}
            target="_blank"
            rel="noopener noreferrer"
            className="gitlab-link"
          >
            View in GitLab →
          </a>
        </div>
      </div>

      <div className="legend">
        <div className="legend-item">
          <div className="legend-box solid"></div>
          <span>Job execution time</span>
        </div>
        <div className="legend-item">
          <div className="legend-box dashed"></div>
          <span>Pending time (waiting to start)</span>
        </div>
      </div>

      {transformedPipeline && (
        <>
          <PipelineTimeline
            pipeline={currentPipeline}
            transformedPipeline={transformedPipeline}
            transformedData={transformedPipelineData}
            onJobClick={setSelectedJob}
          />

          <CriticalPathAnalysis
            pipeline={currentPipeline}
            transformedPipeline={transformedPipeline}
            transformedData={transformedPipelineData}
            onJobClick={setSelectedJob}
          />
        </>
      )}

      <div className="navigation-hint">
        <kbd>←</kbd> <kbd>→</kbd> Use arrow keys to navigate between pipelines
      </div>

      {selectedJob && (
        <JobDetail
          job={selectedJob}
          onClose={() => setSelectedJob(null)}
        />
      )}
    </div>
  );
}

export default App;
