export type SystemRole = 'user' | 'admin';
export type Capability = 'manage_models' | 'global_governance';

export type TaskType = 'ocr' | 'detection' | 'classification' | 'segmentation' | 'obb';
export type ModelFramework = 'paddleocr' | 'doctr' | 'yolo';

export type ModelVisibility = 'private' | 'workspace' | 'public';
export type ModelStatus =
  | 'draft'
  | 'pending_approval'
  | 'approved'
  | 'rejected'
  | 'published'
  | 'deprecated';

export type ConversationStatus = 'active' | 'completed' | 'archived';
export type MessageSender = 'user' | 'assistant' | 'system';

export type FileAttachmentStatus = 'uploading' | 'processing' | 'ready' | 'error';
export type AttachmentTargetType = 'Conversation' | 'Model' | 'Dataset' | 'InferenceRun';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export type DatasetStatus = 'draft' | 'ready' | 'archived';
export type DatasetItemSplit = 'train' | 'val' | 'test' | 'unassigned';
export type DatasetItemStatus = 'uploading' | 'processing' | 'ready' | 'error';

export type AnnotationSource = 'manual' | 'import' | 'pre_annotation';
export type AnnotationStatus =
  | 'unannotated'
  | 'in_progress'
  | 'annotated'
  | 'in_review'
  | 'approved'
  | 'rejected';

export type TrainingJobStatus =
  | 'draft'
  | 'queued'
  | 'preparing'
  | 'running'
  | 'evaluating'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ModelVersionStatus = 'registered' | 'deprecated';
export type InferenceRunStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface User {
  id: string;
  email: string;
  username: string;
  role: SystemRole;
  capabilities: Capability[];
  created_at: string;
  updated_at: string;
}

export interface ModelRecord {
  id: string;
  name: string;
  description: string;
  model_type: TaskType;
  owner_user_id: string;
  visibility: ModelVisibility;
  status: ModelStatus;
  metadata: Record<string, string>;
  created_at: string;
  updated_at: string;
}

export interface ConversationRecord {
  id: string;
  model_id: string;
  title: string;
  status: ConversationStatus;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface MessageRecord {
  id: string;
  conversation_id: string;
  sender: MessageSender;
  content: string;
  attachment_ids: string[];
  created_at: string;
}

export interface FileAttachment {
  id: string;
  filename: string;
  status: FileAttachmentStatus;
  owner_user_id: string;
  attached_to_type: AttachmentTargetType;
  attached_to_id: string | null;
  upload_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApprovalRequest {
  id: string;
  model_id: string;
  requested_by: string;
  approved_by: string | null;
  status: ApprovalStatus;
  review_notes: string | null;
  requested_at: string;
  reviewed_at: string | null;
}

export interface AuditLogRecord {
  id: string;
  user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  metadata: Record<string, string>;
  timestamp: string;
}

export interface DatasetRecord {
  id: string;
  name: string;
  description: string;
  task_type: TaskType;
  status: DatasetStatus;
  owner_user_id: string;
  label_schema: {
    classes: string[];
  };
  metadata: Record<string, string>;
  created_at: string;
  updated_at: string;
}

export interface DatasetItemRecord {
  id: string;
  dataset_id: string;
  attachment_id: string;
  split: DatasetItemSplit;
  status: DatasetItemStatus;
  metadata: Record<string, string>;
  created_at: string;
  updated_at: string;
}

export interface AnnotationRecord {
  id: string;
  dataset_item_id: string;
  task_type: TaskType;
  source: AnnotationSource;
  status: AnnotationStatus;
  payload: Record<string, unknown>;
  annotated_by: string;
  created_at: string;
  updated_at: string;
}

export interface AnnotationWithReview extends AnnotationRecord {
  latest_review: AnnotationReviewRecord | null;
}

export interface AnnotationReviewRecord {
  id: string;
  annotation_id: string;
  reviewer_user_id: string;
  status: 'approved' | 'rejected';
  quality_score: number | null;
  review_comment: string | null;
  created_at: string;
}

export interface DatasetVersionRecord {
  id: string;
  dataset_id: string;
  version_name: string;
  split_summary: {
    train: number;
    val: number;
    test: number;
    unassigned: number;
  };
  item_count: number;
  annotation_coverage: number;
  created_by: string;
  created_at: string;
}

export interface TrainingJobRecord {
  id: string;
  name: string;
  task_type: TaskType;
  framework: ModelFramework;
  status: TrainingJobStatus;
  dataset_id: string;
  dataset_version_id: string | null;
  base_model: string;
  config: Record<string, string>;
  log_excerpt: string;
  submitted_by: string;
  created_at: string;
  updated_at: string;
}

export interface TrainingMetricRecord {
  id: string;
  training_job_id: string;
  metric_name: string;
  metric_value: number;
  step: number;
  recorded_at: string;
}

export interface ModelVersionRecord {
  id: string;
  model_id: string;
  training_job_id: string | null;
  version_name: string;
  task_type: TaskType;
  framework: ModelFramework;
  status: ModelVersionStatus;
  metrics_summary: Record<string, string>;
  artifact_attachment_id: string | null;
  created_by: string;
  created_at: string;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  score: number;
}

export interface RotatedBox {
  cx: number;
  cy: number;
  width: number;
  height: number;
  angle: number;
  label: string;
  score: number;
}

export interface PolygonPrediction {
  label: string;
  score: number;
  points: Array<{ x: number; y: number }>;
}

export interface MaskPrediction {
  label: string;
  score: number;
  encoding: string;
}

export interface LabelPrediction {
  label: string;
  score: number;
}

export interface OcrTextPrediction {
  text: string;
  confidence: number;
}

export interface UnifiedInferenceOutput {
  image: {
    filename: string;
    width: number;
    height: number;
    source_attachment_id?: string;
  };
  task_type: TaskType;
  framework: ModelFramework;
  model: {
    model_id: string;
    model_version_id: string;
    name: string;
    version: string;
  };
  boxes: BoundingBox[];
  rotated_boxes: RotatedBox[];
  polygons: PolygonPrediction[];
  masks: MaskPrediction[];
  labels: LabelPrediction[];
  ocr: {
    lines: OcrTextPrediction[];
    words: OcrTextPrediction[];
  };
  raw_output: Record<string, unknown>;
  normalized_output: Record<string, unknown>;
}

export interface InferenceRunRecord {
  id: string;
  model_version_id: string;
  input_attachment_id: string;
  task_type: TaskType;
  framework: ModelFramework;
  status: InferenceRunStatus;
  raw_output: Record<string, unknown>;
  normalized_output: UnifiedInferenceOutput;
  feedback_dataset_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface RegisterInput {
  email: string;
  username: string;
  password: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface CreateModelDraftInput {
  name: string;
  description: string;
  model_type: TaskType;
  visibility: ModelVisibility;
}

export interface CreateDatasetInput {
  name: string;
  description: string;
  task_type: TaskType;
  label_schema: {
    classes: string[];
  };
}

export interface CreateTrainingJobInput {
  name: string;
  task_type: TaskType;
  framework: ModelFramework;
  dataset_id: string;
  dataset_version_id?: string | null;
  base_model: string;
  config: Record<string, string>;
}

export interface UpsertAnnotationInput {
  dataset_item_id: string;
  task_type: TaskType;
  source: AnnotationSource;
  status: AnnotationStatus;
  payload: Record<string, unknown>;
}

export interface ReviewAnnotationInput {
  status: 'approved' | 'rejected';
  quality_score?: number | null;
  review_comment?: string | null;
}

export interface RegisterModelVersionInput {
  model_id: string;
  training_job_id: string;
  version_name: string;
}

export interface RunInferenceInput {
  model_version_id: string;
  input_attachment_id: string;
  task_type: TaskType;
}

export interface InferenceFeedbackInput {
  run_id: string;
  dataset_id: string;
  reason: string;
}

export interface LlmConfig {
  enabled: boolean;
  provider: 'chatanywhere';
  base_url: string;
  api_key: string;
  model: string;
  temperature: number;
}

export interface LlmConfigView {
  enabled: boolean;
  provider: 'chatanywhere';
  base_url: string;
  model: string;
  temperature: number;
  has_api_key: boolean;
  api_key_masked: string;
}

export interface StartConversationInput {
  model_id: string;
  initial_message: string;
  attachment_ids: string[];
  llm_config?: LlmConfig | null;
}

export interface SendMessageInput {
  conversation_id: string;
  content: string;
  attachment_ids: string[];
  llm_config?: LlmConfig | null;
}

export interface SubmitApprovalInput {
  model_id: string;
  review_notes?: string;
  parameter_snapshot: Record<string, string>;
}
