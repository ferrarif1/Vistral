-- Round 1+ schema baseline for mock-closed prototype

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'admin')),
  capabilities TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE models (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  model_type TEXT NOT NULL CHECK (model_type IN ('ocr', 'detection', 'classification', 'segmentation', 'obb')),
  owner_user_id TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('private', 'workspace', 'public')),
  status TEXT NOT NULL CHECK (
    status IN ('draft', 'pending_approval', 'approved', 'rejected', 'published', 'deprecated')
  ),
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (owner_user_id) REFERENCES users (id)
);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'archived')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (model_id) REFERENCES models (id),
  FOREIGN KEY (created_by) REFERENCES users (id)
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  sender TEXT NOT NULL CHECK (sender IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  attachment_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations (id)
);

CREATE TABLE file_attachments (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('uploading', 'processing', 'ready', 'error')),
  owner_user_id TEXT NOT NULL,
  attached_to_type TEXT NOT NULL CHECK (attached_to_type IN ('Conversation', 'Model', 'Dataset', 'InferenceRun')),
  attached_to_id TEXT,
  mime_type TEXT,
  byte_size INTEGER,
  storage_backend TEXT CHECK (storage_backend IN ('local')),
  storage_path TEXT,
  upload_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (owner_user_id) REFERENCES users (id)
);

CREATE TABLE approval_requests (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  approved_by TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  review_notes TEXT,
  requested_at TEXT NOT NULL,
  reviewed_at TEXT,
  FOREIGN KEY (model_id) REFERENCES models (id),
  FOREIGN KEY (requested_by) REFERENCES users (id),
  FOREIGN KEY (approved_by) REFERENCES users (id)
);

CREATE TABLE datasets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  task_type TEXT NOT NULL CHECK (task_type IN ('ocr', 'detection', 'classification', 'segmentation', 'obb')),
  status TEXT NOT NULL CHECK (status IN ('draft', 'ready', 'archived')),
  owner_user_id TEXT NOT NULL,
  label_schema TEXT NOT NULL DEFAULT '{"classes":[]}',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (owner_user_id) REFERENCES users (id)
);

CREATE TABLE dataset_items (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL,
  attachment_id TEXT NOT NULL,
  split TEXT NOT NULL CHECK (split IN ('train', 'val', 'test', 'unassigned')),
  status TEXT NOT NULL CHECK (status IN ('uploading', 'processing', 'ready', 'error')),
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (dataset_id) REFERENCES datasets (id),
  FOREIGN KEY (attachment_id) REFERENCES file_attachments (id)
);

CREATE TABLE annotations (
  id TEXT PRIMARY KEY,
  dataset_item_id TEXT NOT NULL,
  task_type TEXT NOT NULL CHECK (task_type IN ('ocr', 'detection', 'classification', 'segmentation', 'obb')),
  source TEXT NOT NULL CHECK (source IN ('manual', 'import', 'pre_annotation')),
  status TEXT NOT NULL CHECK (
    status IN ('unannotated', 'in_progress', 'annotated', 'in_review', 'approved', 'rejected')
  ),
  payload TEXT NOT NULL DEFAULT '{}',
  annotated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (dataset_item_id) REFERENCES dataset_items (id),
  FOREIGN KEY (annotated_by) REFERENCES users (id)
);

CREATE TABLE annotation_reviews (
  id TEXT PRIMARY KEY,
  annotation_id TEXT NOT NULL,
  reviewer_user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('approved', 'rejected')),
  quality_score REAL,
  review_comment TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (annotation_id) REFERENCES annotations (id),
  FOREIGN KEY (reviewer_user_id) REFERENCES users (id)
);

CREATE TABLE dataset_versions (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL,
  version_name TEXT NOT NULL,
  split_summary TEXT NOT NULL DEFAULT '{"train":0,"val":0,"test":0,"unassigned":0}',
  item_count INTEGER NOT NULL DEFAULT 0,
  annotation_coverage REAL NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (dataset_id) REFERENCES datasets (id),
  FOREIGN KEY (created_by) REFERENCES users (id)
);

CREATE TABLE training_jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  task_type TEXT NOT NULL CHECK (task_type IN ('ocr', 'detection', 'classification', 'segmentation', 'obb')),
  framework TEXT NOT NULL CHECK (framework IN ('paddleocr', 'doctr', 'yolo')),
  status TEXT NOT NULL CHECK (
    status IN ('draft', 'queued', 'preparing', 'running', 'evaluating', 'completed', 'failed', 'cancelled')
  ),
  dataset_id TEXT NOT NULL,
  dataset_version_id TEXT,
  base_model TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  execution_mode TEXT NOT NULL DEFAULT 'unknown' CHECK (execution_mode IN ('simulated', 'local_command', 'unknown')),
  log_excerpt TEXT NOT NULL DEFAULT '',
  submitted_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (dataset_id) REFERENCES datasets (id),
  FOREIGN KEY (dataset_version_id) REFERENCES dataset_versions (id),
  FOREIGN KEY (submitted_by) REFERENCES users (id)
);

CREATE TABLE training_metrics (
  id TEXT PRIMARY KEY,
  training_job_id TEXT NOT NULL,
  metric_name TEXT NOT NULL,
  metric_value REAL NOT NULL,
  step INTEGER NOT NULL,
  recorded_at TEXT NOT NULL,
  FOREIGN KEY (training_job_id) REFERENCES training_jobs (id)
);

CREATE TABLE model_versions (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL,
  training_job_id TEXT,
  version_name TEXT NOT NULL,
  task_type TEXT NOT NULL CHECK (task_type IN ('ocr', 'detection', 'classification', 'segmentation', 'obb')),
  framework TEXT NOT NULL CHECK (framework IN ('paddleocr', 'doctr', 'yolo')),
  status TEXT NOT NULL CHECK (status IN ('registered', 'deprecated')),
  metrics_summary TEXT NOT NULL DEFAULT '{}',
  artifact_attachment_id TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (model_id) REFERENCES models (id),
  FOREIGN KEY (training_job_id) REFERENCES training_jobs (id),
  FOREIGN KEY (artifact_attachment_id) REFERENCES file_attachments (id),
  FOREIGN KEY (created_by) REFERENCES users (id)
);

CREATE TABLE inference_runs (
  id TEXT PRIMARY KEY,
  model_version_id TEXT NOT NULL,
  input_attachment_id TEXT NOT NULL,
  task_type TEXT NOT NULL CHECK (task_type IN ('ocr', 'detection', 'classification', 'segmentation', 'obb')),
  framework TEXT NOT NULL CHECK (framework IN ('paddleocr', 'doctr', 'yolo')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  execution_source TEXT NOT NULL DEFAULT 'unknown',
  raw_output TEXT NOT NULL DEFAULT '{}',
  normalized_output TEXT NOT NULL DEFAULT '{}',
  feedback_dataset_id TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (model_version_id) REFERENCES model_versions (id),
  FOREIGN KEY (input_attachment_id) REFERENCES file_attachments (id),
  FOREIGN KEY (feedback_dataset_id) REFERENCES datasets (id),
  FOREIGN KEY (created_by) REFERENCES users (id)
);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  timestamp TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id)
);

CREATE INDEX idx_models_owner_status ON models (owner_user_id, status);
CREATE INDEX idx_conversations_model_status ON conversations (model_id, status);
CREATE INDEX idx_messages_conversation_created ON messages (conversation_id, created_at);
CREATE INDEX idx_file_attachments_target ON file_attachments (attached_to_type, attached_to_id);
CREATE INDEX idx_approval_requests_status_requested_at ON approval_requests (status, requested_at);
CREATE INDEX idx_datasets_owner_task ON datasets (owner_user_id, task_type);
CREATE INDEX idx_dataset_items_dataset_split ON dataset_items (dataset_id, split);
CREATE INDEX idx_annotations_item_status ON annotations (dataset_item_id, status);
CREATE INDEX idx_training_jobs_dataset_status ON training_jobs (dataset_id, status);
CREATE INDEX idx_training_metrics_job_metric ON training_metrics (training_job_id, metric_name);
CREATE INDEX idx_model_versions_model_created ON model_versions (model_id, created_at);
CREATE INDEX idx_inference_runs_version_created ON inference_runs (model_version_id, created_at);
CREATE INDEX idx_audit_logs_timestamp ON audit_logs (timestamp);
CREATE INDEX idx_audit_logs_user_timestamp ON audit_logs (user_id, timestamp);
