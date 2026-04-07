export type SystemRole = 'user' | 'admin';
export type Capability = 'manage_models' | 'global_governance';
export type UserAccountStatus = 'active' | 'disabled';

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
export type ConversationActionType = 'create_dataset' | 'create_model_draft' | 'create_training_job';
export type ConversationActionStatus = 'requires_input' | 'completed' | 'failed' | 'cancelled';

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
export type AnnotationReviewReasonCode =
  | 'box_mismatch'
  | 'label_error'
  | 'text_error'
  | 'missing_object'
  | 'polygon_issue'
  | 'other';

export type TrainingJobStatus =
  | 'draft'
  | 'queued'
  | 'preparing'
  | 'running'
  | 'evaluating'
  | 'completed'
  | 'failed'
  | 'cancelled';
export type TrainingExecutionMode = 'simulated' | 'local_command' | 'unknown';
export type TrainingExecutionTarget = 'control_plane' | 'worker';
export type TrainingWorkerStatus = 'online' | 'offline' | 'draining';
export type TrainingWorkerAuthMode = 'shared' | 'dedicated';
export type TrainingWorkerBootstrapStatus =
  | 'bootstrap_created'
  | 'pairing'
  | 'validation_failed'
  | 'awaiting_confirmation'
  | 'online'
  | 'expired';
export type TrainingWorkerDeploymentMode = 'docker' | 'script';
export type TrainingWorkerProfile = 'yolo' | 'paddleocr' | 'doctr' | 'mixed';

export interface TrainingSchedulerDecision {
  policy: 'load_aware_v1';
  trigger: string;
  attempt: number;
  execution_target: TrainingExecutionTarget;
  selected_worker_id: string | null;
  selected_worker_score: number | null;
  selected_worker_load_component: number | null;
  selected_worker_health_penalty: number | null;
  selected_worker_capability_bonus: number | null;
  selected_worker_in_flight_jobs: number | null;
  selected_worker_max_concurrency: number | null;
  excluded_worker_ids: string[];
  fallback_reason: string | null;
  note: string;
  decided_at: string;
}

export type ModelVersionStatus = 'registered' | 'deprecated';
export type InferenceRunStatus = 'queued' | 'running' | 'completed' | 'failed';
export type RuntimeConnectivitySource = 'not_configured' | 'reachable' | 'unreachable';
export type RuntimeConnectivityErrorKind =
  | 'none'
  | 'timeout'
  | 'network'
  | 'http_status'
  | 'invalid_payload'
  | 'unknown';

export interface User {
  id: string;
  username: string;
  role: SystemRole;
  status: UserAccountStatus;
  status_reason: string | null;
  capabilities: Capability[];
  last_login_at: string | null;
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

export interface ConversationActionMetadata {
  action: ConversationActionType;
  status: ConversationActionStatus;
  summary: string;
  missing_fields: string[];
  collected_fields: Record<string, string>;
  suggestions?: string[];
  created_entity_type?: 'Dataset' | 'TrainingJob' | 'Model' | null;
  created_entity_id?: string | null;
  created_entity_label?: string | null;
}

export interface MessageMetadata {
  conversation_action?: ConversationActionMetadata | null;
}

export interface MessageRecord {
  id: string;
  conversation_id: string;
  sender: MessageSender;
  content: string;
  attachment_ids: string[];
  metadata?: MessageMetadata;
  created_at: string;
}

export interface FileAttachment {
  id: string;
  filename: string;
  status: FileAttachmentStatus;
  owner_user_id: string;
  attached_to_type: AttachmentTargetType;
  attached_to_id: string | null;
  mime_type: string | null;
  byte_size: number | null;
  storage_backend: 'local' | null;
  storage_path: string | null;
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

export type VerificationReportStatus = 'passed' | 'failed' | 'unknown';

export interface VerificationCheckRecord {
  name: string;
  status: string;
  detail: string;
}

export interface VerificationReportRecord {
  id: string;
  filename: string;
  status: VerificationReportStatus;
  summary: string;
  started_at_utc: string;
  finished_at_utc: string;
  target_base_url: string;
  business_username: string;
  probe_username: string;
  checks_total: number;
  checks_failed: number;
  checks: VerificationCheckRecord[];
  entities: Record<string, string>;
  runtime_metrics_retention?: RuntimeMetricsRetentionSummary | null;
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
  review_reason_code: AnnotationReviewReasonCode | null;
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
  execution_mode: TrainingExecutionMode;
  execution_target: TrainingExecutionTarget;
  scheduled_worker_id: string | null;
  scheduler_note: string | null;
  scheduler_decision: TrainingSchedulerDecision | null;
  scheduler_decision_history: TrainingSchedulerDecision[];
  log_excerpt: string;
  submitted_by: string;
  created_at: string;
  updated_at: string;
}

export interface TrainingWorkerNodeRecord {
  id: string;
  name: string;
  endpoint: string | null;
  status: TrainingWorkerStatus;
  enabled: boolean;
  max_concurrency: number;
  last_heartbeat_at: string | null;
  last_reported_load: number | null;
  capabilities: string[];
  auth_mode: TrainingWorkerAuthMode;
  auth_token_preview: string | null;
  registration_source: 'seed' | 'admin' | 'heartbeat';
  metadata: Record<string, string>;
  created_at: string;
  updated_at: string;
}

export interface TrainingWorkerNodeView extends TrainingWorkerNodeRecord {
  effective_status: TrainingWorkerStatus;
  heartbeat_stale: boolean;
  in_flight_jobs: number;
  load_score: number;
  scheduler_score: number;
  scheduler_load_component: number;
  scheduler_health_penalty: number;
  scheduler_capability_bonus: number;
  dispatch_recent_failures: number;
  dispatch_consecutive_failures: number;
  dispatch_last_failure_at: string | null;
  dispatch_last_success_at: string | null;
  dispatch_cooldown_active: boolean;
}

export interface TrainingWorkerBootstrapSessionRecord {
  id: string;
  status: TrainingWorkerBootstrapStatus;
  deployment_mode: TrainingWorkerDeploymentMode;
  worker_profile: TrainingWorkerProfile;
  pairing_token: string;
  token_preview: string;
  control_plane_base_url: string;
  worker_id: string;
  worker_name: string;
  worker_public_host: string | null;
  worker_bind_port: number;
  worker_endpoint_hint: string | null;
  worker_runtime_profile: string;
  capabilities: string[];
  max_concurrency: number;
  issued_auth_mode: TrainingWorkerAuthMode;
  issued_auth_token_preview: string | null;
  docker_command: string;
  script_command: string;
  setup_url_hint: string;
  claimed_at: string | null;
  last_seen_at: string | null;
  callback_checked_at: string | null;
  callback_validation_message: string | null;
  linked_worker_id: string | null;
  metadata: Record<string, string>;
  created_at: string;
  expires_at: string;
}

export interface TrainingMetricRecord {
  id: string;
  training_job_id: string;
  metric_name: string;
  metric_value: number;
  step: number;
  recorded_at: string;
}

export interface TrainingArtifactSummary {
  runner: string | null;
  mode: string | null;
  fallback_reason: string | null;
  training_performed: boolean | null;
  primary_model_path: string | null;
  generated_at: string | null;
  sampled_items: number | null;
  metrics_keys: string[];
}

export interface TrainingMetricsExport {
  job_id: string;
  exported_at: string;
  total_rows: number;
  latest_metrics: Record<string, number>;
  metrics_by_name: Record<
    string,
    Array<{
      step: number;
      value: number;
      recorded_at: string;
    }>
  >;
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
  execution_source: string;
  raw_output: Record<string, unknown>;
  normalized_output: UnifiedInferenceOutput;
  feedback_dataset_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface RuntimeConnectivityRecord {
  framework: ModelFramework;
  configured: boolean;
  reachable: boolean;
  endpoint: string | null;
  source: RuntimeConnectivitySource;
  error_kind: RuntimeConnectivityErrorKind;
  checked_at: string;
  message: string;
}

export interface RuntimeMetricsRetentionItem {
  training_job_id: string;
  rows: number;
}

export interface RuntimeMetricsRetentionSummary {
  max_points_per_job: number;
  max_total_rows: number;
  current_total_rows: number;
  visible_job_count: number;
  jobs_with_metrics: number;
  max_rows_single_job: number;
  near_total_cap: boolean;
  top_jobs: RuntimeMetricsRetentionItem[];
}

export interface RegisterInput {
  username: string;
  password: string;
}

export interface LoginInput {
  username: string;
  password: string;
}

export interface CreateUserInput {
  username: string;
  password: string;
  role: SystemRole;
}

export interface ChangePasswordInput {
  current_password: string;
  new_password: string;
}

export interface ResetUserPasswordInput {
  new_password: string;
}

export interface UpdateUserStatusInput {
  status: UserAccountStatus;
  reason?: string | null;
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
  dataset_version_id: string;
  base_model: string;
  config: Record<string, string>;
}

export interface CreateTrainingWorkerInput {
  name: string;
  endpoint?: string | null;
  status?: TrainingWorkerStatus;
  enabled?: boolean;
  max_concurrency?: number;
  capabilities?: string[];
  metadata?: Record<string, string>;
}

export interface UpdateTrainingWorkerInput {
  name?: string;
  endpoint?: string | null;
  status?: TrainingWorkerStatus;
  enabled?: boolean;
  max_concurrency?: number;
  capabilities?: string[];
  metadata?: Record<string, string>;
}

export interface CreateTrainingWorkerBootstrapSessionInput {
  deployment_mode: TrainingWorkerDeploymentMode;
  worker_profile: TrainingWorkerProfile;
  control_plane_base_url: string;
  worker_name?: string;
  worker_public_host?: string;
  worker_bind_port?: number;
  max_concurrency?: number;
}

export interface ClaimTrainingWorkerBootstrapSessionInput {
  pairing_token: string;
}

export interface ClaimTrainingWorkerBootstrapSessionResult {
  bootstrap_session: TrainingWorkerBootstrapSessionRecord;
  config_defaults: Record<string, string>;
}

export interface GetTrainingWorkerBootstrapSessionStatusInput {
  pairing_token: string;
}

export interface TrainingWorkerHeartbeatInput {
  worker_id?: string;
  name: string;
  endpoint?: string | null;
  status?: TrainingWorkerStatus;
  enabled?: boolean;
  max_concurrency?: number;
  reported_load?: number | null;
  capabilities?: string[];
  metadata?: Record<string, string>;
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
  review_reason_code?: AnnotationReviewReasonCode | null;
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

export interface RenameConversationInput {
  title: string;
}

export interface SubmitApprovalInput {
  model_id: string;
  review_notes?: string;
  parameter_snapshot: Record<string, string>;
}

export type RequirementAnnotationType =
  | 'ocr_text'
  | 'bbox'
  | 'rotated_bbox'
  | 'polygon'
  | 'classification';

export interface RequirementTaskDraft {
  task_type: TaskType;
  recommended_framework: ModelFramework;
  recommended_annotation_type: RequirementAnnotationType;
  annotation_type?: RequirementAnnotationType;
  label_hints: string[];
  dataset_suggestions: string[];
  evaluation_metric_suggestions: string[];
  rationale: string;
  source: 'rule' | 'llm';
}
