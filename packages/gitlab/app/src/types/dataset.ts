export interface DatasetInfo {
  name: string;
  displayName: string;
  project: string;
  fetched_at: string;
  days_back: number;
  pipeline_count: number;
  path: string;
}

export interface DatasetMetadata {
  dataset_name: string;
  project: string;
  fetched_at: string;
  days_back: number;
  date_threshold: string;
  pipeline_count: number;
  new_pipelines: number;
  existing_pipelines: number;
  failed_pipelines: number;
  cached_pipelines: number;
  failed_pipeline_details: any[];
}

export interface LoadedDataset {
  info: DatasetInfo;
  metadata: DatasetMetadata;
  pipelines: any[];
}
