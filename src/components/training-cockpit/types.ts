export type TrainingCockpitMode = 'live' | 'demo';

export type TrainingCockpitAvailabilityState = 'real' | 'derived' | 'unavailable';

export type TrainingCockpitStageState = 'complete' | 'active' | 'upcoming' | 'failed';

export type TrainingCockpitTrialStatus = 'pending' | 'running' | 'completed' | 'rejected' | 'best';

export type TrainingCockpitEventLevel = 'info' | 'success' | 'warning' | 'error';

export type TrainingCockpitPlaybackSpeed = 1 | 2 | 4;

export type TrainingCockpitParamValue = string | number | boolean;

export interface TrainingCockpitDatasetPreview {
  id: string;
  attachmentId: string | null;
  filename: string;
  split: 'train' | 'val' | 'test' | 'unassigned';
  status: 'ready' | 'processing' | 'uploading' | 'error';
  previewUrl: string | null;
  source: 'real' | 'derived' | 'demo';
}

export interface TrainingCockpitStage {
  id:
    | 'data_preparation'
    | 'annotation_review'
    | 'training_config'
    | 'auto_tuning'
    | 'model_training'
    | 'validation'
    | 'model_registration'
    | 'publish_handoff';
  label: string;
  description: string;
  state: TrainingCockpitStageState;
}

export interface TrainingCockpitMetricPoint {
  step: number;
  epoch: number;
  recordedAt: string;
  loss: number | null;
  valLoss: number | null;
  accuracy: number | null;
  map: number | null;
  learningRate: number | null;
  precision: number | null;
  recall: number | null;
}

export interface TrainingCockpitResourcePoint {
  recordedAt: string;
  gpuUtil: number | null;
  gpuMemory: number | null;
  gpuMemoryTotal: number | null;
  cpuUtil: number | null;
  memoryUtil: number | null;
  throughput: number | null;
  etaSeconds: number | null;
}

export interface TrainingCockpitTrial {
  trialId: string;
  params: Record<string, TrainingCockpitParamValue>;
  status: TrainingCockpitTrialStatus;
  score: number | null;
  progress: number;
  startTime: string | null;
  endTime: string | null;
  isBest: boolean;
  note: string;
  diffFromBest: number | null;
  source: 'real' | 'derived' | 'demo';
}

export interface TrainingCockpitEventLog {
  id: string;
  time: string;
  level: TrainingCockpitEventLevel;
  message: string;
  eventType: string;
  emphasis?: boolean;
}

export interface TrainingCockpitSummary {
  id: string;
  name: string;
  status: string;
  modelType: string;
  datasetVersion: string;
  modelVersion: string;
  createdAt: string;
  startedAt: string | null;
  durationSeconds: number;
  currentEpoch: number;
  totalEpoch: number;
  bestMetricLabel: string;
  bestMetricValue: number | null;
  deviceLabel: string;
  currentStageLabel: string;
  autoTuningEnabled: boolean;
  tuningStrategy: string;
  tuningAttempt: number;
  tuningTotal: number;
  recommendedParamsApplied: boolean;
  currentParams: Record<string, TrainingCockpitParamValue>;
  appliedTrialId: string | null;
  availability: {
    resources: TrainingCockpitAvailabilityState;
    tuning: TrainingCockpitAvailabilityState;
  };
}

export interface TrainingCockpitSnapshot {
  source: TrainingCockpitMode;
  lastUpdatedAt: string;
  summary: TrainingCockpitSummary;
  datasetLabel: string;
  datasetPreviews: TrainingCockpitDatasetPreview[];
  datasetPreviewAvailability: TrainingCockpitAvailabilityState;
  stages: TrainingCockpitStage[];
  metrics: TrainingCockpitMetricPoint[];
  resources: TrainingCockpitResourcePoint[];
  tuningTrials: TrainingCockpitTrial[];
  events: TrainingCockpitEventLog[];
}

export interface TrainingCockpitController {
  mode: TrainingCockpitMode;
  setMode: (mode: TrainingCockpitMode) => void;
  speed: TrainingCockpitPlaybackSpeed;
  setSpeed: (speed: TrainingCockpitPlaybackSpeed) => void;
  isPlaying: boolean;
  play: () => void;
  pause: () => void;
  replay: () => void;
  status: 'loading' | 'ready' | 'error';
  snapshot: TrainingCockpitSnapshot | null;
  error: string;
  refreshLive: () => Promise<void>;
  liveUpdatedAt: string | null;
}
