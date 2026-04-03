import type {
  ModelFramework,
  TaskType,
  UnifiedInferenceOutput
} from './domain';

export interface ValidateDatasetInput {
  datasetId: string;
  taskType: TaskType;
}

export interface ValidateDatasetResult {
  valid: boolean;
  warnings: string[];
}

export interface TrainInput {
  trainingJobId: string;
  datasetId: string;
  taskType: TaskType;
  baseModel: string;
  config: Record<string, string>;
  workspaceDir?: string;
  configPath?: string;
  summaryPath?: string;
  metricsPath?: string;
  artifactPath?: string;
}

export interface TrainResult {
  accepted: boolean;
  logPreview: string;
  execution_mode?: 'simulated' | 'local_command';
  logs?: string[];
  metrics?: Record<string, number>;
  metric_series?: Array<{
    step: number;
    metrics: Record<string, number>;
  }>;
}

export interface EvaluateInput {
  trainingJobId: string;
}

export interface EvaluateResult {
  metrics: Record<string, number>;
}

export interface PredictInput {
  modelId: string;
  modelVersionId: string;
  inputAttachmentId: string;
  filename: string;
  taskType: TaskType;
  inputMimeType?: string | null;
  inputByteSize?: number | null;
  inputStoragePath?: string | null;
}

export interface ExportInput {
  modelVersionId: string;
}

export interface ExportResult {
  artifactPath: string;
}

export interface LoadModelInput {
  modelVersionId: string;
}

export interface LoadedModelRef {
  handle: string;
}

export interface UnifiedTrainer {
  framework: ModelFramework;
  supportedTasks: TaskType[];
  validate_dataset(input: ValidateDatasetInput): Promise<ValidateDatasetResult>;
  train(input: TrainInput): Promise<TrainResult>;
  evaluate(input: EvaluateInput): Promise<EvaluateResult>;
  predict(input: PredictInput): Promise<UnifiedInferenceOutput>;
  export(input: ExportInput): Promise<ExportResult>;
  load_model(input: LoadModelInput): Promise<LoadedModelRef>;
}
