# Data Model

## 1. Overview
This document defines platform-level entities for Vistral's AI-native conversation and training workflows. Contracts in this file are the source of truth for schema and API payload design.

## 2. Access and Ownership Semantics
- System roles are only `user` and `admin`.
- `owner` is a resource relationship (`owner_user_id`), not a role enum.
- Public self-registration is disabled.
- Administrators provision accounts from authenticated settings/admin surfaces.
- Privileged actions combine role checks with ownership/capability checks.

## 3. Shared Enums

### 3.1 Task type
- `ocr`
- `detection`
- `classification`
- `segmentation`
- `obb` (optional)

### 3.2 Framework
- `paddleocr`
- `doctr`
- `yolo`

### 3.3 File status
- `uploading`
- `processing`
- `ready`
- `error`

### 3.4 Annotation status
- `unannotated`
- `in_progress`
- `annotated`
- `in_review`
- `approved`
- `rejected`

### 3.5 Training job status
- `draft`
- `queued`
- `preparing`
- `running`
- `evaluating`
- `completed`
- `failed`
- `cancelled`

## 4. Core Entities

### 4.1 User
Attributes:
- `id` (PK)
- `username` (unique)
- `password_hash` (scrypt+salt, server-side only, never returned to client)
- `role` (`user` | `admin`)
- `status` (`active` | `disabled`)
- `status_reason` (nullable string, required when `status=disabled`, cleared on reactivation)
- `capabilities` (JSON array)
- `last_login_at` (nullable timestamp)
- `created_at`, `updated_at`

Relationships:
- owns many `Model`
- owns many `Dataset`
- creates many `TrainingJob`

Credential rules:
- users can change their own password by providing `current_password` plus `new_password`
- administrators can create new accounts and assign role `user` or `admin`
- administrators can reset another user's password from the authenticated account directory
- administrators can disable or reactivate accounts
- disabling requires a non-empty administrator reason, persisted on `status_reason`
- disabled accounts cannot authenticate or continue protected actions until reactivated
- disabling an account immediately invalidates its existing authenticated sessions; reactivation does not restore those sessions
- reactivating an account clears `status_reason`
- the system blocks disabling the current admin session and the last active admin account
- default capability profile is role-based:
  - `user` => `manage_models`
  - `admin` => `manage_models`, `global_governance`

### 4.2 Model
Attributes:
- `id` (PK)
- `name`
- `description`
- `model_type`
- `owner_user_id` (FK User)
- `visibility` (`private` | `workspace` | `public`)
- `status` (`draft` | `pending_approval` | `approved` | `rejected` | `published` | `deprecated`)
- `metadata` (JSON)
- `created_at`, `updated_at`

Relationships:
- has many `ModelVersion`
- has many `ApprovalRequest`

### 4.3 Conversation
Attributes:
- `id` (PK)
- `model_id` (FK Model)
- `title`
- `status` (`active` | `completed` | `archived`)
- `created_by` (FK User)
- `created_at`, `updated_at`

Relationships:
- has many `Message`
- references many `FileAttachment` (via message/context)

### 4.4 Message
Attributes:
- `id` (PK)
- `conversation_id` (FK Conversation)
- `sender` (`user` | `assistant` | `system`)
- `content`
- `attachment_ids` (JSON array)
- `metadata` (JSON, optional)
- `created_at`

Conversation action metadata rules:
- assistant messages may include `metadata.conversation_action`
- supported action types: `create_dataset`, `create_model_draft`, `create_training_job`
- supported action statuses: `requires_input`, `completed`, `failed`, `cancelled`
- action metadata stores `missing_fields`, `collected_fields`, optional `suggestions`, and optional created-entity reference so UI can render a compact execution card in the chat timeline

### 4.5 FileAttachment
Attributes:
- `id` (PK)
- `filename`
- `status` (`uploading` | `processing` | `ready` | `error`)
- `owner_user_id` (FK User)
- `attached_to_type` (`Conversation` | `Model` | `Dataset` | `InferenceRun`)
- `attached_to_id` (nullable)
- `mime_type` (nullable, inferred from upload payload or extension)
- `byte_size` (nullable int)
- `storage_backend` (nullable, current implementation: `local`)
- `storage_path` (nullable absolute path on server)
- `upload_error` (nullable)
- `created_at`, `updated_at`

Rule:
- conversation attachments must stay recoverable in UI via current-draft chips, message history, or on-demand tray, and support delete actions.
- multipart uploaded binaries are persisted under configurable local storage root (`UPLOAD_STORAGE_ROOT`).
- inference input uploads use `attached_to_type=InferenceRun` with `attached_to_id=null` before an inference run consumes the attachment id.
- when inference feedback sends a sample back to a dataset, input attachment is cloned (or reused when already dataset-scoped) into dataset attachment scope so dataset item/file visibility remains complete in dataset context.

### 4.6 ApprovalRequest
Attributes:
- `id` (PK)
- `model_id` (FK Model)
- `requested_by` (FK User)
- `approved_by` (FK User, nullable)
- `status` (`pending` | `approved` | `rejected`)
- `review_notes` (nullable)
- `requested_at`, `reviewed_at`

### 4.7 Dataset
Attributes:
- `id` (PK)
- `name`
- `description`
- `task_type` (TaskType)
- `status` (`draft` | `ready` | `archived`)
- `owner_user_id` (FK User)
- `label_schema` (JSON: classes, aliases, color)
- `metadata` (JSON)
- `created_at`, `updated_at`

Relationships:
- has many `DatasetItem`
- has many `DatasetVersion`
- referenced by many `TrainingJob`

### 4.8 DatasetItem
Attributes:
- `id` (PK)
- `dataset_id` (FK Dataset)
- `attachment_id` (FK FileAttachment)
- `split` (`train` | `val` | `test` | `unassigned`)
- `status` (`uploading` | `processing` | `ready` | `error`)
- `metadata` (JSON)
- `created_at`, `updated_at`

Current runtime semantics:
- standard uploaded dataset files produce `DatasetItem` from dataset upload lifecycle.
- import-reference workflow may create metadata-only `DatasetItem` records through `POST /datasets/{id}/items`; these records still point to a `FileAttachment` but the attachment may not have local stored binary (`storage_path=null`) yet.
- item-level maintenance workflow can update `split`, `status`, and full `metadata` through `PATCH /datasets/{id}/items/{item_id}`.

Relationships:
- has many `Annotation`

### 4.9 Annotation
Attributes:
- `id` (PK)
- `dataset_item_id` (FK DatasetItem)
- `task_type` (TaskType)
- `source` (`manual` | `import` | `pre_annotation`)
- `status` (AnnotationStatus)
- `payload` (JSON normalized annotation payload)
- `annotated_by` (FK User)
- `created_at`, `updated_at`

### 4.10 AnnotationReview
Attributes:
- `id` (PK)
- `annotation_id` (FK Annotation)
- `reviewer_user_id` (FK User)
- `status` (`approved` | `rejected`)
- `review_reason_code` (`box_mismatch` | `label_error` | `text_error` | `missing_object` | `polygon_issue` | `other` | nullable)
- `quality_score` (nullable float)
- `review_comment` (nullable)
- `created_at`

Rules:
- `review_reason_code` is required when `status=rejected`
- approved reviews store `review_reason_code=null`
- latest review stays attached to annotation list/detail responses so rework UIs can keep previous review context visible

### 4.11 DatasetVersion
Attributes:
- `id` (PK)
- `dataset_id` (FK Dataset)
- `version_name`
- `split_summary` (JSON)
- `item_count`
- `annotation_coverage` (float)
- `created_by` (FK User)
- `created_at`

### 4.12 TrainingJob
Attributes:
- `id` (PK)
- `name`
- `task_type` (TaskType)
- `framework` (Framework)
- `status` (TrainingJobStatus)
- `dataset_id` (FK Dataset)
- `dataset_version_id` (FK DatasetVersion, nullable only for legacy compatibility; new jobs must persist the selected dataset version snapshot)
- `base_model`
- `config` (JSON)
- `execution_mode` (`simulated` | `local_command` | `unknown`)
- `execution_target` (`control_plane` | `worker`)
- `scheduled_worker_id` (nullable FK `TrainingWorkerNode`)
- `scheduler_note` (nullable string; scheduling decision and optional dispatch/fallback reason)
- `scheduler_decision` (nullable JSON snapshot; structured scheduler decision trace)
- `scheduler_decision_history` (JSON array; ordered scheduler decision timeline, latest snapshot included)
- `log_excerpt` (nullable)
- `submitted_by` (FK User)
- `created_at`, `updated_at`

Launch readiness rules:
- selected dataset must be `ready`
- selected dataset version must include at least one `train` item (`split_summary.train > 0`)
- selected dataset version must have positive annotation coverage (`annotation_coverage > 0`)

Relationships:
- has many `TrainingMetric`
- can produce one or more `ModelVersion`

Runtime notes (current implementation):
- each job gets a local workspace under `TRAINING_WORKDIR_ROOT/{job_id}`
- runtime writes `job-config.json`, `dataset-summary.json`, `train.log`, `metrics.json`, and artifact file
- runtime also materializes framework-ready training inputs under the job workspace before local command execution:
  - YOLO detection: `materialized-dataset/yolo/` with split image/label dirs and `dataset.yaml`
  - OCR baseline: `materialized-dataset/ocr/` with manifest entries pointing to ready image/text pairs
- `train.log` lines are exposed via training detail API
- app state snapshots are persisted to `APP_STATE_STORE_PATH` (default `.data/app-state.json`)
- after API restart, non-terminal jobs (`queued`, `preparing`, `running`, `evaluating`) are re-queued and resumed automatically
- local training defaults to bundled runner templates (`scripts/local-runners/*_train_runner.py`) and runs as `execution_mode=local_command` when runner invocation succeeds
- `<FRAMEWORK>_LOCAL_TRAIN_COMMAND` can override bundled runner command templates
- if bundled runner command invocation fails (for example missing python dependency), lifecycle falls back to `execution_mode=simulated` with explicit log reason
- when `VISTRAL_RUNNER_ENABLE_REAL=1`, bundled OCR local train runners may run dependency-backed OCR probe execution on materialized manifest samples (`mode=real_probe`) and otherwise stay in template mode with explicit `fallback_reason`
- `execution_mode` is explicitly persisted per training job (no longer inferred only from logs)
- training detail API also exposes parsed artifact runtime summary (mode/fallback/model path hints) for UI observability
- when `execution_target=worker` and worker endpoint is reachable, control plane can dispatch training to worker endpoint and ingest returned logs/metrics/artifact summary into existing job runtime records
- worker dispatch payload can include either:
  - inline dataset package (`inline_base64_v1`) bounded by inline size/file caps
  - reference package metadata (`reference_json_v1`) that points to control-plane package download endpoint with TTL
- worker reconstructs training inputs under its local workspace without relying on control-plane absolute paths
- if worker dispatch fails and fallback policy is enabled, runtime falls back to control-plane local execution and records reason in `scheduler_note` and logs
- before local fallback, runtime can reselect another eligible worker and retry dispatch; scheduler transitions/retry reasons are recorded in `scheduler_note` and logs
- worker re-dispatch uses bounded retry policy (`TRAINING_WORKER_DISPATCH_MAX_ATTEMPTS`, `TRAINING_WORKER_DISPATCH_RETRY_BASE_MS`) to avoid unbounded retry loops
- worker selection score also includes recent dispatch-failure penalty/cooldown (`TRAINING_WORKER_FAILURE_PENALTY_WINDOW_MS`, `TRAINING_WORKER_FAILURE_COOLDOWN_MS`, `TRAINING_WORKER_FAILURE_PENALTY_STEP`, `TRAINING_WORKER_FAILURE_PENALTY_CAP`) so unstable nodes are deprioritized
- when a worker-running job is cancelled, control plane should attempt worker-side cancellation and stop waiting on in-flight dispatch request
- scheduler decision trace is persisted on each scheduling transition (`create`, `resume`, `retry`, pre-run reschedule, dispatch failover/fallback) with fields:
  - `trigger` (transition source)
  - `attempt` (dispatch/scheduling attempt index)
  - `execution_target`
  - `selected_worker_id`
  - score components (`selected_worker_score`, `selected_worker_load_component`, `selected_worker_health_penalty`, `selected_worker_capability_bonus`)
  - capacity snapshot (`selected_worker_in_flight_jobs`, `selected_worker_max_concurrency`)
  - `excluded_worker_ids`
  - `fallback_reason`
  - `note`
  - `decided_at`
- `scheduler_decision` always reflects the latest entry in `scheduler_decision_history` for convenient reads/backward compatibility

### 4.13 TrainingWorkerNode
Attributes:
- `id` (PK)
- `name`
- `endpoint` (nullable URL; worker callback/dispatch endpoint)
- `status` (`online` | `offline` | `draining`)
- `enabled` (bool)
- `max_concurrency` (int > 0)
- `last_heartbeat_at` (nullable timestamp)
- `last_reported_load` (nullable float 0..1)
- `capabilities` (JSON: task/framework support tags)
- `auth_mode` (`shared` | `dedicated`) for exposed control-plane observability
- `auth_token_preview` (nullable masked token preview for operator confirmation; never the full secret)
- `registration_source` (`seed` | `admin` | `heartbeat`)
- `metadata` (JSON)
- `created_at`, `updated_at`

Rules:
- workers can be added/removed dynamically by admin or worker self-registration heartbeat
- control plane keeps worker auth secret server-side only; exposed records can include `auth_mode` and `auth_token_preview`, but never return the raw token
- scheduler prefers `online && enabled` workers and computes normalized load from:
  - worker-reported load (`last_reported_load`)
  - current in-flight jobs assigned to that worker
- when no eligible worker exists, scheduler falls back to control-plane local execution
- worker heartbeat is considered stale after TTL and stale workers are treated as offline for scheduling
- runtime worker list responses can include scheduler observability fields (computed, non-persistent):
  - score components (`scheduler_score`, `scheduler_load_component`, `scheduler_health_penalty`, `scheduler_capability_bonus`)
  - dispatch health snapshot (`dispatch_recent_failures`, `dispatch_consecutive_failures`, `dispatch_last_failure_at`, `dispatch_last_success_at`, `dispatch_cooldown_active`)

### 4.13A TrainingWorkerBootstrapSession
Ephemeral onboarding session used by admin-side `Add Worker` flow and worker-local GUI pairing.

Attributes:
- `id` (PK)
- `status` (`bootstrap_created` | `pairing` | `validation_failed` | `awaiting_confirmation` | `online` | `expired`)
- `deployment_mode` (`docker` | `script`)
- `worker_profile` (`yolo` | `paddleocr` | `doctr` | `mixed`)
- `pairing_token` (single-use or short-lived secret)
- `control_plane_base_url` (URL)
- `worker_id`
- `worker_name`
- `worker_public_host` (nullable hostname / IP / domain hint chosen by admin)
- `worker_bind_port` (int > 0, default `9090`)
- `worker_endpoint_hint` (nullable URL)
- `worker_runtime_profile`
- `capabilities` (JSON: framework/task tags)
- `max_concurrency` (int > 0)
- `issued_auth_mode` (`shared` | `dedicated`)
- `issued_auth_token_preview` (nullable masked preview)
- `claimed_at` (nullable timestamp)
- `last_seen_at` (nullable timestamp)
- `callback_checked_at` (nullable timestamp)
- `callback_validation_message` (nullable string)
- `linked_worker_id` (nullable FK `TrainingWorkerNode`)
- `metadata` (JSON)
- `created_at`
- `expires_at`

Rules:
- bootstrap sessions are operator-facing onboarding helpers, not normal schedulable workers
- bootstrap sessions stay short-lived and can expire without affecting already-online workers
- admin can optionally preconfigure `worker_public_host` + `worker_bind_port` so generated Docker/script startup commands and `/setup` URL hints already match the target machine topology
- worker-local pairing exchanges `pairing_token` for resolved worker config, including control-plane URL and the issued worker auth secret
- normal bootstrap-created workers should prefer per-worker dedicated auth; control-plane shared token remains as a backward-compatible fallback for legacy/manual workers
- once the claimed worker heartbeat is accepted, control plane should validate worker callback reachability before session advances to `online`
- callback validation failure should keep the linked worker out of scheduling eligibility until a later heartbeat or explicit retry passes
- current implementation persists bootstrap sessions into local app-state storage so restart does not lose active pairing context

### 4.14 TrainingMetric
Attributes:
- `id` (PK)
- `training_job_id` (FK TrainingJob)
- `metric_name` (for example `map`, `cer`, `wer`, `precision`, `recall`)
- `metric_value` (float)
- `step` (int)
- `recorded_at`

### 4.15 ModelVersion
Attributes:
- `id` (PK)
- `model_id` (FK Model)
- `training_job_id` (FK TrainingJob, nullable)
- `version_name`
- `task_type` (TaskType)
- `framework` (Framework)
- `status` (`registered` | `deprecated`)
- `metrics_summary` (JSON)
- `artifact_attachment_id` (FK FileAttachment, nullable)
- `created_by` (FK User)
- `created_at`

Runtime rule (current implementation):
- when a completed training job is registered, `artifact_attachment_id` is bound to the generated training artifact attachment (local file-backed).
- training artifact attachment is a manifest-style file by default; when a real framework export exists, the manifest records `primary_model_path` so inference can resolve the actual weight file for that version.

### 4.16 InferenceRun
Attributes:
- `id` (PK)
- `model_version_id` (FK ModelVersion)
- `input_attachment_id` (FK FileAttachment)
- `task_type` (TaskType)
- `framework` (Framework)
- `status` (`queued` | `running` | `completed` | `failed`)
- `execution_source` (for example `yolo_runtime`, `yolo_local_command`, `yolo_local`, `mock_fallback`)
- `raw_output` (JSON)
- `normalized_output` (JSON)
- `feedback_dataset_id` (FK Dataset, nullable)
- `created_by` (FK User)
- `created_at`, `updated_at`

Runtime rule (current implementation):
- `POST /inference/runs/{id}/feedback` binds `feedback_dataset_id` and guarantees a dataset item trace for the run in target dataset.
- target dataset `task_type` must equal inference run `task_type`; cross-task feedback is rejected.
- feedback item metadata stores `inference_run_id`, `feedback_reason`, and `source_attachment_id` for loop traceability.

## 5. State Transition Rules

### 5.1 Annotation
- `unannotated -> in_progress -> annotated -> in_review -> approved`
- rejection path: `in_review -> rejected -> in_progress`
- direct upsert editing is only valid while the current annotation is still editable (`unannotated`, `in_progress`, `annotated`)
- once an annotation enters `in_review`, only the dedicated review endpoint may move it to `approved` or `rejected`
- `approved` stays read-only in the upsert path

### 5.2 TrainingJob
- `draft -> queued -> preparing -> running -> evaluating -> completed`
- failure path: `running|evaluating -> failed`
- manual stop: `queued|preparing|running -> cancelled`

### 5.3 ModelVersion
- register path: training/evaluation completion creates `registered`
- lifecycle can move to `deprecated`

## 6. Unified Inference Output Storage
`InferenceRun.normalized_output` must support:
- image metadata
- `task_type`, `framework`
- model metadata
- `boxes`, `rotated_boxes`, `polygons`, `masks`, `labels`
- OCR lines/words/confidence
- full `raw_output`

`normalized_output.source` currently distinguishes:
- `<framework>_runtime` (external runtime endpoint result)
- `<framework>_local_command` (local predict command result via `<FRAMEWORK>_LOCAL_PREDICT_COMMAND`)
- `<framework>_local` (local deterministic inferencer result)
- `mock_fallback` (runtime endpoint configured but failed, fallback applied)

Inference rule (current implementation):
- when a model version has an artifact attachment with resolvable `primary_model_path`, local inference prefers that version-bound artifact path over global fallback env vars.

## 7. Indexes and Constraints (minimum)
- unique: `users.username`
- index: `models.owner_user_id, models.status`
- index: `datasets.owner_user_id, datasets.task_type`
- index: `dataset_items.dataset_id, dataset_items.split`
- index: `annotations.dataset_item_id, annotations.status`
- index: `training_jobs.dataset_id, training_jobs.status`
- index: `training_metrics.training_job_id, training_metrics.metric_name`
- index: `model_versions.model_id, model_versions.created_at`
- index: `inference_runs.model_version_id, inference_runs.created_at`

## 8. Security and Audit Notes
- sensitive operations (approval, role-sensitive actions, training state transitions) must create audit logs
- file and inference artifacts should remain traceable to user + resource ownership
- key material remains outside plain-text source control
